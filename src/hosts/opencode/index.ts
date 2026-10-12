// memx · opencode v2 插件壳（阶段 2，handoff-20261011 附录 A 施工图）
// 职责：事件订阅（session.idle/deleted）→ 信号捕获 → core 提炼 → 写盘；
//       工具注册（reflect/forget/memx_status，经 ctx.tool.transform）；
//       storage 结构化诊断（v2 无 app.log，#4 拍板）；
//       子会话提炼的 context hook 全局注册一次 + 活跃集合过滤（handoff 硬坑 7）。
// 红线：本文件只 export default 插件；所有 hook try-catch，错误绝不抛回宿主。
import { Plugin } from "@opencode/plugin";
import { SignalBuffer, captureSignals } from "../../core/signals/signal-capture";
import { refine } from "../../core/refine/refinement";
import type { LLMClient } from "../../core/refine/refinement";
import { createSessionLLMClient } from "./session-llm";
import {
  readUserMd,
  writeUserMd,
  applyProposal,
  isOverLimit,
  parseUserMd,
  serializeUserMd,
  backupUserMd,
} from "../../core/store/user-md";
import { loadMemxConfig } from "../../core/config";
import type { MemxConfig } from "../../core/config";
import { shouldRun, markRun } from "../../core/llm/throttle";
import { MemorySignalBuffer, captureMemorySignals } from "../../core/signals/memory-capture";
import { refineMemory } from "../../core/refine/memory-refinement";
import { readMemoryIndex, writeMemoryIndex, applyMemoryProposal, forgetMemory } from "../../core/store/memory-md";
import { deriveSlug } from "../../core/memory-types";
import { runHealthCheck, autoFix, formatHealthLog } from "../../core/health/memory-health";
import { describeGate, DEFAULT_AGENT_GATE } from "../../core/injection";
import type { AgentGate } from "../../core/injection";
import { InjectionSourceCache, readInjectionSources } from "../../core/injection-source";
import { applyContextHook } from "./context-hook";
import type { ContextHookEvent } from "./context-hook";

/** v2 消息形状 / 归一 / 最后一轮提取 → 共享模块（index.ts 与 session-llm.ts 都依赖，
 *  不能互相 import，故放 context-shape.ts） */
import { toMessages, extractLastTurn } from "./context-shape";

export default Plugin.define({
  id: "memx",
  async setup(ctx) {
    const buffer = new SignalBuffer();
    const memoryBuffer = new MemorySignalBuffer();
    // 活跃子会话集合：sessionID → system 提炼提示词（context hook 按 ∈ 集合过滤）
    const childSessions = new Map<string, string>();
    // memx 自己的提炼子会话 ID（活到它的 session.deleted 事件被消费）——见事件循环注释
    const childSessionIds = new Set<string>();
    let refinementInFlight = false;
    let currentSlug = deriveSlug(ctx.location.directory ?? "");
    const controller = new AbortController();
    // 诊断键按目录隔离：#82 实测 ctx.storage 的键是全局的，多 serve / 多目录的 memx 实例
    // 会互相覆盖同一行（lastCapture/lastError 被后写者抹掉）。slug 需在 persistDiag 定义前算好。
    const diagKey = "diag:" + currentSlug;


    // #4 拍板：v2 无 app.log → ctx.storage 结构化诊断（memx_status / memx doctor 消费）
    type Diag = {
      captured: number;
      refinements: number;
      written: number;
      failures: number;
      version?: string;
      lastError: string;
      evtCounts?: Record<string, number>;
      rawInbox?: string;
      rawTextEnded?: string;
      /** 无最后一轮时采到的 session.context 原始返回（截断 400 字），用于非静默定位 */
      rawContext?: string;
      lastCapture?: {
        userLen: number;
        assistantLen: number;
        styleHit: boolean;
        signalCount: number;
        sessionID: string;
        /** 本次看到的消息条数 */
        msgCount: number;
        /** session.context 返回形状（array=v2 SDK 数组本身 / envelope=旧信封 / other） */
        ctxShape: "array" | "envelope" | "other";
      };
      /** 注入诊断（context hook 的每 step 行为 + 装配结果） */
      injection?: {
        /** hook 触发总次数（含子会话分支） */
        hookFires: number;
        /** 真正往 event.system 追加了内容的次数 */
        injections: number;
        /** 命中子会话分支（整体替换 system）——这些绝不该被注入 */
        childSessions: number;
        /** 被 agent 闸门挡下的次数 */
        gated: number;
        /** 三块内容全缺 → 什么都没注入的次数 */
        empty: number;
        /** 累计截断次数（按来源计） */
        truncations: number;
        /** 最近一次注入的每来源事实 */
        sources?: Record<string, { lines: number; bytes: number; truncated: boolean }>;
        /** 最近一次注入的总字节数 */
        lastBytes?: number;
        /** 最近一次注入时命中的 agent */
        lastAgent?: string;
        /** 生效中的闸门（人话） */
        gate?: string;
      };
      updatedAt: string;
    };
    const diag: Diag = {
      version: "v2-e2e-3+inject",
      captured: 0,
      refinements: 0,
      written: 0,
      failures: 0,
      lastError: "",
      injection: {
        hookFires: 0,
        injections: 0,
        childSessions: 0,
        gated: 0,
        empty: 0,
        truncations: 0,
      },
      updatedAt: new Date().toISOString(),
    };
    const persistDiag = async (): Promise<void> => {
      try {
        await ctx.storage.set(diagKey, { ...diag });
      } catch {
        // diagnostics must never escape
      }
    };
    void persistDiag();

    // 一次性迁移：旧版把诊断写在全局 "diag" 行上。作用域键首次出现时以旧值为种子，
    // 免得升级后计数器看起来被清零（仅当作用域键尚不存在时读旧值，之后互不干扰）。
    void (async () => {
      try {
        const scoped = await ctx.storage.get(diagKey);
        if (scoped) return;
        const legacy = (await ctx.storage.get("diag")) as Partial<Diag> | undefined;
        if (!legacy) return;
        const { injection, ...rest } = legacy;
        Object.assign(diag, rest);
        // 旧行没有 injection 字段（或字段不全）：按缺省补齐，绝不把已记的计数抹成 undefined
        if (injection) Object.assign(diag.injection!, injection);
        await persistDiag();
      } catch {
        // migration must never escape
      }
    })();

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function runRefinement(_sessionID: string, force = false): Promise<string> {
      if (buffer.length === 0) return "[memx] 无信号，跳过";

      const config = await loadMemxConfig();
      if (!force && !shouldRun(config.throttleMinutes)) return "[memx] 节流中，跳过";

      if (refinementInFlight) {
        if (!force) return "[memx] 提炼进行中，跳过";
        while (refinementInFlight) await sleep(200);
      }
      refinementInFlight = true;
      try {
        markRun();
        diag.refinements++;
        const signals = buffer.getAll();
        const existingContent = readUserMd();
        const llm: LLMClient = createSessionLLMClient(ctx, config.refinementModel, {
          onCreated: (id, system) => {
            childSessions.set(id, system);
            childSessionIds.add(id);
          },
          onRemoved: (id) => {
            childSessions.delete(id);
          },
        });
        const proposals = await refine(signals, llm, existingContent, config.refinementModel);

        if (proposals.length === 0) {
          return "[memx] 无可提炼偏好";
        }

        let content = existingContent;
        for (const proposal of proposals) {
          content = applyProposal(proposal, content);
        }

        if (isOverLimit(content)) {
          backupUserMd();
          content = serializeUserMd(parseUserMd(content));
        }

        writeUserMd(content);
        buffer.clear();
        diag.written += proposals.length;
        diag.updatedAt = new Date().toISOString();
        void persistDiag();

        return `[memx] 已写入 ${proposals.length} 条`;
      } catch (err) {
        diag.failures++;
        diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        diag.updatedAt = new Date().toISOString();
        void persistDiag();
        throw err;
      } finally {
        refinementInFlight = false;
      }
    }

    async function runMemoryRefinement(_sessionID: string, force = false): Promise<string> {
      if (memoryBuffer.length === 0) return "[memx] 无记忆信号，跳过";

      const config = await loadMemxConfig();
      if (!force && !shouldRun(config.throttleMinutes)) return "[memx] 节流中，跳过";

      if (refinementInFlight) {
        if (!force) return "[memx] 提炼进行中，跳过";
        while (refinementInFlight) await sleep(200);
      }
      refinementInFlight = true;
      try {
        markRun();
        diag.refinements++;
        const signals = memoryBuffer.getAll();
        const existingIndex = readMemoryIndex();
        const llm: LLMClient = createSessionLLMClient(ctx, config.refinementModel, {
          onCreated: (id, system) => {
            childSessions.set(id, system);
            childSessionIds.add(id);
          },
          onRemoved: (id) => {
            childSessions.delete(id);
          },
        });
        const proposals = await refineMemory(signals, llm, existingIndex, config.refinementModel);

        if (proposals.length === 0) {
          return "[memx] 无可提炼记忆";
        }

        let indexContent = existingIndex;
        for (const proposal of proposals) {
          indexContent = applyMemoryProposal(proposal, indexContent, currentSlug);
        }

        writeMemoryIndex(indexContent);
        memoryBuffer.clear();

        // Run health check + auto-fix (dead links, orphan files)
        let healthMsg = "";
        try {
          const report = runHealthCheck(indexContent, currentSlug);
          if (report.deadLinks.length > 0 || report.orphanFiles.length > 0 || report.escalated.length > 0) {
            const { newIndex, logs } = autoFix(report, indexContent, currentSlug);
            if (logs.length > 0) {
              writeMemoryIndex(newIndex + "\n" + formatHealthLog(logs));
              healthMsg = `, health: ${logs.length} fixes`;
            }
          }
        } catch {
          // health check must never block refinement
        }

        diag.written += proposals.length;
        diag.updatedAt = new Date().toISOString();
        void persistDiag();

        return `[memx] 已写入 ${proposals.length} 条记忆${healthMsg}`;
      } catch (err) {
        diag.failures++;
        diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        diag.updatedAt = new Date().toISOString();
        void persistDiag();
        throw err;
      } finally {
        refinementInFlight = false;
      }
    }

    // #82 实测定案：取消息用 ctx.session.context（SessionDomain 确认方法，返回完整
    // messages）——rpc message.list 宿主未注册、inbox.delivered 无负载（均实测）。
    // 注意 v2 SDK 返回的是消息数组本身（不是 {messages:[...]} 信封），故一律过 toMessages。
    async function captureFromSession(sessionID: string): Promise<void> {
      const raw = await ctx.session.context({ sessionID });
      const { shape, msgs } = toMessages(raw);
      const last = extractLastTurn(msgs);
      if (!last) {
        // 非静默：无最后一轮也留痕（#82 阻塞点正是"信封误判 → 静默早退 → 永不 persist"）
        diag.lastCapture = {
          userLen: 0,
          assistantLen: 0,
          styleHit: false,
          signalCount: 0,
          sessionID,
          msgCount: msgs.length,
          ctxShape: shape,
        };
        diag.rawContext = JSON.stringify(raw ?? null).slice(0, 400);
        diag.updatedAt = new Date().toISOString();
        void persistDiag();
        return;
      }
      const signals = captureSignals(last.user, last.assistant);
      buffer.pushAll(signals);
      const memSignals = captureMemorySignals(last.assistant);
      memoryBuffer.pushAll(memSignals);
      diag.captured += signals.length + memSignals.length;
      diag.lastCapture = {
        userLen: last.user.length,
        assistantLen: last.assistant.length,
        styleHit: /STYLE_SIGNAL/.test(last.assistant),
        signalCount: signals.length,
        sessionID,
        msgCount: msgs.length,
        ctxShape: shape,
      };
      diag.updatedAt = new Date().toISOString();
      void persistDiag();
    }

    async function flushAll(sessionID: string, force: boolean): Promise<void> {
      await runRefinement(sessionID, force);
      await runMemoryRefinement(sessionID, force);
    }

    // 事件订阅：session.execution.succeeded（捕获+提炼——#82 实测 v2 不发 session.idle，
    // 每轮必发的是 execution.succeeded，语义=回合结束即捕获时机，用户 2026-10-11 拍板）/
    // session.deleted（清登记）。v2 负载是 event.data.sessionID（handoff 硬坑 8）。
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const type = event.type as string;
            // #82 端到端诊断：按类型计数 + 采样 data 形状（定位缓存未填充问题）
            diag.evtCounts = diag.evtCounts ?? {};
            diag.evtCounts[type] = (diag.evtCounts[type] ?? 0) + 1;
            const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID as string;
            if (!sessionID) {
              if (!diag.rawInbox) diag.rawInbox = "NO_SESSION_ID:" + JSON.stringify(event.data ?? null).slice(0, 300);
              void persistDiag();
              continue;
            }
            if (type !== "session.execution.succeeded" && type !== "session.deleted") continue;
            // 提炼子会话的 ID 单独记一份：childSessions 在 session-llm 的 finally 里
            // （remove 之后）就被清掉了，而 session.deleted 事件到得更晚——只看
            // childSessions 会把"自己删掉自己的子会话"当成用户删会话，且这一支 force=true
            // 会自激成无限循环（#82 实测 10s 内生成 106 个子会话）。这里必须用能活到
            // deleted 事件被消费掉的那个集合，命中后连同 childSessions 一起清理。
            if (childSessionIds.has(sessionID)) {
              if (type === "session.deleted") {
                childSessionIds.delete(sessionID);
                childSessions.delete(sessionID);
              }
              continue;
            }
            if (type === "session.execution.succeeded") {
              await captureFromSession(sessionID);
            }
            await flushAll(sessionID, type === "session.deleted");
          } catch (err) {
            diag.failures++;
            diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
            diag.updatedAt = new Date().toISOString();
            void persistDiag();
            // errors must never escape the loop
          }
        }
      } catch (err) {
        diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        void persistDiag();
      }
    })();

    // 注入配置（闸门）：setup 时先读一次，之后按 TTL 重读——hook 回调本身是同步的，
    // 而 loadMemxConfig 是异步的，所以不能每次触发都 await（那会把 IO 拖进每 step 路径）。
    // 闸门变化极低频（改配置），30s TTL 足够，且改完 30 秒内必生效，不必重启宿主。
    let injectGate: AgentGate = DEFAULT_AGENT_GATE;
    const INJECT_GATE_TTL_MS = 30_000;
    const INJECT_PERSIST_TTL_MS = 5_000;
    let lastInjectPersistAt = 0;
    const injectCache = new InjectionSourceCache();
    const ensureInjectGate = (config?: MemxConfig): void => {
      if (config) injectGate = config.inject;
      if (diag.injection) diag.injection.gate = describeGate(injectGate);
    };
    // 启动时立刻把闸门读进内存（失败静默：默认全开就是既有行为）。之后按 TTL 后台重读——
    // hook 回调是同步的，不能在里面 await；改配置 30 秒内生效，不必重启宿主。
    const reloadGate = (): void => {
      void loadMemxConfig().then(
        (config) => ensureInjectGate(config),
        () => {},
      );
    };
    reloadGate();
    const gateTimer = setInterval(reloadGate, INJECT_GATE_TTL_MS);
    // 定时器不该拖住宿主退出（unref 在 Node 与 Bun 上都有；没有就退化成普通 setInterval）
    (gateTimer as { unref?: () => void }).unref?.();

    /** 子会话提炼的组装管线钩子：全局注册一次 + 活跃集合过滤（handoff 硬坑 7）。
     * 命中时整体替换 system（不是 push——v2 body.system 是替换语义）、temperature 0.2。
     * ⚠️ 不要再清空 tools（event.tools = {}）：#82 实测会让孩子会话的模型请求被 free tier
     * 拒绝——finish:"error" + error.type:"provider.auth" status:403
     * {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}，
     * content 为空数组，refine() 收到 "" → JSON 解析失败 → 永远不写盘。
     * 证据：toolsBefore=13 → toolsAfter=0 即 403；保留 tools（13）则 finish:"stop" 且有正文。
     * 改用 system 替换约束输出（提炼提示词已要求"只输出 JSON 数组"），不要靠清空 tools。
     *
     * 两条分支互斥且顺序固定：**先判子会话**。子会话是 memx 自己的提炼调用，注入一旦漏进去
     * 就污染提炼输入（协议 + 画像 + 索引全在里面），既让提炼质量塌掉，也是 #82 那类 403 的高危区。
     * 非子会话才走注入，且只 **append**：`event.system` 此时已经装着 agent.system 和 AGENTS.md
     * 正文（model-request.ts:110-116），替换会连宿主内容一起抹掉。
     */
    ctx.session
      .hook("context", (event) => {
        try {
          const inj = diag.injection;
          if (inj) inj.hookFires++;

          const outcome = applyContextHook(
            event as unknown as ContextHookEvent,
            { childSessions, gate: injectGate, readSources: () => readInjectionSources(injectCache) },
          );

          if (outcome.kind === "child" || outcome.kind === "gated" || outcome.kind === "empty") {
            if (inj) {
              if (outcome.kind === "child") inj.childSessions++;
              else if (outcome.kind === "gated") inj.gated++;
              else inj.empty++;
            }
            return;
          }

          if (inj) {
            inj.injections++;
            inj.truncations += outcome.facts.filter((f) => f.truncated).length;
            inj.lastBytes = outcome.totalBytes;
            if (outcome.agent !== undefined) inj.lastAgent = outcome.agent;
            inj.sources = Object.fromEntries(
              outcome.facts.map((f) => [f.id, { lines: f.lines, bytes: f.bytes, truncated: f.truncated }]),
            ) as Record<string, { lines: number; bytes: number; truncated: boolean }>;
            inj.gate = describeGate(injectGate);
            diag.updatedAt = new Date().toISOString();
            // hook 是每 step 触发的，逐次落盘会把 kv 写放大成"每步一次 sqlite 写"。
            // 计数器在内存里始终是最新的（memx_status 与 dispose 都会落），磁盘只做节流快照。
            const now = Date.now();
            if (now - lastInjectPersistAt > INJECT_PERSIST_TTL_MS) {
              lastInjectPersistAt = now;
              void persistDiag();
            }
          }
        } catch {
          // hook must never escape
        }
      })
      .catch(() => {
        // hook registration must never crash setup
      });

    // 工具注册（阶段 2）：reflect / forget / memx_status（handoff §4 阶段 2）
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "reflect",
        description: "手动触发 User Style + Project Memory 提炼（当 session.idle 未触发时使用）",
        input: { type: "object", properties: {}, required: [] },
        async execute(_input, toolCtx) {
          try {
            await captureFromSession(toolCtx.sessionID);
            const styleResult = await runRefinement(toolCtx.sessionID, true);
            const memoryResult = await runMemoryRefinement(toolCtx.sessionID, true);
            return { content: `${styleResult} | ${memoryResult}` };
          } catch (err) {
            return { content: `[memx] 失败: ${String(err)}` };
          }
        },
      });

      editor.add({
        name: "forget",
        description:
          "Forget project memories matching a keyword. Moves matching .mem/*.md files to .trash and removes their index entries. Use when user says 'forget/忘记/记住删除 X'.",
        input: {
          type: "object",
          properties: { keyword: { type: "string", description: "Search keyword to match memory title, hook, or filename" } },
          required: ["keyword"],
        },
        async execute(args) {
          const keyword = (args as { keyword?: string }).keyword ?? "";
          try {
            if (!keyword.trim()) return { content: "[memx] forget: keyword is required" };
            const existingIndex = readMemoryIndex();
            const { newIndex, removed } = forgetMemory(keyword, existingIndex, currentSlug);
            if (removed.length === 0) {
              return { content: `[memx] forget: no memories matched "${keyword}"` };
            }
            writeMemoryIndex(newIndex);
            return { content: `[memx] forgot ${removed.length} memories: ${removed.join(", ")}` };
          } catch (err) {
            return { content: `[memx] forget failed: ${String(err)}` };
          }
        },
      });

      editor.add({
        name: "memx_status",
        description:
          "Show memx structured diagnostics: capture/refinement/written counters, failures, last error, and system-prompt injection facts.",
        input: { type: "object", properties: {}, required: [] },
        async execute() {
          try {
            const stored = (await ctx.storage.get(diagKey)) as Partial<Diag> | undefined;
            const d = { ...diag, ...(stored ?? {}) };
            const lines = [
              `[memx] 诊断`,
              `captured: ${d.captured}`,
              `refinements: ${d.refinements}`,
              `written: ${d.written}`,
              `failures: ${d.failures}`,
              `lastError: ${d.lastError || "无"}`,
            ];
            // 注入事实：hook 触发数远大于注入数（子会话 + 闸门挡下 + 全缺都算触发不注入），
            // 只印 injections 会让人以为"注入没生效"，所以四个计数一起印。
            const inj = d.injection;
            lines.push(
              `inject.hookFires: ${inj?.hookFires ?? 0}`,
              `inject.injections: ${inj?.injections ?? 0}`,
              `inject.childSessions: ${inj?.childSessions ?? 0}`,
              `inject.gated: ${inj?.gated ?? 0}`,
              `inject.empty: ${inj?.empty ?? 0}`,
              `inject.truncations: ${inj?.truncations ?? 0}`,
              `inject.lastBytes: ${inj?.lastBytes ?? 0}`,
              `inject.gate: ${inj?.gate ?? "unknown"}`,
              `inject.sources: ${
                inj?.sources && Object.keys(inj.sources).length > 0
                  ? Object.entries(inj.sources)
                      .map(([k, v]) => `${k}=${v.lines}L/${v.bytes}B${v.truncated ? "(truncated)" : ""}`)
                      .join(" ")
                  : "无"
              }`,
            );
            lines.push(`updatedAt: ${d.updatedAt}`);
            return { content: lines.join("\n") };
          } catch (err) {
            return { content: `[memx] status failed: ${String(err)}` };
          }
        },
      });
    });

    // Cleanup = () => Promise<void> | void（flush on exit, never throw）
    return async () => {
      try {
        await flushAll("", true);
      } catch {
        // flush on exit, never throw
      }
      // 注入计数被 5s 节流挡在内存里的部分，在这里落盘（dispose 是最后一个机会）
      try {
        await persistDiag();
      } catch {
        // persist on exit, never throw
      }
      buffer.clear();
      memoryBuffer.clear();
      injectCache.clear();
      clearInterval(gateTimer);
      controller.abort();
    };
  },
});
