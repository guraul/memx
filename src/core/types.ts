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
