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
  applyProposals,
  isOverLimit,
  parseUserMd,
  serializeUserMd,
  backupUserMd,
} from "../../core/store/user-md";
import { userMdLockPath, memoryIndexLockPath, withFileLock } from "../../core/store/lock";
import { loadMemxConfig } from "../../core/config";
import type { MemxConfig } from "../../core/config";
import { shouldRun, markRun } from "../../core/llm/throttle";
import { MemorySignalBuffer, captureMemorySignals } from "../../core/signals/memory-capture";
import { refineMemory } from "../../core/refine/memory-refinement";
import { readMemoryIndex, writeMemoryIndex, applyMemoryProposals, forgetMemory } from "../../core/store/memory-md";
import { deriveSlug, MEMORY_TYPES } from "../../core/memory-types";
import { writeProjectMemory, applyBreadcrumbLine } from "../../core/memory-write";
import { createSync } from "../../core/sync";
import type { SyncModule } from "../../core/sync";
import { runHealthMaintenance, formatHealthLog } from "../../core/health/memory-health";
import type { AutoFixLog } from "../../core/health/memory-health";
import { INVALID_OUTPUT_STREAK_LIMIT } from "../../core/refine/refine-outcome";
import { describeGate, DEFAULT_AGENT_GATE } from "../../core/injection";
import type { AgentGate } from "../../core/injection";
import { InjectionSourceCache, readInjectionSources } from "../../core/injection-source";
import { applyContextHook } from "./context-hook";
import type { ContextHookEvent } from "./context-hook";

/** v2 消息形状 / 归一 / 轮次提取 → 共享模块（index.ts 与 session-llm.ts 都依赖，
 *  不能互相 import，故放 context-shape.ts） */
import { toMessages, planCapture } from "./context-shape";
import { createFileAlertStore, formatBreadcrumb } from "../../core/alerts";

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
    // 报警单一事实源（阶段 4）：文件存储 ~/.opencode/memx-alerts.json，
    // recordAlert / memx_status / MEMORY.md 面包屑都走它。
    const alertStore = createFileAlertStore();

    // ---- 多机云同步（阶段 4 第二半）：默认关；enabled && machineName 才启动 ----
    // 不满足就跳过（diag 记一行配置事实，不报警）。配置在 setup 读一次——开启 sync 需重启宿主。
    const initialConfig = await loadMemxConfig();
    let sync: SyncModule | null = null;
    let syncTimer: ReturnType<typeof setInterval> | null = null;
    if (initialConfig.sync.enabled && initialConfig.sync.machineName !== "") {
      sync = createSync({ config: initialConfig.sync, alerts: alertStore });
      void sync.pull();
      syncTimer = setInterval(() => void sync?.pull(), initialConfig.sync.intervalMinutes * 60_000);
      // 定时器不该拖住宿主退出（与注入闸门定时器同一处理）
      (syncTimer as { unref?: () => void }).unref?.();
    }


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
        /** P0-1 增量游标：fresh=首次扫 / resumed=按游标续扫 / anchor-lost=游标锚点丢了（压缩/分叉）改全扫 */
        cursor?: "fresh" | "resumed" | "anchor-lost";
        /** 本次新扫到的轮次数 */
        newTurns?: number;
      };
      /** P0-2：连续 invalid-output 次数（按轨道），≥limit 丢弃缓冲并记报警 */
      invalidStreak?: { style: number; memory: number };
      /** P0-3：最近一批提案的定位告警（anchor 降级/未命中） */
      lastWarnings?: string[];
      /** 出口①：显式写入（memory_write 工具）的次数与最近一次事实 */
      toolWrites?: number;
      lastWrite?: {
        name: string;
        type: string;
        filename: string;
        action: "append" | "update";
        sessionID: string;
        at: string;
      };
      /** P0-5：健康检查结果（日志不再写进 MEMORY.md，改落这里） */
      health?: { fixes: number; escalated: number; lastLog: string; updatedAt: string };
      /** 轻量报警账本（阶段 4 的 core/alerts 接管前的落点，最多 20 条） */
      alerts?: Array<{ level: "info" | "warn" | "critical"; code: string; message: string; ts: string }>;
      /** 云同步（阶段 4 第二半）：只记一行配置事实（不报警；默认关，开需 machineName + 重启宿主） */
      sync?: { enabled: boolean; machineName: string };
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
      version: "v2-p0-1",
      captured: 0,
      refinements: 0,
      written: 0,
      failures: 0,
      lastError: "",
      invalidStreak: { style: 0, memory: 0 },
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
    // 云同步配置事实（一行，不报警）——sync 模块在 alertStore 之后、此处之前创建
    diag.sync = { enabled: initialConfig.sync.enabled, machineName: initialConfig.sync.machineName };
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

    // ---- P0-1：per-session 增量游标（存 ctx.storage，键按 sessionID 隔离）----
    // 为什么不用"扫最后一轮"：长会话中间轮次的 SIGNAL 会整段丢（事件漏拍 / 一次 execution
    // 跨多轮 / 客户端批量提交）。为什么不用 message.list 游标：v2 宿主未注册该 rpc
    // （#82 实测）。所以游标锚在**消息 id** 上——session.context 每条消息都带 id，
    // 找不到锚点（压缩/分叉把消息裁掉了）就退回全量扫，靠缓冲的 evidence 去重兜底。
    type SessionCursor = {
      lastMessageId?: string;
      scanned: number;
      anchorLost: boolean;
      updatedAt: string;
    };
    const cursorKey = (sessionID: string): string => "cursor:" + sessionID;

    async function readCursor(sessionID: string): Promise<SessionCursor | undefined> {
      try {
        return (await ctx.storage.get(cursorKey(sessionID))) as SessionCursor | undefined;
      } catch {
        return undefined; // 游标读失败 → 当成首次扫（宁可重扫，不可漏扫；缓冲有去重）
      }
    }

    async function writeCursor(sessionID: string, cursor: SessionCursor): Promise<void> {
      try {
        await ctx.storage.set(cursorKey(sessionID), cursor);
      } catch {
        // 游标写失败不能影响捕获：下一轮重扫，缓冲 evidence 去重
      }
    }

    function recordAlert(level: "info" | "warn" | "critical", code: string, message: string): void {
      const ts = new Date().toISOString();
      // 阶段 4：报警写文件存储（单一事实源），diag.alerts 保留为只写镜像（老 kv 消费端不破）
      alertStore.append({ level, code, message, ts });
      diag.alerts = diag.alerts ?? [];
      diag.alerts.push({ level, code, message, ts });
      if (diag.alerts.length > 20) diag.alerts = diag.alerts.slice(-20);
    }

    /** 写 MEMORY.md 前加面包屑：移除旧 `<!-- memx:` 行，有 warn/critical 时在顶部插新面包屑。
     *  只有那一行面包屑，不写健康日志/报警列表。空串则不写。
     *  摘行/置顶逻辑在 core 的 applyBreadcrumbLine（与 memory_write 工具路径共用一份实现）。 */
    function applyAlertBreadcrumb(content: string): string {
      return applyBreadcrumbLine(content, formatBreadcrumb(alertStore));
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
        const outcome = await refine(signals, llm, existingContent, config.refinementModel);

        // P0-2：坏输出 → 保留缓冲重试；连续 N 次仍坏 → 丢弃缓冲 + 记报警（防坏模型无限循环）
        if (outcome.kind === "invalid-output") {
          const streak = (diag.invalidStreak ??= { style: 0, memory: 0 });
          streak.style++;
          diag.lastError = `[style invalid-output #${streak.style}] ${outcome.error}\nraw: ${outcome.rawSnippet}`;
          diag.updatedAt = new Date().toISOString();
          if (streak.style >= INVALID_OUTPUT_STREAK_LIMIT) {
            recordAlert(
              "critical",
              "REFINEMENT_FAILURE_STREAK",
              `style 提炼连续 ${streak.style} 次输出无效，丢弃 ${buffer.length} 条缓冲：${outcome.error.slice(0, 120)}`,
            );
            streak.style = 0;
            buffer.clear();
            void persistDiag();
            return `[memx] 提炼输出连续 ${INVALID_OUTPUT_STREAK_LIMIT} 次无效，已丢弃缓冲`;
          }
          void persistDiag();
          return `[memx] 提炼输出无效（第 ${streak.style}/${INVALID_OUTPUT_STREAK_LIMIT} 次），保留缓冲重试`;
        }
        if (diag.invalidStreak) diag.invalidStreak.style = 0;

        // P0-2：合法空数组/全被过滤 = LLM 已裁决"不值得存" → 清缓冲结案
        if (outcome.kind === "adjudicated-empty") {
          buffer.clear();
          diag.updatedAt = new Date().toISOString();
          void persistDiag();
          return `[memx] 无可提炼偏好（${outcome.reason}，已结案）`;
        }

        const proposals = outcome.proposals;

        // P0-4 + P0-3：锁内**重读**当前文件 → 单遍应用整批 proposal → 单次写盘。
        // 锁只包住 read-modify-write（LLM 调用在锁外，绝不能持锁等模型）；
        // 重读是为了消掉"快照读 → 写盘"窗口里别的 memx 实例写进来的条目。
        const applied = await withFileLock(userMdLockPath(), () => {
          let content = readUserMd();
          const result = applyProposals(proposals, content);
          content = result.content;
          if (isOverLimit(content)) {
            backupUserMd();
            content = serializeUserMd(parseUserMd(content));
          }
          writeUserMd(content);
          return result;
        });

        buffer.clear();
        diag.written += proposals.length;
        if (applied.warnings.length > 0) diag.lastWarnings = applied.warnings.slice(-10);
        diag.updatedAt = new Date().toISOString();
        void persistDiag();

        const warnNote = applied.warnings.length > 0 ? `（${applied.warnings.length} 条定位告警）` : "";
        return `[memx] 已写入 ${proposals.length} 条${warnNote}`;
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
        const outcome = await refineMemory(signals, llm, existingIndex, config.refinementModel);

        if (outcome.kind === "invalid-output") {
          const streak = (diag.invalidStreak ??= { style: 0, memory: 0 });
          streak.memory++;
          diag.lastError = `[memory invalid-output #${streak.memory}] ${outcome.error}\nraw: ${outcome.rawSnippet}`;
          diag.updatedAt = new Date().toISOString();
          if (streak.memory >= INVALID_OUTPUT_STREAK_LIMIT) {
            recordAlert(
              "critical",
              "REFINEMENT_FAILURE_STREAK",
              `memory 提炼连续 ${streak.memory} 次输出无效，丢弃 ${memoryBuffer.length} 条缓冲：${outcome.error.slice(0, 120)}`,
            );
            streak.memory = 0;
            memoryBuffer.clear();
            void persistDiag();
            return `[memx] 记忆提炼输出连续 ${INVALID_OUTPUT_STREAK_LIMIT} 次无效，已丢弃缓冲`;
          }
          void persistDiag();
          return `[memx] 记忆提炼输出无效（第 ${streak.memory}/${INVALID_OUTPUT_STREAK_LIMIT} 次），保留缓冲重试`;
        }
        if (diag.invalidStreak) diag.invalidStreak.memory = 0;

        if (outcome.kind === "adjudicated-empty") {
          memoryBuffer.clear();
          diag.updatedAt = new Date().toISOString();
          void persistDiag();
          return `[memx] 无可提炼记忆（${outcome.reason}，已结案）`;
        }

        const proposals = outcome.proposals;

        // P0-4 + P0-3 + P0-5：一把锁内完成"重读索引 → 单遍应用提案 → 健康维护 → 单次写盘"。
        // 健康日志只回传给诊断（P0-5），**不再追加 HTML 注释到 MEMORY.md**——那正是被下一次
        // 序列化吃掉的那份日志。
        const applied = await withFileLock(memoryIndexLockPath(), () => {
          const result = applyMemoryProposals(proposals, readMemoryIndex(), currentSlug);
          let indexContent = result.content;
          let healthLogs: AutoFixLog[] = [];
          let escalated = 0;
          try {
            const maintenance = runHealthMaintenance(indexContent, currentSlug);
            indexContent = maintenance.index;
            healthLogs = maintenance.logs;
            escalated = maintenance.report.escalated.length;
          } catch {
            // health check must never block refinement
          }
          writeMemoryIndex(applyAlertBreadcrumb(indexContent));
          return { warnings: result.warnings, healthLogs, escalated };
        });

        memoryBuffer.clear();
        diag.written += proposals.length;
        if (applied.warnings.length > 0) diag.lastWarnings = applied.warnings.slice(-10);
        if (applied.healthLogs.length > 0 || applied.escalated > 0) {
          diag.health = {
            fixes: applied.healthLogs.filter((l) => l.action !== "escalated-manual").length,
            escalated: applied.escalated,
            lastLog: formatHealthLog(applied.healthLogs).split("\n").slice(-5).join("\n"),
            updatedAt: new Date().toISOString(),
          };
          if (applied.escalated > 0) {
            recordAlert("warn", "HEALTH_ESCALATED", `MEMORY.md 有 ${applied.escalated} 项需要人工处理`);
          }
        }
        diag.updatedAt = new Date().toISOString();
        void persistDiag();
        // 写盘成功后异步推云同步（不 await，绝不阻塞写盘）
        void sync?.push();

        const healthNote = applied.healthLogs.length > 0 ? `，health: ${applied.healthLogs.length} 项` : "";
        return `[memx] 已写入 ${proposals.length} 条记忆${healthNote}`;
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
    //
    // P0-1：不再是"只扫最后一轮"。每次 execution.succeeded 用 per-session 消息 id 游标
    // 增量扫出所有**新轮次**——长会话中间轮次的 SIGNAL 不再丢（事件漏拍 / 一次 execution
    // 跨多轮 / 客户端批量提交都会命中旧实现的盲区）。游标锚在消息 id 上：id 不在数组里
    // （压缩/分叉裁掉了）就退回全量扫，靠缓冲的 evidence 去重兜底，并留一条 warn 报警。
    async function captureFromSession(sessionID: string): Promise<void> {
      const raw = await ctx.session.context({ sessionID });
      const { shape, msgs } = toMessages(raw);

      if (msgs.length === 0) {
        // 非静默：无消息也留痕（#82 阻塞点正是"信封误判 → 静默早退 → 永不 persist"）
        diag.lastCapture = {
          userLen: 0,
          assistantLen: 0,
          styleHit: false,
          signalCount: 0,
          sessionID,
          msgCount: 0,
          ctxShape: shape,
        };
        diag.rawContext = JSON.stringify(raw ?? null).slice(0, 400);
        diag.updatedAt = new Date().toISOString();
        void persistDiag();
        return;
      }

      const cursor = await readCursor(sessionID);
      // 决策（锚点命中/丢失、从哪开始、新轮次）全部在 planCapture 里，host 侧只做 storage + 解析
      const plan = planCapture(msgs, cursor);
      const anchorLost = plan.cursorState === "anchor-lost";

      let styleCount = 0;
      let memoryCount = 0;
      for (const turn of plan.turns) {
        const styleSignals = captureSignals(turn.user, turn.assistant);
        buffer.pushAll(styleSignals);
        styleCount += styleSignals.length;
        const memorySignals = captureMemorySignals(turn.assistant);
        memoryBuffer.pushAll(memorySignals);
        memoryCount += memorySignals.length;
      }

      const lastTurn = plan.turns[plan.turns.length - 1];
      diag.captured += styleCount + memoryCount;
      diag.lastCapture = {
        userLen: lastTurn?.user.length ?? 0,
        assistantLen: lastTurn?.assistant.length ?? 0,
        styleHit: /STYLE_SIGNAL/.test(lastTurn?.assistant ?? ""),
        signalCount: styleCount + memoryCount,
        sessionID,
        msgCount: msgs.length,
        ctxShape: shape,
        cursor: plan.cursorState,
        newTurns: plan.turns.length,
      };
      if (anchorLost) {
        recordAlert(
          "warn",
          "CAPTURE_CURSOR_LOST",
          `会话 ${sessionID} 的游标锚点不在 context 里（压缩/分叉），本轮全量重扫（缓冲按 evidence 去重）`,
        );
      }
      diag.updatedAt = new Date().toISOString();
      void persistDiag();

      if (plan.nextCursorId !== undefined) {
        await writeCursor(sessionID, {
          lastMessageId: plan.nextCursorId,
          scanned: msgs.length,
          anchorLost,
          updatedAt: new Date().toISOString(),
        });
      }
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
            if (type === "session.deleted") {
              // P0-1：会话没了，游标也清掉（ctx.storage 的键是全局的，不清会留垃圾行）
              try {
                await ctx.storage.remove(cursorKey(sessionID));
              } catch {
                // cursor cleanup must never escape
              }
            }
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
        description: "手动触发 User Style + Project Memory 提炼（事件触发被节流或未触发时的兜底）",
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
        name: "memory_write",
        description:
          "记住一条项目记忆（用户说\"这个记一下 / 记住 / 别忘了\"时调用）。写进 canonical 记忆库 ~/.opencode/projects/<slug>/.mem/ 并更新 MEMORY.md 索引；同名同类型视为修订（更新）。",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "要记住的事实本身（陈述句，≤500 字），不要写成\"用户说……\"" },
            type: {
              type: "string",
              enum: [...MEMORY_TYPES],
              description: "记忆类型：project（进行中的工作/约束）/ feedback（协作规则）/ reference（外部指针）/ user（项目内用户画像）；缺省 project",
            },
            name: { type: "string", description: "短标识（≤60 字），同名同类型会覆盖更新；缺省从 text 截取" },
            description: { type: "string", description: "\"何时该读这条\"的钩子，含可匹配关键词（≤150 字）；缺省取 text" },
            why: { type: "string", description: "为什么记（feedback/project 建议给，≤200 字）" },
            how_to_apply: { type: "string", description: "以后怎么用（feedback/project 建议给，≤200 字）" },
            evidence: { type: "string", description: "用户原话（≤200 字）" },
          },
          required: ["text"],
        },
        // P0 实测（2026-10-12 真机）：默认走 codemode 时，宿主把调用包成 `execute` 工具、
        // 结果塞在 state.content——App 侧按工具名渲染的"记忆回执 chip"就认不出来（part.tool = "execute"）。
        // 声明 codemode:false 让它是**直调工具**：part.tool = "memory_write"，回执一目了然。
        options: { codemode: false },
        async execute(args, toolCtx) {
          const input = args as {
            text?: string;
            type?: string;
            name?: string;
            description?: string;
            why?: string;
            how_to_apply?: string;
            evidence?: string;
          };
          try {
            const result = await writeProjectMemory(
              currentSlug,
              {
                text: input.text ?? "",
                ...(input.type !== undefined ? { type: input.type } : {}),
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.why !== undefined ? { why: input.why } : {}),
                ...(input.how_to_apply !== undefined ? { how_to_apply: input.how_to_apply } : {}),
                ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
              },
              // 工具写盘也刷新 MEMORY.md 面包屑（字符串由 host 算，core 不反向 import alerts）
              formatBreadcrumb(alertStore),
            );
            if (!result.ok) {
              return { content: `[memx] memory_write 失败：${result.error}` };
            }
            diag.toolWrites = (diag.toolWrites ?? 0) + 1;
            diag.written += 1;
            diag.lastWrite = {
              name: result.name,
              type: result.type,
              filename: result.filename,
              action: result.action,
              sessionID: toolCtx.sessionID,
              at: new Date().toISOString(),
            };
            diag.updatedAt = new Date().toISOString();
            void persistDiag();
            // 写盘成功后异步推云同步（不 await，绝不阻塞写盘）
            void sync?.push();
            const warnNote = result.warnings.length > 0 ? `\n   ⚠️ ${result.warnings.join("；")}` : "";
            return {
              content: `✅ 已记住（${result.type} · ${result.action === "append" ? "新增" : "更新"}）：${result.name}\n   → ${result.filePath}${warnNote}`,
            };
          } catch (err) {
            return { content: `[memx] memory_write 失败：${String(err)}` };
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
            writeMemoryIndex(applyAlertBreadcrumb(newIndex));
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
            // 阶段 4：alerts 以文件存储为准（store 为准），diag.alerts 只是只写镜像
            const alertList = alertStore.list();
            const lines = [
              `[memx] 诊断`,
              `version: ${d.version ?? "unknown"}`,
              `captured: ${d.captured}`,
              `refinements: ${d.refinements}`,
              `written: ${d.written}`,
              `failures: ${d.failures}`,
              `lastError: ${d.lastError || "无"}`,
              `invalidStreak: style=${d.invalidStreak?.style ?? 0} memory=${d.invalidStreak?.memory ?? 0}`,
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
            // P0-1/P0-2/P0-3/P0-5 的新事实：游标增量 / 坏输出连击 / 定位告警 / 健康（不再进 MEMORY.md）
            lines.push(
              `capture.cursor: ${d.lastCapture?.cursor ?? "-"} newTurns=${d.lastCapture?.newTurns ?? 0} msgCount=${d.lastCapture?.msgCount ?? 0}`,
              `warnings: ${d.lastWarnings && d.lastWarnings.length > 0 ? d.lastWarnings.join(" | ") : "无"}`,
              `health: ${
                d.health
                  ? `fixes=${d.health.fixes} escalated=${d.health.escalated} at=${d.health.updatedAt}`
                  : "无"
              }`,
              `alerts: ${alertList.length > 0 ? alertList.map((a) => `${a.level}/${a.code}`).join(" ") : "无"}`,
              `toolWrites: ${d.toolWrites ?? 0}${
                d.lastWrite ? ` last=${d.lastWrite.action} ${d.lastWrite.type}/${d.lastWrite.name} @${d.lastWrite.at}` : ""
              }`,
            );
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
      if (syncTimer !== null) clearInterval(syncTimer);
      sync?.dispose();
      controller.abort();
    };
  },
});
