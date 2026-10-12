// 协议文本 ↔ Zod schema 的双向防漂移测试。
// 协议正文是注入到每个 session system prompt 的指令——它一旦与 schema 不一致，信号会被
// 静默丢弃（safeParse 失败即无声无息），且没有任何地方会报错。这里把模板里写下的示例
// 注释当成"模型会抄的样板"来校验：示例必须真能被 schema 接受、真能被 capture 解析出来，
// 并且文本里列出的枚举清单必须与 schema 的 const 数组完全一致（任一方向漂移都红）。
import { describe, it, expect } from "vitest";

import {
  PROTOCOL_TEMPLATE,
  PROTOCOL_VERSION,
  PROTOCOL_FILE_NAME,
  PROTOCOL_INSTRUCTION,
} from "../src/core/protocol-template";
import { StyleSignalSchema, CATEGORIES, CONFIDENCES, SOURCES } from "../src/core/types";
import { MemorySignalSchema, MEMORY_TYPES, MEMORY_SOURCES } from "../src/core/memory-types";
import { captureSignals } from "../src/core/signals/signal-capture";
import { captureMemorySignals } from "../src/core/signals/memory-capture";

/** 抽出模板里所有某一类信号注释的 JSON 原文。 */
function extractJson(text: string, kind: "STYLE_SIGNAL" | "MEMORY_SIGNAL"): string[] {
  const re = new RegExp(`<!--\\s*${kind}:\\s*(\\{.+?\\})\\s*-->`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

describe("protocol template — 示例注释必须能通过 schema", () => {
  it("模板里的 STYLE_SIGNAL 示例能通过 StyleSignalSchema", () => {
    const examples = extractJson(PROTOCOL_TEMPLATE, "STYLE_SIGNAL");
    expect(examples.length).toBeGreaterThan(0);
    for (const raw of examples) {
      const parsed = StyleSignalSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(`示例过不了 schema: ${JSON.stringify(parsed.error.issues)}`);
      expect(parsed.success).toBe(true);
    }
  });

  it("模板里的 MEMORY_SIGNAL 示例能通过 MemorySignalSchema", () => {
    const examples = extractJson(PROTOCOL_TEMPLATE, "MEMORY_SIGNAL");
    expect(examples.length).toBeGreaterThan(0);
    for (const raw of examples) {
      const parsed = MemorySignalSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(`示例过不了 schema: ${JSON.stringify(parsed.error.issues)}`);
      expect(parsed.success).toBe(true);
    }
  });

  it("模板示例能被真实 capture 解析出来（正向闭环）", () => {
    expect(captureSignals("u", PROTOCOL_TEMPLATE)).toHaveLength(1);
    expect(captureMemorySignals(PROTOCOL_TEMPLATE)).toHaveLength(1);
  });
});

describe("protocol template — 枚举清单不得与 schema 漂移", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["category", CATEGORIES],
    ["source", SOURCES],
    ["confidence", CONFIDENCES],
    ["type", MEMORY_TYPES],
  ];

  for (const [field, values] of cases) {
    it(`\`${field}\` 的清单等于 ${values.join("|")}`, () => {
      expect(PROTOCOL_TEMPLATE).toContain(`\`${field}\` (required) — one of: ${values.join(" | ")}`);
    });
  }

  it("MEMORY_SIGNAL 的 source 清单等于 MEMORY_SOURCES（不是 SOURCES）", () => {
    expect(PROTOCOL_TEMPLATE).toContain(`\`source\` (required) — one of: ${MEMORY_SOURCES.join(" | ")}`);
    // 两条轨的 source 取值不同（style 有 format_feedback、memory 没有），文本必须分别写
    expect(SOURCES).not.toEqual(MEMORY_SOURCES);
  });

  it("confidence 清单在三处都出现且与 CONFIDENCES 一致", () => {
    const expected = `one of: ${CONFIDENCES.join(" | ")}`;
    const hits = PROTOCOL_TEMPLATE.split(expected).length - 1;
    expect(hits).toBe(2); // Track 1 与 Track 2 各一次
  });
});

describe("protocol template — 协议里的硬约束是真的（防止写出做不到的指令）", () => {
  it("规则 2「必须单行」属实：跨行的 STYLE_SIGNAL 捕不到任何信号", () => {
    const multiLine = '回复\n<!-- STYLE_SIGNAL:\n{"category":"communication"}\n-->';
    expect(captureSignals("u", multiLine)).toHaveLength(0);
    // 同理 MEMORY_SIGNAL
    expect(captureMemorySignals('回复\n<!-- MEMORY_SIGNAL:\n{"type":"user"}\n-->')).toHaveLength(0);
  });

  it("规则 8「超长即丢弃」属实：content 超 100 字会被 schema 拒绝", () => {
    const tooLong = `<!-- STYLE_SIGNAL: ${JSON.stringify({
      category: "communication",
      content: "x".repeat(101),
      evidence: "ok",
      confidence: "high",
      source: "explicit",
    })} -->`;
    expect(captureSignals("u", tooLong)).toHaveLength(0);
    expect(captureSignals("u", tooLong.replace("x".repeat(101), "x".repeat(100)))).toHaveLength(1);
  });
});

describe("protocol template — 产物路径与版本", () => {
  it("instructions 条目与文件名一致", () => {
    expect(PROTOCOL_FILE_NAME).toBe("memx-protocol.md");
    expect(PROTOCOL_INSTRUCTION).toBe("~/.opencode/memx-protocol.md");
  });

  it("带版本标记（install.sh 靠它判断是否需要刷新）", () => {
    expect(PROTOCOL_TEMPLATE).toContain(`<!-- memx:version ${PROTOCOL_VERSION} -->`);
    expect(PROTOCOL_TEMPLATE).toContain("do not edit by hand");
  });

  it("声明自己是机器读的、不得作为可见文本复述", () => {
    expect(PROTOCOL_TEMPLATE).toContain("machine-read, never user-facing");
    expect(PROTOCOL_TEMPLATE).toMatch(/empty or fenced-only reply is a failure/);
  });
});