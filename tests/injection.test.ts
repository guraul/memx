// 注入装配的纯函数单测（core/injection.ts）：三块来源的取舍、上限与截断提示、agent 闸门。
//
// 这层是"信号到底有没有到模型眼前"的唯一装配逻辑，它坏掉的症状是**静默**的——协议没注入，
// 模型就永远不会发信号，而诊断里一切正常。故这里把边界（200 行 / 25KB / 恰好触顶）钉死。
import { describe, it, expect } from "vitest";
import {
  buildInjectionParts,
  capSourceText,
  shouldInjectAgent,
  describeGate,
  sliceToBytes,
  truncationNotice,
  DEFAULT_INJECT_LIMITS,
  INJECT_MAX_LINES,
  INJECT_MAX_BYTES,
} from "../src/core/injection.ts";

const PROTOCOL = "# memx signal protocol\n\nemit signals";
const USER = "# User Profile & Style\n\n- [2026-10-12] 先给结论";
const MEMORY = "# Project Memory\n\n- [proj](proj.md) - 项目记忆索引";

describe("buildInjectionParts — 三块来源的取舍", () => {
  it("全在：按 协议 → 画像 → 索引 顺序各出一个 part", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL, user: USER, memory: MEMORY });
    expect(built.parts).toHaveLength(3);
    expect(built.parts.map((p) => p.text)).toEqual([PROTOCOL, USER, MEMORY]);
    expect(built.facts.map((f) => f.id)).toEqual(["protocol", "user", "memory"]);
    expect(built.truncations).toBe(0);
  });

  it("每个 part 都是 {type:'text', text} —— 与宿主 SystemPart 结构兼容", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL });
    for (const part of built.parts) {
      expect(part.type).toBe("text");
      expect(typeof part.text).toBe("string");
    }
  });

  it("部分缺失：缺的静默跳过，不塞占位符、不产生空 part", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL, user: USER, memory: null });
    expect(built.parts).toHaveLength(2);
    expect(built.parts.map((p) => p.text)).toEqual([PROTOCOL, USER]);
    expect(built.facts.map((f) => f.id)).toEqual(["protocol", "user"]);
  });

  it("全缺（含 undefined / 空串 / 纯空白）→ 一个 part 都不出（hook 什么都不做）", () => {
    for (const sources of [
      {},
      { protocol: undefined, user: undefined, memory: undefined },
      { protocol: null, user: null, memory: null },
      { protocol: "", user: "   \n\n ", memory: "" },
    ]) {
      const built = buildInjectionParts(sources);
      expect(built.parts).toEqual([]);
      expect(built.facts).toEqual([]);
      expect(built.totalBytes).toBe(0);
      expect(built.truncations).toBe(0);
    }
  });

  it("只缺中间那块也不改变顺序（protocol 仍排第一）", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL, memory: MEMORY });
    expect(built.parts.map((p) => p.text)).toEqual([PROTOCOL, MEMORY]);
  });

  it("totalBytes 是三块注入字节之和（诊断口径）", () => {
    const built = buildInjectionParts({ protocol: PROTOCOL, user: USER, memory: MEMORY });
    const sum = built.facts.reduce((n, f) => n + f.bytes, 0);
    expect(built.totalBytes).toBe(sum);
    expect(built.totalBytes).toBe(
      Buffer.byteLength(PROTOCOL) + Buffer.byteLength(USER) + Buffer.byteLength(MEMORY),
    );
  });
});

describe("buildInjectionParts — 上限与可见截断", () => {
  const line = (n: number) => `line ${n}`;

  it("恰好 200 行 = 不触发截断（边界闭合，不多不少）", () => {
    const content = Array.from({ length: INJECT_MAX_LINES }, (_, i) => line(i)).join("\n");
    const built = buildInjectionParts({ user: content });
    expect(built.facts[0]!.truncated).toBe(false);
    expect(built.facts[0]!.cappedBy).toBe("none");
    expect(built.parts[0]!.text).toBe(content);
    expect(built.truncations).toBe(0);
  });

  it("201 行 → 截断到 200 行 + 追加可见提示行，且提示里有 before/after 数字", () => {
    const content = Array.from({ length: 201 }, (_, i) => line(i)).join("\n");
    const built = buildInjectionParts({ user: content });
    const text = built.parts[0]!.text;
    expect(text).toContain("[memx: truncated");
    expect(text).toContain("showing first 200 of 201 lines");
    expect(text).toContain("200-line cap");
    expect(built.facts[0]!.truncated).toBe(true);
    expect(built.facts[0]!.cappedBy).toBe("lines");
    expect(built.truncations).toBe(1);
    // 第 201 行确实被丢了，第 200 行还在
    expect(text).toContain(line(199));
    expect(text).not.toContain(line(200));
  });

  it("fact 里 truncated / totalLines / totalBytes 记录的是截断**前**的规模", () => {
    const content = Array.from({ length: 500 }, (_, i) => line(i)).join("\n");
    const fact = buildInjectionParts({ memory: content }).facts[0]!;
    expect(fact.totalLines).toBe(500);
    expect(fact.totalBytes).toBe(Buffer.byteLength(content));
    expect(fact.lines).toBeLessThan(500);
  });

  it("超 25KB 字节上限 → 报 bytes 触顶（哪怕行数没超）", () => {
    // 每行 100 字符，300 行 = 30KB，行数 300 > 200 会先触顶——所以这里用「行数少但每行巨大」
    const fat = "x".repeat(30_000);
    const built = buildInjectionParts({ user: fat });
    expect(built.facts[0]!.cappedBy).toBe("bytes");
    expect(built.facts[0]!.truncated).toBe(true);
    expect(built.parts[0]!.text).toContain("byte cap");
    expect(Buffer.byteLength(built.parts[0]!.text)).toBeLessThanOrEqual(INJECT_MAX_BYTES + 200);
  });

  it("两维都超 → 先触顶的那一维（lines）被记录", () => {
    const content = Array.from({ length: 400 }, () => "y".repeat(200)).join("\n");
    const built = buildInjectionParts({ user: content });
    expect(built.facts[0]!.cappedBy).toBe("lines");
    expect(built.parts[0]!.text).toContain("200-line cap");
  });

  it("提示行本身也计入注入的字节/行数（模型看到的就是这么多）", () => {
    const content = Array.from({ length: 300 }, (_, i) => line(i)).join("\n");
    const built = buildInjectionParts({ user: content });
    const text = built.parts[0]!.text;
    expect(built.facts[0]!.bytes).toBe(Buffer.byteLength(text));
    expect(built.facts[0]!.lines).toBe(text.split("\n").length);
  });

  it("截断永远可见：任何 truncated=true 的 part 都必须含提示行", () => {
    const cases = [
      { user: Array.from({ length: 999 }, (_, i) => line(i)).join("\n") },
      { memory: "z".repeat(99_999) },
    ];
    for (const sources of cases) {
      for (const part of buildInjectionParts(sources).parts) {
        expect(part.text).toContain("[memx: truncated");
      }
    }
  });
});

describe("sliceToBytes — 按字节切但不切碎多字节字符", () => {
  it("ASCII：按字节硬切", () => {
    expect(sliceToBytes("abcdef", 3)).toBe("abc");
  });

  it("不超过上限 → 原样返回", () => {
    expect(sliceToBytes("abc", 10)).toBe("abc");
  });

  it("中文：切在字符中间时回退，绝不产生半个字（无 U+FFFD 替换符）", () => {
    const text = "中文字符测试内容";
    const full = Buffer.byteLength(text, "utf-8");
    for (let n = 1; n < full; n++) {
      const sliced = sliceToBytes(text, n);
      expect(sliced).not.toContain("�");
      expect(Buffer.byteLength(sliced, "utf-8")).toBeLessThanOrEqual(n);
      // 必须是原文的前缀
      expect(text.startsWith(sliced)).toBe(true);
    }
  });

  it("emoji（代理对）同样不被切碎", () => {
    const text = "🐰兔子🐰";
    const full = Buffer.byteLength(text, "utf-8");
    for (let n = 1; n < full; n++) {
      const sliced = sliceToBytes(text, n);
      expect(sliced).not.toContain("�");
      expect(text.startsWith(sliced)).toBe(true);
    }
  });
});

describe("truncationNotice — 提示行本身", () => {
  it("四个数字 + 触顶维度都在里面", () => {
    const notice = truncationNotice(200, 512, 25600, 30000, "lines");
    expect(notice).toContain("200");
    expect(notice).toContain("512");
    expect(notice).toContain("25600");
    expect(notice).toContain("30000");
    expect(notice).toContain("200-line cap");
  });

  it("字节触顶时写 byte cap 与字节上限", () => {
    const notice = truncationNotice(10, 10, INJECT_MAX_BYTES, 40000, "bytes");
    expect(notice).toContain(`${INJECT_MAX_BYTES}-byte cap`);
    expect(notice).not.toContain("line cap");
  });

  it("单行（不跨行）——提示行用换行分隔，不会粘在正文最后一行上", () => {
    const capped = capSourceText("user", Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"));
    expect(capped.text).toContain("\n[memx: truncated");
  });
});

describe("shouldInjectAgent — 闸门真值表（exclude 永远压过 include）", () => {
  const gate = (over: Partial<Parameters<typeof shouldInjectAgent>[0]> = {}) => ({
    enabled: true,
    includeAgents: "all" as const,
    excludeAgents: [] as string[],
    ...over,
  });

  it("enabled=false → 任何 agent 都不注入", () => {
    expect(shouldInjectAgent(gate({ enabled: false }), "build")).toBe(false);
    expect(shouldInjectAgent(gate({ enabled: false, includeAgents: ["build"] }), "build")).toBe(false);
  });

  it('include="all" + 空 exclude → 所有 agent 注入', () => {
    expect(shouldInjectAgent(gate(), "build")).toBe(true);
    expect(shouldInjectAgent(gate(), "plan")).toBe(true);
    expect(shouldInjectAgent(gate(), "任何不认识的名字")).toBe(true);
  });

  it('include="all" - exclude 命中 → 该 agent 不注入，其余照旧', () => {
    const g = gate({ excludeAgents: ["noisy"] });
    expect(shouldInjectAgent(g, "noisy")).toBe(false);
    expect(shouldInjectAgent(g, "build")).toBe(true);
  });

  it("include=[列表] → 只有列出的注入", () => {
    const g = gate({ includeAgents: ["build", "plan"] });
    expect(shouldInjectAgent(g, "build")).toBe(true);
    expect(shouldInjectAgent(g, "plan")).toBe(true);
    expect(shouldInjectAgent(g, "other")).toBe(false);
  });

  it("include=[列表] - exclude 命中（同一个 agent 同时在两边）→ 不注入", () => {
    const g = gate({ includeAgents: ["build"], excludeAgents: ["build"] });
    expect(shouldInjectAgent(g, "build")).toBe(false);
  });

  it("include=[列表] - exclude 命中其他 agent → 列表里的照旧注入", () => {
    const g = gate({ includeAgents: ["build"], excludeAgents: ["other"] });
    expect(shouldInjectAgent(g, "build")).toBe(true);
    expect(shouldInjectAgent(g, "other")).toBe(false);
  });

  it("agent 未知（undefined/null）→ include='all' 时注入，include=列表时不注入", () => {
    expect(shouldInjectAgent(gate(), undefined)).toBe(true);
    expect(shouldInjectAgent(gate(), null)).toBe(true);
    expect(shouldInjectAgent(gate({ includeAgents: ["build"] }), undefined)).toBe(false);
    expect(shouldInjectAgent(gate({ excludeAgents: [""] }), undefined)).toBe(false);
  });
});

describe("describeGate — 诊断里的闸门表示", () => {
  it("默认：on include=all", () => {
    expect(describeGate({ enabled: true, includeAgents: "all", excludeAgents: [] })).toBe("on include=all");
  });

  it("关闭 / 列表 / 排除都如实反映", () => {
    expect(describeGate({ enabled: false, includeAgents: "all", excludeAgents: [] })).toBe("off include=all");
    expect(describeGate({ enabled: true, includeAgents: ["build"], excludeAgents: [] })).toBe("on include=[build]");
    expect(describeGate({ enabled: true, includeAgents: "all", excludeAgents: ["x"] })).toBe("on include=all-[x]");
    expect(describeGate({ enabled: true, includeAgents: ["a", "b"], excludeAgents: ["x", "y"] })).toBe(
      "on include=[a,b]-[x,y]",
    );
  });
});

describe("上限常量", () => {
  it("200 行 / 25KB，与文档与诊断口径一致", () => {
    expect(INJECT_MAX_LINES).toBe(200);
    expect(INJECT_MAX_BYTES).toBe(25 * 1024);
    expect(DEFAULT_INJECT_LIMITS).toEqual({ maxLines: 200, maxBytes: 25600 });
  });
});