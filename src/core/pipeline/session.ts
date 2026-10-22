// memx · 宿主无关的会话流水线（信号缓冲 → 节流 → 调提炼 → 写盘 → 回执计数）。
//
// 为什么在这里：`hosts/opencode/index.ts` 原本把"接线"（事件订阅、工具注册、诊断落盘）
// 与"流水线"（这一整段）混在一个 883 行的壳里。多宿主目标（opencode + DSH）下，
// 流水线语义必须只有一份实现，否则两边的写盘格式、节流、坏输出连击、健康维护
// 迟早各走一条路。
//
// 这里**只搬不改**：两个 refine 方法逐段对应原来的 runRefinement / runMemoryRefinement
// （opencode 宿主的行为由 tests/context-hook.test.ts 等既有用例兜底）。
// 宿主差异全部收进 PipelineHost 这个窄口：配置怎么读、LLM 客户端怎么造、诊断落哪、
// 报警写哪里、面包屑谁算、写盘后要不要推同步。
import { SignalBuffer } from "../signals/signal-capture.ts";
import { MemorySignalBuffer } from "../signals/memory-capture.ts";
import { refine } from "../refine/refinement.ts";
import type { LLMClient } from "../refine/refinement.ts";
import { refineMemory } from "../refine/memory-refinement.ts";
import { INVALID_OUTPUT_STREAK_LIMIT } from "../refine/refine-outcome.ts";
import {
  applyProposals,
  backupUserMd,
  isOverLimit,
  parseUserMd,
  readUserMd,
  serializeUserMd,
  writeUserMd,
} from "../store/user-md.ts";
import { memoryIndexLockPath, userMdLockPath, withFileLock } from "../store/lock.ts";
import {
  applyMemoryProposals,
  readMemoryIndex,
  writeMemoryIndex,
} from "../store/memory-md.ts";
import { markRun, shouldRun } from "../llm/throttle.ts";
import { formatHealthLog, runHealthMaintenance } from "../health/memory-health.ts";
import type { AutoFixLog } from "../health/memory-health.ts";
import type { MemxConfig } from "../config.ts";

export type AlertLevel = "info" | "warn" | "critical";

/** 流水线真正会读写的诊断字段（宿主的诊断对象是它的超集，结构兼容即可）。 */
export interface PipelineDiagnostics {
  refinements: number;
  written: number;
  failures: number;
  lastError: string;
  updatedAt: string;
  /** P0-2：连续 invalid-output 次数（按轨道），≥limit 丢弃缓冲并记报警 */
  invalidStreak?: { style: number; memory: number };
  /** P0-3：最近一批提案的定位告警（anchor 降级/未命中） */
  lastWarnings?: string[];
  /** P0-5：健康检查结果 */
  health?: { fixes: number; escalated: number; lastLog: string; updatedAt: string };
}

/**
 * 宿主侧必须提供的那一小撮能力。刻意全是"动词"而不是"对象"：
 * core 不 import 任何宿主类型，宿主也不把自家 ctx 漏进来。
 */
export interface PipelineHost {
  /** 可变诊断对象（宿主持有，流水线原地累加） */
  diag: PipelineDiagnostics;
  /** 当前项目 slug（Track 2 的索引小节） */
  slug: string;
  loadConfig(): Promise<MemxConfig>;
  /** 用当前配置造一个提炼用 LLM 客户端（opencode = 子会话，DSH = ctx.llm.stream） */
  createLLM(config: MemxConfig): LLMClient;
  recordAlert(level: AlertLevel, code: string, message: string): void;
  /** 诊断落盘（宿主自行决定异步/节流） */
  persist(): void;
  /** 写 MEMORY.md 前的装饰（面包屑字符串由宿主算，core 不反向依赖报警实现） */
  decorateIndex(content: string): string;
  /** 记忆写盘成功后的旁路（opencode = 推云同步；绝不阻塞写盘） */
  onMemoryWritten?(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一条流水线实例 = 一套缓冲 + 一个"提炼进行中"闸门。相位与原来完全一致：
 * 两个轨道共享同一个 inFlight 标志（并发提炼会把同一批提案写两遍）。
 */
export class SessionPipeline {
  readonly style: SignalBuffer;
  readonly memory: MemorySignalBuffer;
  private inFlight = false;

  constructor(
    private readonly host: PipelineHost,
    buffers?: { style: SignalBuffer; memory: MemorySignalBuffer },
  ) {
    this.style = buffers?.style ?? new SignalBuffer();
    this.memory = buffers?.memory ?? new MemorySignalBuffer();
  }

  get styleCount(): number {
    return this.style.length;
  }

  get memoryCount(): number {
    return this.memory.length;
  }

  clear(): void {
    this.style.clear();
    this.memory.clear();
  }

  /** Track 1：风格偏好。回执文案与原来逐字一致（App 侧与 E2E 都在断言它们）。 */
  async refineStyle(force = false): Promise<string> {
    const { diag, host } = { diag: this.host.diag, host: this.host };
    if (this.style.length === 0) return "[memx] 无信号，跳过";

    const config = await host.loadConfig();
    if (!force && !shouldRun(config.throttleMinutes)) return "[memx] 节流中，跳过";

    if (this.inFlight) {
      if (!force) return "[memx] 提炼进行中，跳过";
      while (this.inFlight) await sleep(200);
    }
    this.inFlight = true;
    try {
      markRun();
      diag.refinements++;
      const signals = this.style.getAll();
      const existingContent = readUserMd();
      const llm = host.createLLM(config);
      const outcome = await refine(signals, llm, existingContent, config.refinementModel);

      // P0-2：坏输出 → 保留缓冲重试；连续 N 次仍坏 → 丢弃缓冲 + 记报警（防坏模型无限循环）
      if (outcome.kind === "invalid-output") {
        const streak = (diag.invalidStreak ??= { style: 0, memory: 0 });
        streak.style++;
        diag.lastError = `[style invalid-output #${streak.style}] ${outcome.error}\nraw: ${outcome.rawSnippet}`;
        diag.updatedAt = new Date().toISOString();
        if (streak.style >= INVALID_OUTPUT_STREAK_LIMIT) {
          host.recordAlert(
            "critical",
            "REFINEMENT_FAILURE_STREAK",
            `style 提炼连续 ${streak.style} 次输出无效，丢弃 ${this.style.length} 条缓冲：${outcome.error.slice(0, 120)}`,
          );
          streak.style = 0;
          this.style.clear();
          host.persist();
          return `[memx] 提炼输出连续 ${INVALID_OUTPUT_STREAK_LIMIT} 次无效，已丢弃缓冲`;
        }
        host.persist();
        return `[memx] 提炼输出无效（第 ${streak.style}/${INVALID_OUTPUT_STREAK_LIMIT} 次），保留缓冲重试`;
      }
      if (diag.invalidStreak) diag.invalidStreak.style = 0;

      // P0-2：合法空数组/全被过滤 = LLM 已裁决"不值得存" → 清缓冲结案
      if (outcome.kind === "adjudicated-empty") {
        this.style.clear();
        diag.updatedAt = new Date().toISOString();
        host.persist();
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

      this.style.clear();
      diag.written += proposals.length;
      if (applied.warnings.length > 0) diag.lastWarnings = applied.warnings.slice(-10);
      diag.updatedAt = new Date().toISOString();
      host.persist();

      const warnNote = applied.warnings.length > 0 ? `（${applied.warnings.length} 条定位告警）` : "";
      return `[memx] 已写入 ${proposals.length} 条${warnNote}`;
    } catch (err) {
      diag.failures++;
      diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      diag.updatedAt = new Date().toISOString();
      host.persist();
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  /** Track 2：项目记忆。回执文案与原来逐字一致。 */
  async refineMemory(force = false): Promise<string> {
    const { diag, host } = { diag: this.host.diag, host: this.host };
    if (this.memory.length === 0) return "[memx] 无记忆信号，跳过";

    const config = await host.loadConfig();
    if (!force && !shouldRun(config.throttleMinutes)) return "[memx] 节流中，跳过";

    if (this.inFlight) {
      if (!force) return "[memx] 提炼进行中，跳过";
      while (this.inFlight) await sleep(200);
    }
    this.inFlight = true;
    try {
      markRun();
      diag.refinements++;
      const signals = this.memory.getAll();
      const existingIndex = readMemoryIndex();
      const llm = host.createLLM(config);
      const outcome = await refineMemory(signals, llm, existingIndex, config.refinementModel);

      if (outcome.kind === "invalid-output") {
        const streak = (diag.invalidStreak ??= { style: 0, memory: 0 });
        streak.memory++;
        diag.lastError = `[memory invalid-output #${streak.memory}] ${outcome.error}\nraw: ${outcome.rawSnippet}`;
        diag.updatedAt = new Date().toISOString();
        if (streak.memory >= INVALID_OUTPUT_STREAK_LIMIT) {
          host.recordAlert(
            "critical",
            "REFINEMENT_FAILURE_STREAK",
            `memory 提炼连续 ${streak.memory} 次输出无效，丢弃 ${this.memory.length} 条缓冲：${outcome.error.slice(0, 120)}`,
          );
          streak.memory = 0;
          this.memory.clear();
          host.persist();
          return `[memx] 记忆提炼输出连续 ${INVALID_OUTPUT_STREAK_LIMIT} 次无效，已丢弃缓冲`;
        }
        host.persist();
        return `[memx] 记忆提炼输出无效（第 ${streak.memory}/${INVALID_OUTPUT_STREAK_LIMIT} 次），保留缓冲重试`;
      }
      if (diag.invalidStreak) diag.invalidStreak.memory = 0;

      if (outcome.kind === "adjudicated-empty") {
        this.memory.clear();
        diag.updatedAt = new Date().toISOString();
        host.persist();
        return `[memx] 无可提炼记忆（${outcome.reason}，已结案）`;
      }

      const proposals = outcome.proposals;

      // P0-4 + P0-3 + P0-5：一把锁内完成"重读索引 → 单遍应用提案 → 健康维护 → 单次写盘"。
      // 健康日志只回传给诊断（P0-5），**不再追加 HTML 注释到 MEMORY.md**——那正是被下一次
      // 序列化吃掉的那份日志。
      const applied = await withFileLock(memoryIndexLockPath(), () => {
        const result = applyMemoryProposals(proposals, readMemoryIndex(), host.slug);
        let indexContent = result.content;
        let healthLogs: AutoFixLog[] = [];
        let escalated = 0;
        try {
          const maintenance = runHealthMaintenance(indexContent, host.slug);
          indexContent = maintenance.index;
          healthLogs = maintenance.logs;
          escalated = maintenance.report.escalated.length;
        } catch {
          // health check must never block refinement
        }
        writeMemoryIndex(host.decorateIndex(indexContent));
        return { warnings: result.warnings, healthLogs, escalated };
      });

      this.memory.clear();
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
          host.recordAlert("warn", "HEALTH_ESCALATED", `MEMORY.md 有 ${applied.escalated} 项需要人工处理`);
        }
      }
      diag.updatedAt = new Date().toISOString();
      host.persist();
      // 写盘成功后异步推云同步（不 await，绝不阻塞写盘）
      host.onMemoryWritten?.();

      const healthNote = applied.healthLogs.length > 0 ? `，health: ${applied.healthLogs.length} 项` : "";
      return `[memx] 已写入 ${proposals.length} 条记忆${healthNote}`;
    } catch (err) {
      diag.failures++;
      diag.lastError = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      diag.updatedAt = new Date().toISOString();
      host.persist();
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  /** 两个轨道依次落盘（原 flushAll 的语义：风格先、记忆后，任一失败即抛给调用方）。 */
  async flushAll(force: boolean): Promise<void> {
    await this.refineStyle(force);
    await this.refineMemory(force);
  }
}
