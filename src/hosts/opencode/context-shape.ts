// memx · opencode v2 会话消息形状：归一 + 轮次提取（#82 阻塞点的正解）。
// 独立成模块的原因：index.ts（插件壳）需要它，session-llm.ts（子会话 LLM 适配器）也需要它；
// 若共用逻辑放在其中任一方都会形成循环 import，故两者都从这里取。

/** v2 会话消息形状（session.context 返回：user 扁平 {text}；assistant {content:[{type,text}]}；
 *  每条消息都有 id 与 time.created——P0-1 的增量游标就锚在 id 上） */
export interface V2Message {
  id?: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}

export interface LastTurn {
  user: string;
  assistant: string;
}

/** P0-1：一轮用户消息 + 其后的助手回复（增量捕获的最小单位） */
export interface CapturedTurn {
  user: string;
  assistant: string;
  assistantMessageId?: string;
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

/** 助手消息的正文（只取 text part，工具/推理 part 不计） */
export function assistantText(msg: V2Message): string {
  return (msg.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

export function userText(msg: V2Message): string {
  return msg.text ?? "";
}

/** v2 消息形状的最后一轮提取（最后一条 user → 它之后的最后一条 assistant）。
 *  保留给单轮取用的调用方（session-llm 的子会话回复、老调用点）；P0-1 的批量捕获走 extractTurns。 */
export function extractLastTurn(msgs: V2Message[]): LastTurn | null {
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.type === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  const user = userText(msgs[lastUserIdx]!);

  let assistant = "";
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    if (msgs[i]!.type === "assistant") {
      assistant = assistantText(msgs[i]!);
      break;
    }
  }

  return { user, assistant };
}

/** P0-1 游标锚点：按消息 id 找位置（从尾部往前找，热路径下 O(1) 命中） */
export function findMessageIndex(msgs: V2Message[], id: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.id === id) return i;
  }
  return -1;
}

/**
 * P0-1：增量捕获的决策核心（纯函数，可单测——宿主侧只负责 storage 读写与信号解析）。
 *
 * 游标锚在**消息 id** 上：命中 → 从它之后续扫；id 不在数组里（压缩/分叉裁掉了）→ 退回全量扫
 * 并把状态标成 anchor-lost（调用方据此记报警）。没有任何游标 = 首次扫（fresh）。
 */
export interface CaptureCursor {
  lastMessageId?: string;
}

export interface CapturePlan {
  cursorState: "fresh" | "resumed" | "anchor-lost";
  /** 本次开始扫描的下标 */
  startIndex: number;
  turns: CapturedTurn[];
  /** 下一轮要写入的游标（最后一条带 id 的消息；没有则 undefined，游标不动） */
  nextCursorId?: string;
}

export function planCapture(msgs: V2Message[], cursor?: CaptureCursor): CapturePlan {
  const anchorIndex = cursor?.lastMessageId ? findMessageIndex(msgs, cursor.lastMessageId) : -1;
  const anchorLost = cursor?.lastMessageId != null && anchorIndex === -1;
  const startIndex = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  const cursorState: CapturePlan["cursorState"] =
    cursor?.lastMessageId == null ? "fresh" : anchorLost ? "anchor-lost" : "resumed";

  const lastMsg = msgs[msgs.length - 1];
  return {
    cursorState,
    startIndex,
    turns: extractTurns(msgs, startIndex),
    ...(lastMsg?.id !== undefined ? { nextCursorId: lastMsg.id } : {}),
  };
}

/**
 * P0-1：从 `fromIndex` 起把消息切片还原成"轮次"（每条 assistant 配它前面最近的 user）。
 *
 * 旧实现只看最后一轮（extractLastTurn）——长会话中间轮次的 SIGNAL 全丢：事件漏一拍、
 * 一次 execution 跨多轮、或客户端批量提交时，中间的 `<!-- STYLE_SIGNAL -->` 永远不会被解析。
 *
 * 左边界不切断配对：窗口从 assistant 开始时，向前找最近的 user 作为它的配对，
 * 这样"上一轮已扫到 user、这一轮才补上 assistant"的时序不会把回复丢掉。
 */
export function extractTurns(msgs: V2Message[], fromIndex = 0): CapturedTurn[] {
  if (msgs.length === 0) return [];
  const start = Math.max(0, Math.min(fromIndex, msgs.length));

  let pendingUser = "";
  let hasUser = false;
  for (let i = start - 1; i >= 0; i--) {
    if (msgs[i]!.type === "user") {
      pendingUser = userText(msgs[i]!);
      hasUser = true;
      break;
    }
  }

  const turns: CapturedTurn[] = [];
  for (let i = start; i < msgs.length; i++) {
    const msg = msgs[i]!;
    if (msg.type === "user") {
      pendingUser = userText(msg);
      hasUser = true;
      continue;
    }
    if (msg.type !== "assistant") continue;
    // 没有配对 user 的 assistant（窗口起点在会话最前面就是回复）不成轮，跳过
    if (!hasUser) continue;
    turns.push({
      user: pendingUser,
      assistant: assistantText(msg),
      ...(msg.id !== undefined ? { assistantMessageId: msg.id } : {}),
    });
  }
  return turns;
}
