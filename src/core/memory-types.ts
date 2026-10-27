import { z } from "zod";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SOURCES = ["explicit", "implicit_correction", "confirmation", "depth_signal"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;

export const ACTIONS = ["append", "update", "deprecate"] as const;

/** 根目录（`/`）的稳定占位 slug：`projects/root/.mem/` + `## root` 节（issue #36）。 */
export const ROOT_SLUG = "root";

/**
 * 目录 → 项目 slug。**空结果的两种来源必须区分**（issue #36 / #37）：
 *   - 有目录、但去掉首尾 `/` 后为空（典型 `/`）= 根目录 → `ROOT_SLUG`（`root`）。
 *     这里**不拒写**：伴侣页会话的 cwd 就是 `/`，"记一下"必须能落地，否则功能直接失效。
 *   - 入参本身为空/全空白 = 宿主压根取不到工作目录 → 仍返回 `""`。
 *     这个空串是 DSH 壳的哨兵（`slug === ""` → memory_write 失败、memory_search 检索全库），
 *     吞成 `root` 会把"没有目录"静默写成根目录记忆。
 * 归一放在**这里**是刻意的单点：cards 目录、索引节、注入、health/search 全部经本函数派生 slug。
 */
export function deriveSlug(directory: string): string {
  if (directory.trim() === "") return "";
  const slug = directory.replace(/^\//, "").replace(/\/+$/, "").replace(/\//g, "-");
  return slug === "" ? ROOT_SLUG : slug;
}

export const MemorySignalSchema = z
  .object({
    type: z.enum(MEMORY_TYPES),
    name: z.string().max(60),
    description: z.string().max(150),
    content: z.string().max(500),
    why: z.string().max(200).nullish(),
    how_to_apply: z.string().max(200).nullish(),
    evidence: z.string().max(200),
    confidence: z.enum(CONFIDENCES),
    source: z.enum(MEMORY_SOURCES),
  })
  .superRefine((data, ctx) => {
    if ((data.type === "feedback" || data.type === "project") && data.why == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.type} type requires why field`,
        path: ["why"],
      });
    }
    if ((data.type === "feedback" || data.type === "project") && data.how_to_apply == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.type} type requires how_to_apply field`,
        path: ["how_to_apply"],
      });
    }
  });

export interface MemorySignal extends z.infer<typeof MemorySignalSchema> {}

export const MemoryProposalSchema = z.object({
  action: z.enum(ACTIONS),
  type: z.enum(MEMORY_TYPES),
  name: z.string().max(60),
  description: z.string().max(150),
  content: z.string().max(500),
  why: z.string().max(200).nullish(),
  how_to_apply: z.string().max(200).nullish(),
  target_file: z.string().max(80),
  /** #31 fork：同名不同义另存新卡时，指向被顶替/并列的原卡文件名（仅供写盘层落 frontmatter + 旧卡审计行）。 */
  same_name_as: z.string().max(80).nullish(),
  supersedes: z.string().max(80).nullish(),
  merges: z.string().max(200).nullish(),
  reason: z.string().max(200),
});

export interface MemoryProposal extends z.infer<typeof MemoryProposalSchema> {}

export const MemoryProposalArraySchema = z.array(MemoryProposalSchema);
