// memx · opencode v2 会话消息形状：归一 + 最后一轮提取（#82 阻塞点的正解）。
// 独立成模块的原因：index.ts（插件壳）需要它，session-llm.ts（子会话 LLM 适配器）也需要它；
// 若共用逻辑放在其中任一方都会形成循环 import，故两者都从这里取。

/** v2 会话消息形状（session.context 返回：user 扁平 {text}；assistant {content:[{type,text}]}） */
export interface V2Message {
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}

export interface LastTurn {
  user: string;
  assistant: string;
}

/** ctx.session.context 返回值的形状归一（#82 阻塞点：v2 SDK 直接返回数组本身
 * `Promise<SessionMessageInfo[]>`，HTTP 层是 {data:[...]}，SDK 已 .then(v => v.data) 拆包；
 * 不是 {messages:[...]} 信封）。
 * 数组为准、信封兜底（其他宿主/未来版本）、其余 → 空数组（绝不抛）。 */
export function toMessages(raw: unknown): {
  shape: "array" | "envelope" | "other";
  msgs: V2Message[];
} {
  if (Array.isArray(raw)) return { shape: "array", msgs: raw as V2Message[] };
  if (raw !== null && typeof raw === "object") {
    const inner = (raw as { messages?: unknown }).messages;
    if (Array.isArray(inner)) return { shape: "envelope", msgs: inner as V2Message[] };
  }
  return { shape: "other", msgs: [] };
}

/** v2 消息形状的最后一轮提取（user → 其后第一条 assistant） */
export function extractLastTurn(msgs: V2Message[]): LastTurn | null {
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.type === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  const userText = msgs[lastUserIdx]!.text ?? "";

  let assistantText = "";
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    if (msgs[i]!.type === "assistant") {
      assistantText = (msgs[i]!.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      break;
    }
  }

  return { user: userText, assistant: assistantText };
}