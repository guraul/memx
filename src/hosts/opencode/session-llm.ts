// memx · opencode v2 子会话提炼 LLM 适配器（阶段 2；#82 定案：回复经
// ctx.session.context 取——rpc message.list 宿主未注册，inbox.delivered 无负载）。
// 语义：session.create（model 创建时定）→ context hook 注册 system →
//       session.prompt（提交回执）→ session.wait → session.context 取 assistant 全文 →
//       finally session.remove + 移出活跃集合。
import type { LLMClient } from "../../core/refine/refinement";

export interface SessionLLMHooks {
  /** 子会话创建后回调（活跃集合登记：sessionID → system） */
  onCreated: (sessionID: string, system: string) => void;
  /** 子会话删除后回调（活跃集合移除） */
  onRemoved: (sessionID: string) => void;
}

async function fetchMessages(ctx: any, sessionID: string): Promise<any[]> {
  const res = (await ctx.session.context({ sessionID })) as { messages?: any[] };
  return res?.messages ?? [];
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

        // wait：SessionDomain 确认有 wait（等回合结束后 context 里已有 assistant 回复）
        await ctx.session.wait({ sessionID: childSessionID });
        const msgs = await fetchMessages(ctx, childSessionID);
        const assistant = [...msgs].reverse().find((m) => m?.type === "assistant");
        const text = ((assistant?.content ?? []) as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
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
