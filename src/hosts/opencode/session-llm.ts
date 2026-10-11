// memx · opencode v2 子会话提炼 LLM 适配器（阶段 2，handoff 附录 A 硬点②③定案）。
// v2 语义：session.create（model 创建时定）→ 注册 system 到 context hook 活跃集合 →
//          session.prompt（提交回执）→ session.wait → rpc message.list 取 assistant 回复 →
//          finally session.remove + 移出活跃集合。
// 三处运行时未知（wait 语义 / rpc 形状 / 事件流）在端到端验证（handoff §8-4）。
import type { LLMClient } from "../../core/refine/refinement";

export interface SessionLLMHooks {
  /** 子会话创建后回调（活跃集合登记：sessionID → system） */
  onCreated: (sessionID: string, system: string) => void;
  /** 子会话删除后回调（活跃集合移除） */
  onRemoved: (sessionID: string) => void;
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

        // wait：session.wait 若在 SessionDomain（类型上有），优先用它等回合结束；
        // 否则轮询 message.list 直到出现 assistant 回复（语义实测项，端到端校准）
        try {
          if (typeof ctx.session.wait === "function") {
            await ctx.session.wait({ sessionID: childSessionID });
          } else {
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline) {
              const msgs = await fetchMessages(ctx, childSessionID);
              const hasAssistant = msgs.some((m) => m.type === "assistant");
              if (hasAssistant) break;
              await new Promise((r) => setTimeout(r, 1_000));
            }
          }
        } catch {
          // wait 失败不阻断：继续拉取，取不到就是空回复
        }

        const text = await fetchAssistantReply(ctx, childSessionID);
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

async function fetchMessages(ctx: any, sessionID: string): Promise<any[]> {
  const res = (await (ctx.rpc as { call: (method: string, input: unknown) => Promise<unknown> }).call(
    "message.list",
    { sessionID, order: "desc", limit: 5 },
  )) as { data?: any[] } | any[];
  return Array.isArray(res) ? res : (res?.data ?? []);
}

async function fetchAssistantReply(ctx: any, sessionID: string): Promise<string> {
  const msgs = await fetchMessages(ctx, sessionID);
  const assistant = msgs.find((m) => m?.type === "assistant");
  if (!assistant) return "";
  const content = (assistant.content ?? []) as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}
