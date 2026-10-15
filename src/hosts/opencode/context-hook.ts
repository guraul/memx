// memx · `context` hook 的判定与装配（纯逻辑，从 setup 里抽出来只为可测）。
//
// 这里是全插件最要紧的一段：它在**每个 step** 上跑在宿主的组装管线上，一旦把
// `event.system` 写坏，表现是模型静默变笨 / 提炼子会话 403，而不是任何报错。
// 两条分支互斥且顺序固定：
//
//   1. 子会话（memx 自己的提炼调用）→ **整体替换** system + temperature 0.2，
//      注入绝不参与。注入一旦漏进提炼调用，就等于把「协议 + 画像 + 索引」整包
//      塞进一个要求"只输出 JSON 数组"的调用里：提炼质量塌掉，且 #82 那类 403 高危。
//   2. 其余会话 → **append**（绝不是替换）。hook 触发时 `event.system` 已经装着
//      agent.system 与 AGENTS.md 合并正文（model-request.ts:110-116），替换会连
//      宿主内容一起抹掉。
//
// hook 回调本身是同步的：文件读走 stat 校验缓存，配置走 TTL 快照，都不在这里 await。
import type { AgentGate } from "../../core/injection.ts";
import { shouldInjectAgent } from "../../core/injection.ts";
import type { InjectionSources, SourceFact } from "../../core/injection.ts";
import { buildInjectionParts } from "../../core/injection.ts";

/** 宿主 `SessionContext` 里我们实际用到、且真的可变的部分（其余字段只读，无需建模）。 */
export interface ContextHookEvent {
  sessionID: string;
  agent?: string | undefined;
  system: Array<{ type: "text"; text: string }>;
  options: Record<string, unknown>;
}

export interface ContextHookDeps {
  /** 提炼子会话：sessionID → 提炼 system 提示词。命中即整体替换。 */
  childSessions: ReadonlyMap<string, string>;
  /** 生效中的 agent 闸门（同步快照，配置在别处按 TTL 刷新）。 */
  gate: AgentGate;
  /** 取三块来源内容（内部自带 stat 缓存）。 */
  readSources: () => InjectionSources;
}

export type ContextHookOutcome =
  /** 子会话：整体替换，返回提炼 system */
  | { kind: "child"; system: string }
  /** 非子会话但被 agent 闸门挡下：什么都没改 */
  | { kind: "gated" }
  /** 三块来源全缺：什么都没改 */
  | { kind: "empty" }
  /** 追加成功 */
  | { kind: "injected"; parts: number; facts: SourceFact[]; totalBytes: number; agent: string | undefined };

/**
 * 就地改写 `event`。**永不抛**——hook 抛出去就是宿主组装管线炸掉。
 * 任何一步出错都退化成"什么都不注入"，绝不半途改坏 event.system。
 */
export function applyContextHook(event: ContextHookEvent, deps: ContextHookDeps): ContextHookOutcome {
  const childSystem = deps.childSessions.get(event.sessionID);
  if (childSystem !== undefined) {
    event.system = [{ type: "text", text: childSystem }];
    event.options.temperature = 0.2;
    return { kind: "child", system: childSystem };
  }

  const agent = typeof event.agent === "string" ? event.agent : undefined;
  if (!shouldInjectAgent(deps.gate, agent)) return { kind: "gated" };

  let built;
  try {
    built = buildInjectionParts(deps.readSources());
  } catch {
    return { kind: "empty" };
  }
  if (built.parts.length === 0) return { kind: "empty" };

  // append：先算好再整体换引用，宿主原有的 part 一律保留
  event.system = [...(event.system ?? []), ...built.parts];
  return {
    kind: "injected",
    parts: built.parts.length,
    facts: built.facts,
    totalBytes: built.totalBytes,
    agent,
  };
}