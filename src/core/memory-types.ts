import { z } from "zod";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SOURCES = ["explicit", "implicit_correction", "confirmation", "depth_signal"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;

export const ACTIONS = ["append", "update", "deprecate"] as const;

export function deriveSlug(directory: string): string {
  return directory.replace(/^\//, "").replace(/\/+$/, "").replace(/\//g, "-");
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
  supersedes: z.string().max(80).nullish(),
  merges: z.string().max(200).nullish(),
  reason: z.string().max(200),
});

export interface MemoryProposal extends z.infer<typeof MemoryProposalSchema> {}

export const MemoryProposalArraySchema = z.array(MemoryProposalSchema);
