import { z } from "zod";

export const CATEGORIES = ["communication", "toolchain", "architecture", "pitfall"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SOURCES = ["explicit", "implicit_correction", "format_feedback", "depth_signal", "confirmation"] as const;
export type SignalSource = (typeof SOURCES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const ACTIONS = ["append", "update", "deprecate"] as const;
export type Action = (typeof ACTIONS)[number];

export const CATEGORY_HEADERS: Record<Category, string> = {
  communication: "沟通与交互风格",
  toolchain: "工具与环境偏好",
  architecture: "架构与技术决策",
  pitfall: "踩坑与禁忌",
};

export const HEADER_TO_CATEGORY: Record<string, Category> = {
  "沟通与交互风格": "communication",
  "工具与环境偏好": "toolchain",
  "架构与技术决策": "architecture",
  "踩坑与禁忌": "pitfall",
};

export interface StyleSignal {
  category: Category;
  content: string;
  evidence: string;
  confidence: Confidence;
  source: SignalSource;
}

export interface StyleProposal {
  action: Action;
  category: string;
  content: string;
  target_line?: number | null | undefined;
  reason: string;
}

export interface UserMdSection {
  header: string;
  category: Category;
  lines: UserMdEntry[];
  /** 非受管原文行（受管小节内/其后用户自己写的散文、注释、未知小节），原样保留 */
  extras?: string[];
}

/** USER.md 的完整文档视图：受管小节 + 非受管内容（写盘不得丢后者） */
export interface UserMdDoc {
  /** 首个受管小节之前的全部原文行（含用户自写的一级标题、散文、未知 ## 小节） */
  preamble: string[];
  sections: UserMdSection[];
}

export interface UserMdEntry {
  raw: string;
  date: string;
  text: string;
  deprecated: boolean;
  lineNumber: number;
}

export const StyleSignalSchema = z.object({
  category: z.enum(CATEGORIES),
  content: z.string().max(100),
  evidence: z.string().max(200),
  confidence: z.enum(CONFIDENCES),
  source: z.enum(SOURCES),
});

export const StyleProposalSchema = z.object({
  action: z.enum(ACTIONS),
  category: z.enum(CATEGORIES),
  content: z.string().max(100),
  target_line: z.number().int().positive().nullish(),
  reason: z.string().max(200),
});

export const StyleProposalArraySchema = z.array(StyleProposalSchema);

export const PluginConfigSchema = z.object({
  refinementModel: z.string().optional(),
});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;
