// 智能体人设第三轨（PERSONA.md）注入测试（issue #74）。
//
// 钉四条结构断言：① 顺序 protocol → persona → user → memory；② persona 缺失/空白时该块
// 静默退场、其余块不受影响；③ `inject.persona=false` 只关人设、USER.md 照注入（总开关
// enabled=false 仍全不注入）；④ 人设超 200 行被截断且提示只落在人设块内。外加读盘层
// （PERSONA.md 存在/缺失）与 `scripts/sync-persona.ts` 幂等。
//
// 语义层（开/关人设的事实结论一致）单元测试测不了，按设计文档「非目标」走人工验收，不写假断言。
//
// 隔离：homedir 指向本文件自己的临时目录（规则 14：每文件独立 tmp home）；
// 同步脚本用子进程跑，显式传目标路径，绝不碰真实 ~/.opencode/PERSONA.md。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_HOME = vi.hoisted(() => `/tmp/opencode-memx-persona-test-home-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

import {
  buildInjectionParts,
  INJECTION_SOURCE_ORDER,
  INJECT_MAX_LINES,
} from "../src/core/injection.ts";
import {
  readInjectionSourcesForSlug,
  InjectionSourceCache,
  getPersonaPath,
  PERSONA_FILE_NAME,
} from "../src/core/pipeline/injection-source.ts";
import { applyContextHook } from "../src/hosts/opencode/context-hook.ts";
import type { ContextHookEvent, ContextHookDeps } from "../src/hosts/opencode/context-hook.ts";
import { loadMemxConfig, getConfigPath } from "../src/core/config.ts";

const DIR = join(TEST_HOME, ".opencode");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PERSONA_SOURCE = join(REPO_ROOT, "personas", "whale-girl.md");

const PROTOCOL = "# memx signal protocol\n\nemit signals";
const PERSONA = "# 智能体人设：鲸鱼娘\n\n语气：先给结论再展开。";
const USER = "# User Profile & Style\n\n- [2026-10-12] 先给结论";
const MEMORY_INDEX = [
  `## proj-x`,
  `- [卡A](${join(DIR, "projects", "proj-x", ".mem", "a.md")}) - 本项目钩子`,
  ``,
].join("\n");

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** 再写一次四份源文件（各用例独立，避免互相污染）。 */
function writeAllSources(): void {
  writeFileSync(join(DIR, "memx-protocol.md"), PROTOCOL, "utf-8");
  writeFileSync(getPersonaPath(), PERSONA, "utf-8");
  writeFileSync(join(DIR, "USER.md"), USER, "utf-8");
  writeFileSync(join(DIR, "MEMORY.md"), MEMORY_INDEX, "utf-8");
}

describe("① 顺序：protocol → persona → user → memory", () => {
  it("装配结果按固定顺序各出一个 part，facts 的 id 顺序一致", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL, persona: PERSONA, user: USER, memory: MEMORY_INDEX });
    expect(built.parts.map((p) => p.text)).toEqual([PROTOCOL, PERSONA, USER, MEMORY_INDEX]);
    expect(built.facts.map((f) => f.id)).toEqual(["protocol", "persona", "user", "memory"]);
  });

  it("读盘 → 装配整条管道也保持同一顺序（不是只测常量数组）", () => {
    writeAllSources();
    const sources = readInjectionSourcesForSlug(new InjectionSourceCache(), "proj-x", "/work/proj-x");
    expect(sources.persona).toBe(PERSONA);
    const built = buildInjectionParts(sources);
    expect(built.facts.map((f) => f.id)).toEqual(["protocol", "persona", "user", "memory"]);
    expect(built.parts[1]!.text).toBe(PERSONA);
    expect(INJECTION_SOURCE_ORDER).toEqual(["protocol", "persona", "user", "memory"]);
  });
});

describe("② persona 缺失 / 空白 → 该块不出现，其余块不受影响", () => {
  it("null / 空串 / 纯空白 → 只出 protocol、user、memory 三块，顺序与内容不变", () => {
    for (const persona of [null, "", "   \n\n "]) {
      const built = buildInjectionParts({ protocol: PROTOCOL, persona, user: USER, memory: MEMORY_INDEX });
      expect(built.parts.map((p) => p.text)).toEqual([PROTOCOL, USER, MEMORY_INDEX]);
      expect(built.facts.map((f) => f.id)).toEqual(["protocol", "user", "memory"]);
      expect(built.truncations).toBe(0);
    }
  });

  it("persona 字段整个缺省（undefined）→ 同样静默跳过", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL, user: USER, memory: MEMORY_INDEX });
    expect(built.parts).toHaveLength(3);
  });

  it("PERSONA.md 不存在 → 读盘返回 null、不抛（没装人设是常态，不是故障）", () => {
    rmSync(getPersonaPath(), { force: true });
    const sources = readInjectionSourcesForSlug(new InjectionSourceCache(), "proj-x", "/work/proj-x");
    expect(sources.persona).toBeNull();
    expect(sources.protocol).toBe(PROTOCOL);
  });

  it("PERSONA.md 存在 → 读到正文，且与其余三块共用同一个 stat 缓存", () => {
    writeAllSources();
    const cache = new InjectionSourceCache();
    const sources = readInjectionSourcesForSlug(cache, "proj-x", "/work/proj-x");
    expect(sources.persona).toBe(PERSONA);
    expect(PERSONA_FILE_NAME).toBe("PERSONA.md");
    expect(getPersonaPath()).toBe(join(DIR, "PERSONA.md"));
    expect(cache.wasCached(getPersonaPath())).toBe(true);
  });
});

describe("③ inject.persona=false → 不注入人设，USER.md 照注入", () => {
  const HOST = [{ type: "text" as const, text: "AGENT_SYSTEM_PROMPT" }];
  const event = (): ContextHookEvent => ({
    sessionID: "ses_user",
    agent: "build",
    system: [...HOST],
    options: {},
  });
  const depsFor = (over: Partial<ContextHookDeps> = {}): ContextHookDeps => ({
    childSessions: new Map(),
    gate: { enabled: true, includeAgents: "all", excludeAgents: [], persona: true },
    readSources: () => ({ protocol: PROTOCOL, persona: PERSONA, user: USER, memory: MEMORY_INDEX }),
    ...over,
  });
  const writeConfig = (cfg: unknown): void => writeFileSync(getConfigPath(), JSON.stringify(cfg), "utf-8");

  it("配置 inject.persona=false → 闸门读出 persona=false，人设块被掐掉、协议/画像/索引照注入", async () => {
    writeConfig({ inject: { persona: false } });
    const config = await loadMemxConfig();
    expect(config.inject.persona).toBe(false);

    const e = event();
    const outcome = applyContextHook(e, depsFor({ gate: config.inject }));
    expect(outcome.kind).toBe("injected");
    expect(e.system.map((p) => p.text)).toEqual(["AGENT_SYSTEM_PROMPT", PROTOCOL, USER, MEMORY_INDEX]);
    expect(e.system.some((p) => p.text === PERSONA)).toBe(false);
    if (outcome.kind !== "injected") throw new Error("unreachable");
    expect(outcome.facts.map((f) => f.id)).toEqual(["protocol", "user", "memory"]);
  });

  it("persona 缺省（默认 true）→ 人设块在 protocol 之后注入", async () => {
    writeConfig({ inject: {} });
    const config = await loadMemxConfig();
    expect(config.inject.persona).toBe(true);

    const e = event();
    applyContextHook(e, depsFor({ gate: config.inject }));
    expect(e.system.map((p) => p.text)).toEqual(["AGENT_SYSTEM_PROMPT", PROTOCOL, PERSONA, USER, MEMORY_INDEX]);
  });

  it("总开关 inject.enabled=false → 一个字节都不注入（persona=true 也救不回来）", async () => {
    writeConfig({ inject: { enabled: false, persona: true } });
    const config = await loadMemxConfig();

    const e = event();
    const outcome = applyContextHook(e, depsFor({ gate: config.inject }));
    expect(outcome).toEqual({ kind: "gated" });
    expect(e.system).toHaveLength(1);
  });
});

describe("④ 人设超 200 行 → 截断，且提示只出现在人设块内", () => {
  it("人设 250 行：persona 块截到 200 行 + 提示行，其余三块一个字节都没动", () => {
    const longPersona = Array.from({ length: 250 }, (_, i) => `人设第 ${i + 1} 行`).join("\n");
    const built = buildInjectionParts({
      protocol: PROTOCOL,
      persona: longPersona,
      user: USER,
      memory: MEMORY_INDEX,
    });

    const personaFact = built.facts.find((f) => f.id === "persona")!;
    expect(personaFact.truncated).toBe(true);
    expect(personaFact.cappedBy).toBe("lines");
    expect(personaFact.totalLines).toBe(250);
    expect(personaFact.lines).toBe(INJECT_MAX_LINES + 1); // 200 行正文 + 1 行截断提示
    expect(built.truncations).toBe(1);

    const personaPart = built.parts[1]!;
    expect(personaPart.text).toContain("[memx: truncated");
    expect(personaPart.text).toContain(`first ${INJECT_MAX_LINES} of 250 lines`);
    const withNotice = built.parts.filter((p) => p.text.includes("[memx: truncated"));
    expect(withNotice).toHaveLength(1);
    expect(withNotice[0]).toBe(personaPart);

    // 其余块不受影响：仍是原文
    expect(built.parts[0]!.text).toBe(PROTOCOL);
    expect(built.parts[2]!.text).toBe(USER);
    expect(built.parts[3]!.text).toBe(MEMORY_INDEX);
  });
});

describe("读盘层：getPersonaPath / PERSONA_FILE_NAME", () => {
  it("固定落在 ~/.opencode/PERSONA.md（全局一份，不按项目分，文件名不作配置项）", () => {
    expect(getPersonaPath()).toBe(join(DIR, "PERSONA.md"));
    expect(PERSONA_FILE_NAME).toBe("PERSONA.md");
  });
});

describe("scripts/sync-persona.ts 幂等", () => {
  const target = join(TEST_HOME, ".opencode", "PERSONA.md");
  const script = fileURLToPath(new URL("../scripts/sync-persona.ts", import.meta.url));
  const run = () =>
    spawnSync(process.execPath, ["--experimental-strip-types", script, target], {
      encoding: "utf8",
      timeout: 60_000,
    });

  it("连跑两次：第一次「已写入」，第二次「无变化」，内容与真源逐字节一致", () => {
    rmSync(target, { force: true });

    const first = run();
    expect(first.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("已写入");
    expect(readFileSync(target, "utf8")).toBe(readFileSync(PERSONA_SOURCE, "utf8"));

    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("无变化");
    expect(readFileSync(target, "utf8")).toBe(readFileSync(PERSONA_SOURCE, "utf8"));
  });
});
