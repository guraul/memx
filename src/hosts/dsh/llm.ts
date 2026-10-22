// memx · DSH 宿主的提炼 LLM 适配器：`ctx.llm.stream` → core 的 `LLMClient`。
//
// 与 opencode 那侧（`session-llm.ts` 造子会话）语义等价：一次 chat = 一次
// 独立的模型请求，system 走 `system` 槽，用户消息走 messages，temperature 0.2
// （由 core 的 refine() 传入）。
//
// 为什么不用子会话：DSH 的 `ctx.llm.stream` 就是"一次性模型调用"的公开面，
// 造子会话会把提炼的上下文叠进宿主的会话树（opencode 那边是历史包袱：#82 定案）。
// 代价是没有工具隔离——但提炼提示词要求"只输出 JSON 数组"，且我们不传 tools。
import type { LLMClient } from "../../core/refine/refinement.ts";
import type { DshLlm, DshStreamChunk } from "./types.ts";

export interface DshModelRoute {
  provider: string;
  model: string;
}

/** provider/model 两者都非空才算一条可用路由（空串 = 没配置，绝不猜）。 */
export function resolveRoute(provider: unknown, model: unknown): DshModelRoute | null {
  if (typeof provider !== "string" || typeof model !== "string") return null;
  const p = provider.trim();
  const m = model.trim();
  if (p === "" || m === "") return null;
  return { provider: p, model: m };
}

function chunkText(chunk: DshStreamChunk): { delta: string; block: string } {
  if (chunk.type === "text-delta") {
    const text = (chunk as { text?: unknown }).text;
    return { delta: typeof text === "string" ? text : "", block: "" };
  }
  if (chunk.type === "block-end") {
    const block = (chunk as { block?: { type?: string; text?: string } }).block;
    if (block?.type === "text" && typeof block.text === "string") return { delta: "", block: block.text };
  }
  return { delta: "", block: "" };
}

/**
 * 把 `ctx.llm.stream` 包成 core 的 `LLMClient`。
 *
 * 空回复返回空串（core 会把它当 invalid-output 走三态处理，而不是抛——那正是
 * `refine()` 的既有契约）。传输层异常原样抛出，由流水线记 failures。
 */
export function createDshLLMClient(llm: DshLlm, route: DshModelRoute): LLMClient {
  return {
    chat: async (params) => {
      const messages = params.messages.map((message) => ({
        role: "user" as const,
        content: [{ type: "text", text: message.content }],
      }));

      let deltas = "";
      let blocks = "";
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        ...(params.system !== undefined ? { system: params.system } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      })) {
        const { delta, block } = chunkText(chunk);
        deltas += delta;
        if (block !== "") blocks = block;
      }
      // 增量与整块只会来一种；都给就优先增量（整块是同一段文本的重复投影）
      return deltas !== "" ? deltas : blocks;
    },
  };
}
