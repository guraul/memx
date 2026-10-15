// memx · opencode v2 子会话提炼 LLM 适配器（阶段 2；#82 定案：回复经
// ctx.session.context 取——rpc message.list 宿主未注册，inbox.delivered 无负载）。
// 语义：session.create（model 创建时定）→ context hook 注册 system →
//       session.prompt（提交回执）→ session.wait → session.context 取 assistant 全文 →
//       finally session.remove + 移出活跃集合。
import type { LLMClient } from "../../core/refine/refinement.ts";
import { toMessages } from "./context-shape.ts";

export interface SessionLLMHooks {
  /** 子会话创建后回调（活跃集合登记：sessionID → system） */
  onCreated: (sessionID: string, system: string) => void;
  /** 子会话删除后回调（活跃集合移除） */
  onRemoved: (sessionID: string) => void;
}

/** "provider/model#variant" → v2 SessionCreateInput 要求的 Model.Ref {providerID, id}
 * （#82 实测：传字符串会 SchemaError(Expected Model.Ref | null at ["model"])）。
 * 只认第一个 `/`；`#variant` 后缀剥离且不设 variant（variant 交由宿主选）。
 * 无 `/`、空串、undefined → undefined = 调用方整个省略 model 字段，交给宿主取默认
 * （绝不臆造 providerID）。memx.config.json 的 refinementModel 仍是字符串形态，schema 不变。 */
export function toModelRef(raw: string | undefined): { providerID: string; id: string } | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.split("#")[0]?.trim() ?? "";
  if (!cleaned) return undefined;
  const slash = cleaned.indexOf("/");
  if (slash <= 0) return undefined; // 无 "/" 或以 "/" 开头 → 不可信，交回宿主默认
  const providerID = cleaned.slice(0, slash).trim();
  const id = cleaned.slice(slash + 1).trim();
  if (!providerID || !id) return undefined;
  return { providerID, id };
}

async function fetchMessages(ctx: any, sessionID: string): Promise<any[]> {
  // v2 返回消息数组本身（HTTP 是 {data:[...]}，SDK 已 .then(v => v.data) 拆包），不是 {messages:[...]} 信封
  const { msgs } = toMessages(await ctx.session.context({ sessionID }));
  return msgs;
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
        const modelRef = toModelRef(model);
        const created = await ctx.session.create({
          title: "memx-refinement",
          ...(modelRef ? { model: modelRef } : {}),
        });
        const raw = (created as { data?: { id?: string }; id?: string }) ?? {};
        childSessionID = raw.data?.id ?? raw.id;
        if (!childSessionID) return "";
        hooks.onCreated(childSessionID, params.system ?? "");

        // #82 实测（对同一 2.0.26 服务端 A/B 探测 POST /api/session/{id}/prompt）：
        //   {"text":{"text":"hi"}} → 400 InvalidRequestError: Expected string at ["text"]
        //   {"text":"hi"}          → 200
        // 生成的 SessionPromptInput 类型（text 为 {text, files?...} 对象）与在跑的二进制
        // 载荷校验不一致，实际只收字符串。别按那份 d.ts 改回对象形态。
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
