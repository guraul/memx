// memx · DSH 宿主适配层的**结构类型**（零运行时依赖，也零 `@deepseek-ai/*` import）。
//
// 为什么不用官方 d.ts：memx 是独立包，`package.json` 里没有 `@deepseek-ai/*`
// （#17 的施工纪律：不 install、不动 lockfile）。opencode 宿主当年也是这么做的
// （`session-llm.ts` 里 `ctx: any`），这里把它写实一点——只描述我们真正调用的那几个成员，
// 名字与官方声明一一对应，核对来源见 `src/hosts/dsh/README.md`「与 DSH 0.2.1-rc.2 的对照」。
//
// 红线：本文件与 `src/hosts/dsh/` 其余文件都不得 import 任何宿主包；core 更不许。

/** 模型可见的内容块（只建模文本，其余原样忽略）。 */
export interface DshContentBlock {
  readonly type: string;
  readonly text?: string;
}

/** 会话（Session）—— 我们只用它的身份。 */
export interface DshSession {
  readonly id: string;
}

/** Agent 的模型路由（官方 `AgentOptions` 的子集）。 */
export interface DshAgentOptions {
  readonly provider?: string;
  readonly model?: string;
}

/** 一次装配的 Agent（官方 `Agent` 的子集）。 */
export interface DshAgent {
  readonly id: string;
  readonly session: DshSession;
  readonly options?: DshAgentOptions;
  /** 把模型可见上下文排到下一个 pre-step（官方 `Agent.inject`）。 */
  inject?(message: unknown): void;
}

/**
 * 装配上下文（官方 `AssembleContext`）。官方声明的字段只有 `scope` / `signal`，
 * `agent` 由 `@deepseek-ai/dsh-agent` 通过模块扩展挂上（`assembleContextFor` 里
 * `{ agent, scope: agent }`），是我们拿到"这次装配属于哪个会话"的唯一入口。
 */
export interface DshAssembleContext {
  readonly agent?: DshAgent;
  readonly scope?: object;
  readonly signal?: AbortSignal;
}

/** system prompt 的一段（官方 `PromptSection` 的子集）。 */
export interface DshPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: DshAssembleContext) => string);
  readonly interpolate?: boolean;
}

export interface DshSystemPrompt {
  section(section: DshPromptSection): unknown;
}

/** 工具的规范输出声明（官方 `ToolOutputDefinition` 的子集）。 */
export interface DshToolOutput {
  readonly schema: Record<string, unknown>;
  render(args: unknown, value: unknown): DshContentBlock[];
}

/** 工具执行上下文（官方 `ToolRunContext` 的子集）：只需要 agent。 */
export interface DshToolRunContext {
  readonly agent?: DshAgent;
  readonly signal?: AbortSignal;
}

/** 工具定义（官方 `ToolDefinition` 的子集；`parameters` 是**原始 JSON Schema**）。 */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: DshToolOutput;
  execute(args: unknown, exec: DshToolRunContext): Promise<unknown>;
}

export interface DshTools {
  register(definition: DshToolDefinition): unknown;
}

/** 会话工作目录服务（官方 `WorkingDirectoryService` 的子集）。 */
export interface DshWorkingDirectory {
  /** 提交后的当前目录（纯内存读，无 IO）。 */
  get(session: DshSession): string;
  /** 没有记录过目录的会话用的绝对兜底目录。 */
  readonly defaultDirectory?: string;
}

/** 模型请求（官方 `GenerateOptions` 的子集）。 */
export interface DshGenerateOptions {
  readonly provider: string;
  readonly model: string;
  readonly messages: Array<{ readonly role: "user"; readonly content: DshContentBlock[] }>;
  readonly system?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/** 流式分片（官方 `StreamChunk` 的子集：我们只消费文本）。 */
export type DshStreamChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "block-end"; readonly block: DshContentBlock }
  | { readonly type: string };

export interface DshLlm {
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>;
}

/** Agent 注册表（官方 `AgentRegistry` 的子集）。 */
export interface DshAgents {
  get(id: string): DshAgent | undefined;
}

/** 会话事件（官方 `SessionEvent` 的子集）。 */
export interface DshSessionEvent {
  readonly type: string;
  readonly data?: unknown;
}

/** 宿主 logger（可选服务）。 */
export interface DshLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/**
 * 插件拿到的 ctx（官方 `Context` 的子集）。刻意每个服务都可缺省：
 * `inject` 声明只是在"服务齐了才激活"，而测试里的假 ctx 只装需要的那几个。
 */
export interface DshContext {
  readonly systemPrompt: DshSystemPrompt;
  readonly tools: DshTools;
  readonly workingDirectory: DshWorkingDirectory;
  readonly llm: DshLlm;
  readonly agents?: DshAgents;
  on(event: "session/event", listener: (session: DshSession, event: DshSessionEvent) => void): unknown;
  readonly logger?: DshLogger;
}
