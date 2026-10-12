// 信号协议的唯一真源（single source of truth）。
//
// 为什么是独立文件而不是塞进 USER.md：USER.md 是 memx 自己的数据文件，每次提炼都会被
// 重写——早期把协议块放在那里已经造成过一次数据丢失（首次成功写盘就把协议抹掉，
// 静默杀死之后所有信号捕获）。协议必须与数据分离。
//
// 协议由**插件自己**注入 system prompt（core/injection.ts + hosts/opencode/context-hook.ts）：
// opencode.json 的 `instructions` 在 v2.0.26 是死字段（宿主只从 AGENTS.md 组装指令），
// 那个注册项留着只为向前兼容，真正的注入通道是 `context` hook。
//
// 文本中的枚举值一律从 Zod schema 的 const 数组派生（见 CATEGORIES/SOURCES/... ），
// 改 schema 即改文本，杜绝文档漂移；tests/protocol-template.test.ts 反向校验示例 JSON
// 真的能通过 schema。
// 显式 .ts 后缀（而非仓库惯用的无后缀写法）：本模块是叶子模块，scripts/sync-protocol.ts
// 要用 Node 直接 import 它来生成文件，Node 的 ESM 解析器不接受无后缀的相对路径。
import { CATEGORIES, CONFIDENCES, SOURCES } from "./types.ts";
import { MEMORY_SOURCES, MEMORY_TYPES } from "./memory-types.ts";

/** 协议版本。写进文件末尾，改动协议文本时递增——install.sh 用它判断是否需要刷新。 */
export const PROTOCOL_VERSION = "1.1.0";

/** 落盘文件名（相对 $OCP_DATA_DIR，即 ~/.opencode/）。 */
export const PROTOCOL_FILE_NAME = "memx-protocol.md";

/** 写进 opencode.json 的 instructions 条目（相对 $HOME 的路径展开形式）。
 *  ⚠️ v2.0.26 上这是**死字段**（宿主不从这里读文件），只为向前兼容保留；真正的注入
 *  由插件的 `context` hook 完成，路径由 core/injection-source.ts 解析。 */
export const PROTOCOL_INSTRUCTION = "~/.opencode/" + PROTOCOL_FILE_NAME;

/** 累积数据（与协议分开注入）：风格画像 / 项目记忆索引。同样只是 instructions 的
 *  兼容条目；实际注入顺序见 core/injection.ts 的 INJECTION_SOURCE_ORDER。 */
export const USER_MD_INSTRUCTION = "~/.opencode/USER.md";
export const MEMORY_MD_INSTRUCTION = "~/.opencode/MEMORY.md";

/** 管道分隔的枚举清单，直接嵌进协议文本。 */
const enumList = (values: readonly string[]): string => values.join(" | ");

/**
 * 协议正文 = `~/.opencode/memx-protocol.md` 的完整内容（含自述头与生成标记）。
 * scripts/sync-protocol.ts 把它写到目标文件；install.sh 调用该脚本，不要在别处复制这份文本。
 */
export const PROTOCOL_TEMPLATE = `# memx signal protocol

\`memx\` reads machine signals out of your raw reply text: anything you write inside an HTML
comment is captured, refined and written to long-term memory. You never manage it again.

## Rules

1. One comment per distinct preference or memory. Never pack two into one comment.
2. Each comment must sit on ONE line. The parser regex cannot cross a newline.
3. That line must be valid JSON on its own: double quotes, no trailing comma, no backticks,
   no surrounding code fence.
4. Comments are machine-read, never user-facing. Do not quote, translate, explain or
   "print the signal above" them, and never restate a comment as visible prose.
5. An empty or fenced-only reply is a failure. Always answer the user normally in your own
   words; signals ride along **in addition to** your answer, never instead of it.
6. Signal durable facts only — how the user wants to work, not this task's instruction,
   not ephemeral state, not anything a repo already records (AGENTS.md, code, git history).
7. Never signal secrets, credentials, tokens or PII.
8. Respect the length caps below. An over-long value fails validation and the signal is
   silently dropped.
9. **Never write memory into any file yourself.** Not \`AGENTS.md\`, not \`opencode.json\`, not
   \`README\`, not the memory files. Memory reaches disk only through the capture pipeline
   (these comments) or the explicit \`memory_write\` tool. Editing \`AGENTS.md\` to "remember"
   something is a real observed failure mode: it corrupts every later session's instructions
   and is invisible to the user.

## Track 1 · STYLE_SIGNAL — durable user preferences (cross-project)

Emit for HOW the user wants to work everywhere, not for what they are building right now.
Format, verbosity, tools, package managers, editors, framework taste, stated aversions.

<!-- STYLE_SIGNAL: {"category":"communication","content":"lead with the conclusion, reasons after","evidence":"the user's exact words, verbatim","confidence":"high","source":"explicit"} -->

- \`category\` (required) — one of: ${enumList(CATEGORIES)}
- \`content\` (required) — the preference itself, ≤100 chars
- \`evidence\` (required) — the user's own words that justify it, ≤200 chars
- \`confidence\` (required) — one of: ${enumList(CONFIDENCES)}
- \`source\` (required) — one of: ${enumList(SOURCES)}

\`source\` is how you learned it: the user said it outright (\`explicit\`), corrected you
(\`implicit_correction\`), shaped reply form (\`format_feedback\`), confirmed a non-obvious
approach (\`confirmation\`), or you inferred a repeated pattern (\`depth_signal\` — use only
once the same preference has recurred at least three times in the conversation).

## Track 2 · MEMORY_SIGNAL — project-scoped knowledge

Emit for project context that is NOT derivable from the code or git history: ongoing work,
driving constraints, collaboration rules, external pointers.

<!-- MEMORY_SIGNAL: {"type":"project","name":"short_identifier","description":"when-relevant hook with matchable keywords, ≤150 chars","content":"the fact itself, ≤500 chars","why":"required for feedback/project, null otherwise","how_to_apply":"required for feedback/project, null otherwise","evidence":"the user's own words, ≤200 chars","confidence":"high","source":"explicit"} -->

- \`type\` (required) — one of: ${enumList(MEMORY_TYPES)}
- \`name\` (required) — short identifier, ≤60 chars
- \`description\` (required) — the only text a later session reads to decide whether to load
  this memory, so it needs matchable keywords **and** a "when relevant" trigger; ≤150 chars
- \`content\` (required) — the fact itself, ≤500 chars
- \`why\` — REQUIRED (non-null) for \`feedback\` and \`project\`, ≤200 chars; \`null\` otherwise
- \`how_to_apply\` — REQUIRED (non-null) for \`feedback\` and \`project\`, ≤200 chars; \`null\` otherwise
- \`evidence\` (required) — the user's own words, ≤200 chars
- \`confidence\` (required) — one of: ${enumList(CONFIDENCES)}
- \`source\` (required) — one of: ${enumList(MEMORY_SOURCES)}

Convert relative dates to absolute ("next Friday" → "2026-10-16"); relative dates rot.

<!-- memx:generated — do not edit by hand, edit src/core/protocol-template.ts instead -->
<!-- memx:version ${PROTOCOL_VERSION} -->
`;