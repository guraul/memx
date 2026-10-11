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
import { shouldRun, markRun } from "../../core/llm/throttle";
import { MemorySignalBuffer, captureMemorySignals } from "../../core/signals/memory-capture";
import { refineMemory } from "../../core/refine/memory-refinement";
import { readMemoryIndex, writeMemoryIndex, applyMemoryProposal, forgetMemory } from "../../core/store/memory-md";
import { deriveSlug } from "../../core/memory-types";
import { runHealthCheck, autoFix, formatHealthLog } from "../../core/health/memory-health";

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

export default Plugin.define({
  id: "memx",
  async setup(ctx) {
    const buffer = new SignalBuffer();
    const memoryBuffer = new MemorySignalBuffer();
    // 活跃子会话集合：sessionID → system 提炼提示词（context hook 按 ∈ 集合过滤）
    const childSessions = new Map<string, string>();
    let refinementInFlight = false;
    let currentSlug = deriveSlug(ctx.location.directory ?? "");
    const controller = new AbortController();


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
      lastCapture?: {
        userLen: number;
        assistantLen: number;
        styleHit: boolean;
        signalCount: number;
        sessionID: string;
      };
      updatedAt: string;
    };
    const diag: Diag = {
      version: "v2-e2e-3",
      captured: 0,
      refinements: 0,
      written: 0,
      failures: 0,
      lastError: "",
      updatedAt: new Date().toISOString(),
    };
    const persistDiag = async (): Promise<void> => {
      try {
        await ctx.storage.set("diag", { ...diag });
      } catch {
        // diagnostics must never escape
      }
    };
    void persistDiag();

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
          const sections = parseUserMd(content);
          content = serializeUserMd(sections);
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
    // messages）——rpc message.list 宿主未注册、inbox.delivered 无负载（均实测）
    async function captureFromSession(sessionID: string): Promise<void> {
      const res = (await ctx.session.context({ sessionID })) as { messages?: V2Message[] };
      const msgs = res?.messages ?? [];
      const last = extractLastTurn(msgs as V2Message[]);
      if (!last) return;
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
            if (childSessions.has(sessionID)) {
              if (type === "session.deleted") childSessions.delete(sessionID);
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

    // 子会话提炼的组装管线钩子：全局注册一次 + 活跃集合过滤（handoff 硬坑 7）。
    // 命中时整体替换 system（不是 push——v1 body.system 是替换语义）、temperature 0.2、清空 tools。
    ctx.session
      .hook("context", (event) => {
        try {
          const system = childSessions.get(event.sessionID);
          if (system === undefined) return; // 非子会话：零开销放行
          event.system = [{ type: "text", text: system }] as typeof event.system;
          event.options.temperature = 0.2;
          event.tools = {};
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
        description: "Show memx structured diagnostics: capture/refinement/written counters, failures, last error.",
        input: { type: "object", properties: {}, required: [] },
        async execute() {
          try {
            const stored = (await ctx.storage.get("diag")) as Partial<Diag> | undefined;
            const d = { ...diag, ...(stored ?? {}) };
            return {
              content: [
                `[memx] 诊断`,
                `captured: ${d.captured}`,
                `refinements: ${d.refinements}`,
                `written: ${d.written}`,
                `failures: ${d.failures}`,
                `lastError: ${d.lastError || "无"}`,
                `updatedAt: ${d.updatedAt}`,
              ].join("\n"),
            };
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
      buffer.clear();
      memoryBuffer.clear();
      controller.abort();
    };
  },
});
