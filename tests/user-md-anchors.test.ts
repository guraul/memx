// P0-3（handoff-20261011 §4 阶段 3-3）：单遍应用 + 内容锚点寻址的回归测试。
// 这里不 mock homedir：applyProposals / parseUserMd / serializeUserMd 都是纯函数（不碰盘）。
import { describe, it, expect } from "vitest";
import { applyProposals } from "../src/core/store/user-md";
import type { StyleProposal } from "../src/core/types";

/** 受管小节里第 5/6 行是目标条目；第 1-3 行是一个**空小节**（序列化时会被丢掉，
 *  正是批内行号漂移的来源）。 */
const SAMPLE = `## 架构与技术决策

## 沟通与交互风格
- [2026-01-01] 使用 pnpm 管理依赖
- [2026-01-02] 提交信息用中文
`;

const lines = (content: string): string[] => content.split("\n");

describe("P0-3(e) 单遍应用（批内行号不再漂移）", () => {
  it("同批两个提案：append 撑大前一个小节后，update 的行号仍指向原目标", () => {
    const proposals: StyleProposal[] = [
      { action: "append", category: "architecture", content: "默认 SvelteKit", reason: "新偏好" },
      // target_line=5 是按**原始文件**算的（第 5 行 = 提交信息用中文）
      { action: "update", category: "communication", content: "提交信息统一用中文", target_line: 5, reason: "措辞收紧" },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);

    // 批内漂移被消除：update 命中原第 5 行（无 target_text → 行号兜底，按设计留告警）
    expect(warnings.join(" ")).toMatch(/行号兜底/);
    // append 落进架构小节
    expect(content).toContain("默认 SvelteKit");
    // update 命中原第 5 行的条目，且没有误伤第 4 行
    expect(content).toContain("提交信息统一用中文");
    expect(lines(content)).toContain("- [2026-01-01] 使用 pnpm 管理依赖");
    expect(lines(content)).not.toContain("- [2026-01-02] 提交信息用中文");
  });

  it("同批多条 append 一次落盘，序列化幂等（parse→serialize 往返不再漂移）", () => {
    const proposals: StyleProposal[] = [
      { action: "append", category: "toolchain", content: "统一用 pnpm", reason: "a" },
      { action: "append", category: "toolchain", content: "格式化用 prettier", reason: "b" },
    ];
    const once = applyProposals(proposals, SAMPLE).content;
    expect(lines(once).filter((l) => l.endsWith("统一用 pnpm"))).toHaveLength(1);
    expect(lines(once).filter((l) => l.endsWith("格式化用 prettier"))).toHaveLength(1);
    // 空跑一批 = 纯 parse→serialize 往返：内容必须稳定（幂等）
    expect(applyProposals([], once).content).toBe(once);
  });
});

describe("P0-3(c) 内容锚点寻址", () => {
  it("target_text 精确命中，压过错误/过期的 target_line", () => {
    const proposals: StyleProposal[] = [
      {
        action: "update",
        category: "communication",
        content: "提交信息统一用中文",
        target_line: 4, // 故意指向上一条（pnpm）
        target_text: "提交信息用中文",
        reason: "措辞收紧",
      },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);
    expect(warnings).toEqual([]); // 精确命中 → 无告警
    expect(lines(content)).toContain("- [2026-01-01] 使用 pnpm 管理依赖");
    expect(lines(content)).not.toContain("- [2026-01-02] 提交信息用中文");
  });

  it("锚点降级：空格/markdown 装饰差异仍能命中，且有告警", () => {
    const proposals: StyleProposal[] = [
      { action: "update", category: "communication", content: "提交信息统一用中文", target_text: "**提交信息用中文**", reason: "粗体抄写" },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);
    expect(lines(content)).not.toContain("- [2026-01-02] 提交信息用中文");
    expect(warnings.join(" ")).toMatch(/fuzzy|containment/);
  });

  it("锚点降级：唯一包含关系可命中，有告警", () => {
    const proposals: StyleProposal[] = [
      { action: "deprecate", category: "communication", content: "改用 corepack", target_text: "使用 pnpm", reason: "换了工具" },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);
    expect(content).toContain("~~[2026-01-01] 使用 pnpm 管理依赖~~");
    expect(content).toContain("(Deprecated: 改用 corepack)");
    expect(warnings.join(" ")).toMatch(/containment/);
  });

  it("锚点未命中 → update 追加为新条目并告警", () => {
    const proposals: StyleProposal[] = [
      { action: "update", category: "communication", content: "新的沟通偏好", target_text: "根本不存在的条目", reason: "找不到" },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);
    expect(content).toContain("新的沟通偏好");
    expect(warnings.join(" ")).toMatch(/未定位到目标/);
  });

  it("锚点未命中 → deprecate 不改动任何条目并告警", () => {
    const proposals: StyleProposal[] = [
      { action: "deprecate", category: "communication", content: "废弃理由", target_text: "根本不存在的条目", reason: "找不到" },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);
    expect(content).not.toContain("~~");
    expect(warnings.join(" ")).toMatch(/未定位到目标/);
  });

  it("无 target_text 时回退 target_line，并留降级告警", () => {
    const proposals: StyleProposal[] = [
      { action: "update", category: "communication", content: "提交信息统一用中文", target_line: 5, reason: "老格式提案" },
    ];
    const { content, warnings } = applyProposals(proposals, SAMPLE);
    expect(lines(content)).not.toContain("- [2026-01-02] 提交信息用中文");
    expect(warnings.join(" ")).toMatch(/行号兜底/);
  });

  it("锚点歧义（包含多条）不猜，回退行号；行号也没有则追加", () => {
    const content = `## 沟通与交互风格
- [2026-01-01] 用 pnpm 装依赖
- [2026-01-02] 用 pnpm 跑脚本
`;
    const proposals: StyleProposal[] = [
      { action: "update", category: "communication", content: "统一 pnpm", target_text: "pnpm", reason: "歧义" },
    ];
    const { content: out, warnings } = applyProposals(proposals, content);
    // 两条都含 "pnpm"，包含命中 2 条 → 歧义 → 无行号兜底 → 追加新条目
    expect(out).toContain("统一 pnpm");
    expect(warnings.join(" ")).toMatch(/歧义/);
    expect(lines(out)).toContain("- [2026-01-01] 用 pnpm 装依赖");
    expect(lines(out)).toContain("- [2026-01-02] 用 pnpm 跑脚本");
  });
});

describe("applyProposals 保留非受管内容（写盘不得丢用户内容）", () => {
  it("前言散文、未知小节、小节内手写行原样带回", () => {
    const content = `# 我自己的标题

一些用户手写说明。

## 沟通与交互风格
- [2026-01-01] 先给结论
<!-- 用户自己的注释 -->

## 用户自定义小节
随便写的东西
`;
    const proposals: StyleProposal[] = [
      { action: "append", category: "toolchain", content: "用 pnpm", reason: "新偏好" },
    ];
    const { content: out } = applyProposals(proposals, content);
    expect(out).toContain("# 我自己的标题");
    expect(out).toContain("一些用户手写说明。");
    expect(out).toContain("## 用户自定义小节");
    expect(out).toContain("随便写的东西");
    expect(out).toContain("<!-- 用户自己的注释 -->");
    expect(out).toContain("- [2026-01-01] 先给结论");
    expect(out).toContain("用 pnpm");
  });
});
