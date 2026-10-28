// memx · DSH 宿主适配器（#17 第一步 B）
//
// 四件事，对应 issue 的 B 节：
//   ① 注入：`ctx.systemPrompt.section` 注册一段「协议 + Track 1 画像 + 当前项目小节」。
//      **每个会话只求值一次**（WeakMap by agent），保证整段会话字节恒定——恒定字节是
//      缓存不失效的前提，所以这里绝不放时间/计数/随机。
//   ② 工具：`ctx.tools.register` 注册 `memory_write` / `memory_search` / `forget`，写入口与
//      opencode 完全同一份（core 的 `writeProjectMemory` / `forgetMemory` + 索引写盘），
//      检索走 core `searchMemories`（原 mem CLI 的 cmdSearch 上提）。
//   ③ 轮末补记：`session/event` 过滤 `turn/end` → `autoRefine === false` 直接跳过 →
//      本轮已有工具写入则跳过 → 会话级节流（throttleMinutes，默认 10）→ `ctx.llm.stream`
//      提炼 → 写盘 → 下次 pre-step 展示「已记住 N 条」。
//   ④ 红线：插件跑在宿主主进程，任何钩子异常都只能进诊断，**绝不能**拖垮会话；
//      轮末补记是后台任务，绝不 await 阻塞事件分发。
//
// 与 opencode 的行为差异（详细对照见 README.md）：
//   - 注入的是"当前项目小节"，不是整份 MEMORY.md；
//   - 提炼用 `ctx.llm.stream` 一次性调用，不造子会话（因此不需要 context hook 的
//     "子会话整体替换 system"那套补丁）；
//   - 节流按会话计（opencode 是进程级 + 游标增量捕获）。
//
// 依赖纪律：本目录零 `@deepseek-ai/*` import（见 types.ts 抬头）。
import { deriveSlug, MEMORY_TYPES } from "../../core/memory-types.ts";
import { loadMemxConfig } from "../../core/config.ts";
import type { MemxConfig } from "../../core/config.ts";
import { buildInjectionParts } from "../../core/injection.ts";
import { InjectionSourceCache, readInjectionSourcesForSlug } from "../../core/pipeline/injection-source.ts";
import { SessionPipeline } from "../../core/pipeline/session.ts";
import type { PipelineDiagnostics, PipelineHost } from "../../core/pipeline/session.ts";
import { captureMemorySignals } from "../../core/signals/memory-capture.ts";
import { writeProjectMemory, applyBreadcrumbLine } from "../../core/memory-write.ts";
import { forgetMemory, readMemoryIndex, writeMemoryIndex } from "../../core/store/memory-md.ts";
import { memoryIndexLockPath, withFileLock } from "../../core/store/lock.ts";
import { searchMemories } from "../../core/store/memory-search.ts";
import { createFileAlertStore, formatBreadcrumb } from "../../core/alerts.ts";
import { createDshLLMClient, resolveRoute } from "./llm.ts";
import type { DshModelRoute } from "./llm.ts";
import type {
  DshAgent,
  DshAssembleContext,
  DshContext,
  DshSession,
  DshSessionEvent,
} from "./types.ts";

/** 插件名（宿主profile 里用这个名字挂载/卸载）。 */
export const name = "memx";

/**
 * 依赖的服务名。Cordis 的 `inject` 语义 = 这些服务齐了才激活；
 * `agents` 只用于"从会话 id 反查活着的 Agent"（轮末提示注入需要），
 * 缺了也只降级成"不注入提示"，不影响主路径。
 */
export const inject = ["systemPrompt", "tools", "workingDirectory", "llm", "agents"] as const;

/** 注入段的排序位（官方 SECTION_ORDERS 里 12000 落在工具说明与 MCP 之间，不与任何内建段冲突）。 */
export const INJECT_SECTION_ORDER = 12000;

/** 段名：全局唯一即可，带前缀便于在宿主日志里定位。 */
export const INJECT_SECTION_NAME = "memx:memory";

/** 默认节流（分钟）：与 core 配置的缺省值一致。 */
export const DEFAULT_THROTTLE_MINUTES = 10;

/** 「已记住 N 条」提示的上限（官方 notice summary 的硬上限就是 120）。 */
export const NOTICE_MAX_CHARS = 120;

export interface DshMemxConfig {
  /** 提炼用 provider；空 = 跟随当前会话。 */
  provider?: string;
  /** 提炼用 model；空 = 跟随当前会话。 */
  model?: string;
  /**
   * 轮末自动提炼开关；缺省开。
   * `false` 只关「轮末补记」，**显式 `memory_write` 不受影响**（用户在对话里说"记住"照样写）。
   */
  autoRefine?: boolean;
  /** 轮末补记的节流分钟数；缺省读 memx.config.json 的 throttleMinutes（再缺省 10）。 */
  throttleMinutes?: number;
}

/** 宿主 volatile 字段的运行时形态：值被包成只读引用 cell（cosmokit Volatile）。 */
interface VolatileCell<T> {
  get(): T;
}

/**
 * 取出 volatile cell 里的值；普通值（直调 apply / 旧配置）原样返回。
 *
 * 薄壳包（第二步）用 schemastery 声明四个字段 `.volatile()`，宿主便把它们包成
 * 引用 cell 传进来——不拆开的话 `typeof config.provider === "string"` 全是 false，
 * 表现为「设置里选了提炼模型却不生效」「关了自动提炼还照写」。
 */
function unwrapCell<T>(value: T | VolatileCell<T> | undefined): T | undefined {
  const cell = value as VolatileCell<T> | undefined;
  return typeof cell?.get === "function" ? cell.get() : (value as T | undefined);
}

/** 把 config 归一成普通值快照（缺省值语义保持原样）。调用方每次用前现读，别跨轮次缓存。 */
function readConfig(raw: DshMemxConfig): DshMemxConfig {
  const provider = unwrapCell(raw.provider);
  const model = unwrapCell(raw.model);
  const autoRefine = unwrapCell(raw.autoRefine);
  const throttleMinutes = unwrapCell(raw.throttleMinutes);
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(autoRefine !== undefined ? { autoRefine } : {}),
    ...(throttleMinutes !== undefined ? { throttleMinutes } : {}),
  };
}

/**
 * 插件配置声明。
 *
 * ⚠️ 这里是**手写的 standard-schema**（`~standard.validate`），不是 schemastery：
 * memx 的 package.json 没有 `@deepseek-ai/*`（不 install、不动 lockfile，见 #17 红线），
 * 而 Cordis 解析 Config 只需要 `Config["~standard"].validate`。字段语义与 schemastery 的
 * `.volatile()` 一致（provider/model 是"改了即时生效"的引用值，落盘/热更不重启插件），
 * 真正的 z.object + `.volatile()` 设置面留给薄壳包（第二步）。
 */
export const Config = {
  "~standard": {
    version: 1 as const,
    vendor: "memx",
    validate(input: unknown): { value: DshMemxConfig } | { issues: Array<{ message: string; path: string[] }> } {
      const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      const value: DshMemxConfig = {};
      for (const key of ["provider", "model"] as const) {
        const field = raw[key];
        if (field === undefined || field === null) continue;
        if (typeof field !== "string") {
          return { issues: [{ message: `memx: ${key} 必须是字符串`, path: [key] }] };
        }
        value[key] = field;
      }
      const autoRefine = raw.autoRefine;
      if (autoRefine !== undefined && autoRefine !== null) {
        if (typeof autoRefine !== "boolean") {
          return { issues: [{ message: "memx: autoRefine 必须是布尔值", path: ["autoRefine"] }] };
        }
        value.autoRefine = autoRefine;
      }
      const throttle = raw.throttleMinutes;
      if (throttle !== undefined && throttle !== null) {
        if (typeof throttle !== "number" || !Number.isFinite(throttle) || throttle <= 0) {
          return { issues: [{ message: "memx: throttleMinutes 必须是正数", path: ["throttleMinutes"] }] };
        }
        value.throttleMinutes = throttle;
      }
      return { value };
    },
  },
  /** 设置面热更新时只看这四个字段（等价 schemastery 的 `.volatile()`）。 */
  volatileKeys: ["provider", "model", "autoRefine", "throttleMinutes"] as const,
};

/** 插件级诊断：结构上是流水线诊断的超集，另加 DSH 特有的跳过原因。 */
export interface DshDiagnostics extends PipelineDiagnostics {
  injections: number;
  capturedTurns: number;
  toolWrites: number;
  notices: number;
  /** 轮末补记的跳过原因计数（便于真机定位"为什么没写"） */
  skipped: {
    throttle: number;
    written: number;
    empty: number;
    noModel: number;
    duplicate: number;
    /** autoRefine === false（用户关了自动提炼；显式 memory_write 不计这里） */
    disabled: number;
  };
}

interface SessionState {
  pipeline: SessionPipeline;
  /** 本轮 memory_write 次数（>0 → 轮末补记跳过） */
  writesThisTurn: number;
  /** 本轮已捕获的 assistant 文本与它所属的 turn */
  turnNumber: number | null;
  turnText: string;
  /** 已经处理过的 turn（同一轮重复事件 / 补记幂等） */
  markedTurn: number | null;
  lastRefineAt: number;
  /** 下一次 refineMemory 用的模型路由（resolve 后临时存放） */
  pendingRoute: DshModelRoute | null;
}

function emptyDiagnostics(): DshDiagnostics {
  return {
    refinements: 0,
    written: 0,
    failures: 0,
    lastError: "",
    updatedAt: new Date().toISOString(),
    injections: 0,
    capturedTurns: 0,
    toolWrites: 0,
    notices: 0,
    skipped: { throttle: 0, written: 0, empty: 0, noModel: 0, duplicate: 0, disabled: 0 },
  };
}

/** 从 assistant 消息里取文本（只取 text 块）。 */
function assistantText(data: unknown): string {
  const message = (data as { message?: { content?: unknown } } | undefined)?.message;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

function clampNotice(text: string): string {
  return text.length <= NOTICE_MAX_CHARS ? text : text.slice(0, NOTICE_MAX_CHARS - 1) + "…";
}

/**
 * 载入 `createUserMessage`（官方 `@deepseek-ai/dsh-llm`）。
 *
 * 为什么是动态 import + 变量 specifier：memx 不依赖宿主包（不 install），静态 import
 * 在 tsc 与运行时都过不去；而"手动拼 UserMessage 对象"是硬造（缺 id/source 语义）。
 * 因此这里**只尝试**用宿主自己的构造函数，解析不到就降级成只记诊断（issue 明确允许）。
 * 缓存 Promise：解析结果进程内只探一次。
 */
type UserMessageFactory = (input: { content: unknown; source: unknown }) => unknown;

let userMessageFactory: Promise<UserMessageFactory | null> | null = null;

function loadUserMessageFactory(): Promise<UserMessageFactory | null> {
  userMessageFactory ??= (async () => {
    try {
      const specifier = "@deepseek-ai/dsh-llm";
      const mod = (await import(specifier)) as { createUserMessage?: unknown };
      return typeof mod.createUserMessage === "function" ? (mod.createUserMessage as UserMessageFactory) : null;
    } catch {
      return null;
    }
  })();
  return userMessageFactory;
}

export function apply(ctx: DshContext, config: DshMemxConfig = {}): void {
  const diag = emptyDiagnostics();
  const alertStore = createFileAlertStore();
  const injectionCache = new InjectionSourceCache();
  const sessions = new Map<string, SessionState>();

  const log = (message: string): void => {
    try {
      ctx.logger?.warn?.(`[memx] ${message}`);
    } catch {
      // logging must never escape
    }
  };

  const recordFailure = (err: unknown): void => {
    diag.failures++;
    diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    diag.updatedAt = new Date().toISOString();
    log(diag.lastError.split("\n")[0] ?? "unknown failure");
  };

  /** 会话当前目录：优先活着的 Agent，其次宿主的兜底目录；都取不到返回空串。 */
  const cwdFor = (agent: DshAgent | undefined): string => {
    try {
      if (agent) return ctx.workingDirectory.get(agent.session);
    } catch {
      // fall through to the deployment default
    }
    return ctx.workingDirectory.defaultDirectory ?? "";
  };

  const slugFor = (agent: DshAgent | undefined): string => {
    try {
      return deriveSlug(cwdFor(agent));
    } catch {
      return "";
    }
  };

  // ── ① 注入 ────────────────────────────────────────────────────────────────
  /** 会话键 → 注入文本。**只会有键的装配才落进来**（无键绝不缓存，见 injectionTextFor）。 */
  const injectedText = new WeakMap<object, string>();

  const buildInjectionText = (agent: DshAgent | undefined): string => {
    try {
      const slug = slugFor(agent);
      // related 的匹配键取会话工作目录的末段（`/Users/x/workspace/memx` → `memx`）
      const built = buildInjectionParts(readInjectionSourcesForSlug(injectionCache, slug, cwdFor(agent)));
      return built.parts.map((part) => part.text).join("\n\n");
    } catch (err) {
      recordFailure(err);
      return "";
    }
  };

  /**
   * 每个会话只算一次：键取 `context.agent`（官方装配里 `scope` 与 `agent` 同一个对象）。
   * 之后同一会话的每次装配都拿同一串字节——文件后来变了也不重算（本会话新写的记忆
   * 本会话不可见，下一会话生效，这是 issue 拍板的语义）。
   *
   * ⚠️ 拿不到会话键时**绝不落缓存**：`agent`/`scope` 都缺失意味着这是全局兜底，
   * 一旦缓存就会所有会话共用一条文本（A 项目的小节串给 B 项目）。宁可每次重算
   * （slug 也取不到 → 只出协议 + 画像），也不能串项目。
   */
  const injectionTextFor = (context: DshAssembleContext | undefined): string => {
    try {
      const key = context?.agent ?? context?.scope;
      if (key === undefined) {
        diag.injections++;
        diag.updatedAt = new Date().toISOString();
        return buildInjectionText(context?.agent);
      }
      const cached = injectedText.get(key);
      if (cached !== undefined) return cached;
      const text = buildInjectionText(context?.agent);
      injectedText.set(key, text);
      diag.injections++;
      diag.updatedAt = new Date().toISOString();
      return text;
    } catch (err) {
      recordFailure(err);
      return "";
    }
  };

  try {
    ctx.systemPrompt.section({
      name: INJECT_SECTION_NAME,
      order: INJECT_SECTION_ORDER,
      // interpolate:false —— 注入正文里可能含 `{{...}}`（画像/记忆是自由文本），
      // 交给宿主做变量插值会抛"未知引用"，直接按字面量渲染。
      interpolate: false,
      text: (context: DshAssembleContext) => injectionTextFor(context),
    });
  } catch (err) {
    recordFailure(err);
  }

  // ── ② 工具：memory_write ──────────────────────────────────────────────────
  /** 每个会话一套流水线（缓冲、inFlight 闸门、节流全按会话隔离）。 */
  const stateFor = (sessionID: string | undefined): SessionState | null => {
    if (typeof sessionID !== "string" || sessionID === "") return null;
    const existing = sessions.get(sessionID);
    if (existing) return existing;

    let state: SessionState | undefined;
    const host: PipelineHost = {
      diag,
      // 目录随时可能被用户改：slug 每次现算，不冻结在构造时
      get slug() {
        return slugFor(ctx.agents?.get(sessionID));
      },
      loadConfig: loadMemxConfig,
      createLLM: () => {
        const route = state?.pendingRoute ?? null;
        if (route === null) throw new Error("memx: 提炼模型路由缺失");
        return createDshLLMClient(ctx.llm, route);
      },
      recordAlert: (level, code, message) => {
        alertStore.append({ level, code, message, ts: new Date().toISOString() });
      },
      persist: () => {
        // DSH 侧没有 kv 诊断面板：诊断留在内存，异常已经由 log() 落到宿主日志
      },
      decorateIndex: (content) => applyBreadcrumbLine(content, formatBreadcrumb(alertStore)),
    };

    state = {
      pipeline: new SessionPipeline(host),
      writesThisTurn: 0,
      turnNumber: null,
      turnText: "",
      markedTurn: null,
      lastRefineAt: 0,
      pendingRoute: null,
    };
    sessions.set(sessionID, state);
    return state;
  };

  const MEMORY_WRITE_DESCRIPTION =
    '记住一条项目记忆（用户说"这个记一下 / 记住 / 别忘了"时调用）。写进 canonical 记忆库 ~/.opencode/projects/<slug>/.mem/ 并更新 MEMORY.md 索引；同名同类型视为修订（更新）。';

  try {
    ctx.tools.register({
      name: "memory_write",
      description: MEMORY_WRITE_DESCRIPTION,
      // 原始 JSON Schema（与 opencode 那份逐字段对齐）
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: '要记住的事实本身（陈述句，≤500 字），不要写成"用户说……"' },
          type: {
            type: "string",
            enum: [...MEMORY_TYPES],
            description:
              "记忆类型：project（进行中的工作/约束）/ feedback（协作规则）/ reference（外部指针）/ user（项目内用户画像）；缺省 project",
          },
          name: { type: "string", description: "短标识（≤60 字），同名同类型会覆盖更新；缺省从 text 截取" },
          description: { type: "string", description: '"何时该读这条"的钩子，含可匹配关键词（≤150 字）；缺省取 text' },
          why: { type: "string", description: "为什么记（feedback/project 建议给，≤200 字）" },
          how_to_apply: { type: "string", description: "以后怎么用（feedback/project 建议给，≤200 字）" },
          evidence: { type: "string", description: "用户原话（≤200 字）" },
        },
        required: ["text"],
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            name: { type: "string" },
            message: { type: "string" },
          },
          required: ["ok", "name", "message"],
        },
        render(_args, value) {
          const text = (value as { message?: unknown } | undefined)?.message;
          return [{ type: "text", text: typeof text === "string" ? text : "[memx] memory_write" }];
        },
      },
      async execute(args, exec) {
        const input = (args ?? {}) as {
          text?: string;
          type?: string;
          name?: string;
          description?: string;
          why?: string;
          how_to_apply?: string;
          evidence?: string;
        };
        try {
          const slug = slugFor(exec?.agent);
          if (slug === "") {
            return { ok: false, name: "", message: "[memx] memory_write 失败：取不到会话工作目录" };
          }
          const result = await writeProjectMemory(
            slug,
            {
              text: input.text ?? "",
              ...(input.type !== undefined ? { type: input.type } : {}),
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.why !== undefined ? { why: input.why } : {}),
              ...(input.how_to_apply !== undefined ? { how_to_apply: input.how_to_apply } : {}),
              ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
            },
            formatBreadcrumb(alertStore),
          );
          if (!result.ok) {
            return { ok: false, name: "", message: `[memx] memory_write 失败：${result.error}` };
          }
          diag.toolWrites++;
          diag.written++;
          diag.updatedAt = new Date().toISOString();
          const state = stateFor(exec?.agent?.session?.id);
          if (state) state.writesThisTurn++;
          return { ok: true, name: result.name, message: `[memx] 已记住：${result.name}` };
        } catch (err) {
          recordFailure(err);
          return { ok: false, name: "", message: `[memx] memory_write 失败：${String(err)}` };
        }
      },
    });
  } catch (err) {
    recordFailure(err);
  }

  // ── ②b 工具：memory_search / forget（#24）──────────────────────────────────
  // 与 opencode 宿主同一份 core：检索走 `searchMemories`（原 mem CLI 的 cmdSearch
  // 上提到 core），遗忘走 `withFileLock` + `forgetMemory` + `writeMemoryIndex`。
  // 两者都是"模型可调"的只读/受控写入口，任何异常只能变成 `[memx] … 失败：…` 回执。
  const MEMORY_SEARCH_MAX_HITS = 20;
  const MEMORY_HIT_TEXT_MAX = 160;

  const truncateHit = (text: string): string =>
    text.length <= MEMORY_HIT_TEXT_MAX ? text : text.slice(0, MEMORY_HIT_TEXT_MAX - 1) + "…";

  /** slug 缺省 = 当前会话 cwd 推导（与注入同一规则）；`memory_search` 推导失败时退化成全库检索。 */
  const slugArgOrSession = (explicit: string | undefined, agent: DshAgent | undefined): string => {
    const trimmed = explicit?.trim();
    if (trimmed !== undefined && trimmed !== "") return trimmed;
    return slugFor(agent);
  };

  const TOOL_OUTPUT = {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        message: { type: "string" },
      },
      required: ["ok", "message"],
    },
    render(_args: unknown, value: unknown) {
      const text = (value as { message?: unknown } | undefined)?.message;
      return [{ type: "text", text: typeof text === "string" ? text : "[memx] 无输出" }];
    },
  };

  const MEMORY_SEARCH_DESCRIPTION =
    "检索记忆库（跨 .mem/*.md 全文、大小写不敏感），返回 file:line 与命中行。用户问“之前记过什么 / 有没有记过 X”时先查再答；缺省只查当前项目，可用 slug 指定别的项目。";

  try {
    ctx.tools.register({
      name: "memory_search",
      description: MEMORY_SEARCH_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "检索关键词（大小写不敏感；匹配标题 / hook / 正文任意一行）" },
          slug: { type: "string", description: "限定项目 slug；缺省用当前会话工作目录推导（与注入同一规则）" },
        },
        required: ["keyword"],
      },
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        const input = (args ?? {}) as { keyword?: string; slug?: string };
        try {
          const keyword = input.keyword ?? "";
          const slug = slugArgOrSession(input.slug, exec?.agent);
          // slug 推导不出来时不做"猜项目"：全库检索（只读，最坏是多给几条）
          const hits = searchMemories(keyword, slug === "" ? undefined : slug);
          if (hits.length === 0) {
            return { ok: true, message: `[memx] 未匹配：${keyword}` };
          }
          const shown = hits.slice(0, MEMORY_SEARCH_MAX_HITS);
          const lines = shown.map((hit) => `${hit.slug}/${hit.file}:${hit.line} — ${truncateHit(hit.text)}`);
          if (hits.length > shown.length) lines.push(`… 另有 ${hits.length - shown.length} 处未显示`);
          return { ok: true, message: lines.join("\n") };
        } catch (err) {
          recordFailure(err);
          return { ok: false, message: `[memx] memory_search 失败：${String(err)}` };
        }
      },
    });
  } catch (err) {
    recordFailure(err);
  }

  const FORGET_DESCRIPTION =
    '忘记匹配关键词的项目记忆（软删：文件移入 .mem/.trash 并从 MEMORY.md 索引移除）。用户说“忘掉 X / 删掉那条记忆”时调用；关键词按标题 / hook / 文件名匹配。';

  try {
    ctx.tools.register({
      name: "forget",
      description: FORGET_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "匹配记忆标题 / hook / 文件名的关键词" },
          slug: { type: "string", description: "限定项目 slug；缺省用当前会话工作目录推导（与注入同一规则）" },
        },
        required: ["keyword"],
      },
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        const input = (args ?? {}) as { keyword?: string; slug?: string };
        try {
          const keyword = (input.keyword ?? "").trim();
          if (keyword === "") {
            return { ok: false, message: "[memx] forget 失败：keyword 不能为空" };
          }
          const slug = slugArgOrSession(input.slug, exec?.agent);
          if (slug === "") {
            return { ok: false, message: "[memx] forget 失败：取不到会话工作目录" };
          }
          // 与 memory_write 同一把锁：读索引 → 遗忘 → 写索引，三步都在锁内，
          // 避免与提炼/其它宿主实例的 read-modify-write 互相覆盖。
          const removed = await withFileLock(memoryIndexLockPath(), () => {
            const existing = readMemoryIndex();
            const result = forgetMemory(keyword, existing, slug);
            if (result.removed.length > 0) {
              writeMemoryIndex(applyBreadcrumbLine(result.newIndex, formatBreadcrumb(alertStore)));
            }
            return result.removed;
          });
          if (removed.length === 0) {
            return { ok: false, message: `[memx] 未匹配：${keyword}` };
          }
          return { ok: true, message: `[memx] 已遗忘 ${removed.length} 条：${removed.join(", ")}` };
        } catch (err) {
          recordFailure(err);
          return { ok: false, message: `[memx] forget 失败：${String(err)}` };
        }
      },
    });
  } catch (err) {
    recordFailure(err);
  }

  // ── ③ 轮末补记 ────────────────────────────────────────────────────────────
  const queueNotice = async (agent: DshAgent | undefined, summary: string): Promise<void> => {
    if (!agent || typeof agent.inject !== "function") return;
    const factory = await loadUserMessageFactory();
    if (factory === null) {
      // 允许的降级（issue）：构造器不可得 → 只记诊断，绝不手搓消息
      log("createUserMessage 不可得，跳过「已记住」提示（写盘已完成）");
      return;
    }
    try {
      const text = clampNotice(summary);
      agent.inject(
        factory({
          content: [{ type: "text", text }],
          source: { kind: "memx", form: "notice", summary: text },
        }),
      );
      diag.notices++;
    } catch (err) {
      recordFailure(err);
    }
  };

  const runTurnEnd = async (
    session: DshSession,
    turn: number | null,
    turnText: string,
    state: SessionState,
  ): Promise<void> => {
    try {
      // 每次轮末现读配置：volatile 字段是**引用 cell**，设置页改完由宿主原位更新
      // （loader/volatile-update），这里若在 apply 时快照一次，改动就要等重启才生效。
      const settings = readConfig(config);

      // 用户关掉自动提炼：整段轮末补记跳过。显式 memory_write 在工具里独立处理，
      // 不经过这里，所以"说记住就记住"照旧。
      if (settings.autoRefine === false) {
        diag.skipped.disabled++;
        return;
      }

      if (turn !== null && state.markedTurn === turn) {
        diag.skipped.duplicate++;
        return;
      }
      state.markedTurn = turn;

      if (state.writesThisTurn > 0) {
        diag.skipped.written++;
        return;
      }

      const signals = captureMemorySignals(turnText);
      if (signals.length === 0) {
        diag.skipped.empty++;
        return;
      }
      diag.capturedTurns++;

      let coreConfig: MemxConfig;
      try {
        coreConfig = await loadMemxConfig();
      } catch {
        coreConfig = { throttleMinutes: DEFAULT_THROTTLE_MINUTES } as MemxConfig;
      }
      const throttleMinutes =
        typeof settings.throttleMinutes === "number" && settings.throttleMinutes > 0
          ? settings.throttleMinutes
          : coreConfig.throttleMinutes > 0
            ? coreConfig.throttleMinutes
            : DEFAULT_THROTTLE_MINUTES;
      const now = Date.now();
      if (now - state.lastRefineAt < throttleMinutes * 60_000) {
        diag.skipped.throttle++;
        return;
      }

      const agent = ctx.agents?.get(session.id);
      const route =
        resolveRoute(settings.provider, settings.model) ??
        resolveRoute(agent?.options?.provider, agent?.options?.model);
      if (route === null) {
        // 取不到就不猜（issue 明确：跳过并记一条诊断）
        diag.skipped.noModel++;
        log(`跳过轮末补记：取不到提炼模型（会话 ${session.id}）`);
        return;
      }

      state.lastRefineAt = now;
      state.pendingRoute = route;
      state.pipeline.memory.pushAll(signals);

      const before = diag.written;
      await state.pipeline.refineMemory(true);
      const written = diag.written - before;
      if (written > 0) {
        await queueNotice(agent, `[memx] 已记住 ${written} 条`);
      }
    } catch (err) {
      recordFailure(err);
    } finally {
      state.pendingRoute = null;
    }
  };

  try {
    ctx.on("session/event", (session: DshSession, event: DshSessionEvent) => {
      try {
        const type = event?.type;
        if (type !== "turn/start" && type !== "assistant/message" && type !== "turn/end") return;
        const data = event?.data as { turn?: unknown } | undefined;
        const turn = typeof data?.turn === "number" ? data.turn : null;
        const sessionID = session?.id;
        const state = stateFor(sessionID);
        if (!state) return;

        if (type === "turn/start") {
          // 新的一轮：清本轮写入计数与文本缓冲
          state.writesThisTurn = 0;
          state.turnNumber = turn;
          state.turnText = "";
          return;
        }

        if (type === "assistant/message") {
          if (state.turnNumber !== turn) {
            state.turnNumber = turn;
            state.turnText = "";
          }
          state.turnText += assistantText(event?.data);
          return;
        }

        // turn/end：后台补记，绝不 await（事件分发是同步调用）
        const turnText = state.turnNumber === turn ? state.turnText : "";
        state.turnText = "";
        queueMicrotask(() => {
          void runTurnEnd(session, turn, turnText, state);
        });
      } catch (err) {
        recordFailure(err);
      }
    });
  } catch (err) {
    recordFailure(err);
  }
}
