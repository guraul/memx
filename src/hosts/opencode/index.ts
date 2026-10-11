import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
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

const buffer = new SignalBuffer();
const memoryBuffer = new MemorySignalBuffer();
const childSessionIDs = new Set<string>();
let refinementInFlight = false;
let currentSlug = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LastTurn {
  user: string;
  assistant: string;
}

export function extractLastTurn(
  msgs: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>,
): LastTurn | null {
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.info.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  const userText = msgs[lastUserIdx]!.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

  let assistantText = "";
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    if (msgs[i]!.info.role === "assistant") {
      assistantText = msgs[i]!.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      break;
    }
  }

  return { user: userText, assistant: assistantText };
}

async function runRefinement(client: any, _sessionID: string, force = false): Promise<string> {
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
    const signals = buffer.getAll();
    const existingContent = readUserMd();
    const llm: LLMClient = createSessionLLMClient(client, config.refinementModel, (id) => {
      childSessionIDs.add(id);
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

    try {
      await client.app.log({
        body: {
          service: "memx",
          level: "info",
          message: `Updated USER.md: ${proposals.length} items`,
        },
      });
    } catch {
      // logging must never escape the hook
    }

    return `[memx] 已写入 ${proposals.length} 条`;
  } finally {
    refinementInFlight = false;
  }
}

async function runMemoryRefinement(client: any, _sessionID: string, force = false): Promise<string> {
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
    const signals = memoryBuffer.getAll();
    const existingIndex = readMemoryIndex();
    const llm: LLMClient = createSessionLLMClient(client, config.refinementModel, (id) => {
      childSessionIDs.add(id);
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

    try {
      await client.app.log({
        body: {
          service: "memx",
          level: "info",
          message: `Updated MEMORY.md: ${proposals.length} items${healthMsg}`,
        },
      });
    } catch {
      // logging must never escape the hook
    }

    return `[memx] 已写入 ${proposals.length} 条记忆${healthMsg}`;
  } finally {
    refinementInFlight = false;
  }
}

export const MemxPlugin: Plugin = async ({ client, directory }) => {
  currentSlug = deriveSlug(directory ?? "");
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle" && event.type !== "session.deleted") return;
      try {
        const sessionID = (event as any).properties.sessionID as string;
        if (childSessionIDs.has(sessionID)) {
          if (event.type === "session.deleted") childSessionIDs.delete(sessionID);
          return;
        }

        if (event.type === "session.idle") {
          const res = await client.session.messages({ path: { id: sessionID } });
          const msgs = res.data ?? [];
          const last = extractLastTurn(msgs);
          if (last) {
            const signals = captureSignals(last.user, last.assistant);
            buffer.pushAll(signals);
            const memSignals = captureMemorySignals(last.assistant);
            memoryBuffer.pushAll(memSignals);
          }
        }
        await runRefinement(client, sessionID, event.type === "session.deleted");
        await runMemoryRefinement(client, sessionID, event.type === "session.deleted");
        childSessionIDs.delete(sessionID);
      } catch (err) {
        try {
          await client.app.log({
            body: {
              service: "memx",
              level: "error",
              message: String(err),
            },
          });
        } catch {
          // logging must never escape the hook
        }
      }
    },

    tool: {
      reflect: tool({
        description: "手动触发 User Style + Project Memory 提炼（当 session.idle 未触发时使用）",
        args: {},
        async execute(_args, ctx) {
          try {
            const res = await client.session.messages({ path: { id: ctx.sessionID } });
            const msgs = res.data ?? [];
            const last = extractLastTurn(msgs);
            if (last) {
              const signals = captureSignals(last.user, last.assistant);
              buffer.pushAll(signals);
              const memSignals = captureMemorySignals(last.assistant);
              memoryBuffer.pushAll(memSignals);
            }
            const styleResult = await runRefinement(client, ctx.sessionID, true);
            const memoryResult = await runMemoryRefinement(client, ctx.sessionID, true);
            return `${styleResult} | ${memoryResult}`;
          } catch (err) {
            return `[memx] 失败: ${err}`;
          }
        },
      }),

      forget: tool({
        description: "Forget project memories matching a keyword. Moves matching .mem/*.md files to .trash and removes their index entries. Use when user says 'forget/forget/remember to delete X'.",
        args: {
          keyword: tool.schema.string().describe("Search keyword to match memory title, hook, or filename"),
        },
        async execute(args, _ctx) {
          try {
            const keyword = args.keyword;
            if (!keyword.trim()) return "[memx] forget: keyword is required";
            const existingIndex = readMemoryIndex();
            const { newIndex, removed } = forgetMemory(keyword, existingIndex, currentSlug);
            if (removed.length === 0) {
              return `[memx] forget: no memories matched "${keyword}"`;
            }
            writeMemoryIndex(newIndex);
            try {
              await client.app.log({
                body: {
                  service: "memx",
                  level: "info",
                  message: `Forgot ${removed.length} memories matching "${keyword}": ${removed.join(", ")}`,
                },
              });
            } catch {
              // logging must never escape
            }
            return `[memx] forgot ${removed.length} memories: ${removed.join(", ")}`;
          } catch (err) {
            return `[memx] forget failed: ${err}`;
          }
        },
      }),
    },

    dispose: async () => {
      try {
        await runRefinement(client, "", true);
        await runMemoryRefinement(client, "", true);
      } catch {
        // flush on exit, never throw
      }
      buffer.clear();
      memoryBuffer.clear();
    },
  };
};