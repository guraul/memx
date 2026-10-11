// memx · opencode v2 子会话提炼 LLM 适配器（阶段 2；#82 拍板：回复经事件缓存取，
// 不依赖 message.list/rpc）。
// 语义：session.create（model 创建时定）→ 注册 system 到 context hook 活跃集合 →
//       session.prompt（提交回执）→ session.wait → 从 assistantBySession 缓存取全文 →
//       finally session.remove + 移出活跃集合。
// 运行时未知（wait 语义）在端到端校准（handoff §8-4）。
import type { LLMClient } from "../../core/refine/refinement";

export interface SessionLLMHooks {
  /** 子会话创建后回调（活跃集合登记：sessionID → system） */
  onCreated: (sessionID: string, system: string) => void;
  /** 子会话删除后回调（活跃集合移除） */
  onRemoved: (sessionID: string) => void;
  /** 从事件缓存读取该子会话的 assistant 全文（text.ended 已落地时非空） */
  getReply: (sessionID: string) => string;
}

export function createSessionLLMClient(
  ctx: any,
  model: string | undefined,
  hooks: SessionLLMHooks,
): LLMClient {
  return {
    chat: async (params) => {
      let childSessionID: string | undefined;
      try {
        const created = await ctx.session.create({
          title: "memx-refinement",
          ...(model ? { model } : {}),
        });
        const raw = (created as { data?: { id?: string }; id?: string }) ?? {};
        childSessionID = raw.data?.id ?? raw.id;
        if (!childSessionID) return "";
        hooks.onCreated(childSessionID, params.system ?? "");

        await ctx.session.prompt({
          sessionID: childSessionID,
          text: params.messages[0]?.content ?? "",
        });

        // wait：session.wait 在 SessionDomain（类型确认）；等回合结束后读缓存
        await ctx.session.wait({ sessionID: childSessionID });
        const text = hooks.getReply(childSessionID);
        return text;
      } finally {
        if (childSessionID) {
          try {
            await ctx.session.remove({ sessionID: childSessionID });
          } catch {
            // cleanup must never mask the chat result
          }
          hooks.onRemoved(childSessionID);
        }
      }
    },
  };
}
