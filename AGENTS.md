# memx - Agent Guide

## Project

OpenCode V2 dual-track memory plugin. Track 1: captures user style preferences (cross-project, slow-changing) via `STYLE_SIGNAL` HTML comments -> refines to `~/.opencode/USER.md`. Track 2: captures project-scoped memory (ongoing work, external resources, feedback) via `MEMORY_SIGNAL` HTML comments -> refines to `~/.opencode/MEMORY.md` index + `~/.opencode/projects/<slug>/.mem/*.md` files. Both tracks share the same trigger pipeline (`session.execution.succeeded` / `reflect` / `dispose`) but have separate signal buffers, refinement prompts, and write targets.

## Commands

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Always run `typecheck` before committing - TypeScript strict mode catches easy-to-miss errors.

## Key facts

- **Entry point**: `src/hosts/opencode/index.ts` default-exports the V2 `Plugin`. The host-side entry `~/.config/opencode/plugins/memx.ts` re-exports ONLY `default` from it - never widen that re-export or add named exports at the entry, extra exported functions get invoked as plugins and crash OpenCode (`plugin config hook failed`)
- **Hooks**: `event` (订阅 `session.execution.succeeded` + `session.deleted`) + `session.hook("context")` (子会话 system 替换) + `tool.transform` (`reflect` / `forget` / `memx_status`) + `dispose`
- **Install**: `~/.config/opencode/plugins/memx.ts` re-exports `default` from `src/hosts/opencode/index`
- **Model override**: `~/.opencode/memx.config.json` 的 `refinementModel` (`provider/model` 格式), 运行时每次读取 - 改配置**无需重启**. Default: `opencode/mimo-v2.6-flash-free` (内置免费模型, 无需 key; deepseek 官方 key 无效, 不要用)
- **LLM calls**: 子会话 `session.create({title, model: ModelRef})` -> `session.prompt({sessionID, text})` -> `session.wait` -> `session.context` 取 assistant 全文 -> `session.remove` (finally), 见 `src/hosts/opencode/session-llm.ts`. 提炼 system 提示词靠 `context` hook 的 `event.system` 替换注入
- **Track 1 paths**: `~/.opencode/USER.md` (hardcoded in `src/core/store/user-md.ts`)
- **Track 2 paths**: `~/.opencode/MEMORY.md` (index) + `~/.opencode/projects/<slug>/.mem/*.md` (content), hardcoded in `src/core/store/memory-md.ts`. Slug derived from plugin's `directory` context via `deriveSlug()` in `src/core/memory-types.ts`
- **Backup rotation**: `writeUserMd` / `writeMemoryIndex` auto-backups before every write, keeps 5 versions
- **All hooks try-catched**: never let plugin errors reach the host
- **LLM returns Zod-validated**: `StyleProposalArraySchema` in `src/types.ts` (Track 1) + `MemoryProposalArraySchema` in `src/memory-types.ts` (Track 2); `extractJson` strips markdown fences before parse
- **Conflict handling**: when a new memory contradicts an existing one, LLM returns `deprecate` (old) + `append` (new, with `supersedes` field). Code writes `**Supersedes:**` audit line in new file, moves old file to `.mem/.trash/` (not physically deleted)
- **Health check**: `runHealthCheck` runs after each memory refinement in `reflect` / `session.execution.succeeded`. Detects dead links (index points to non-existent files) and orphan files (`.mem/*.md` not in index). Auto-fixes with guardrail: max 3 per run, logs as HTML comments in MEMORY.md, escalates bloat/conflicts to manual
- **Concurrency guard**: `runRefinement` + `runMemoryRefinement` share mutex (`refinementInFlight`), `markRun()` fires BEFORE the LLM call - both prevent child-session storms / duplicate writes when events overlap. Throttle is **in-memory only** (`lastRunAt`), so restarting the host resets it
- **Child-session guard**: `childSessions` map (sessionID → system) for the `context` hook, PLUS `childSessionIds` set that lives until the child's `session.deleted` event is consumed - see the self-excitation trap in Quirks. Both are populated in `onCreated`
- **Diagnostics**: v2 has no `client.app.log` - structured diagnostics go to `ctx.storage` under `"diag:" + deriveSlug(ctx.location.directory)`. **The tool output is not the truth** (`memx_status` prints fixed fields only); read the kv row directly: `sqlite3 ~/.local/share/opencode/opencode.db "SELECT value FROM kv WHERE key LIKE 'plugin:%'"` (namespace = `plugin:` + "memx" as 4 hex digits per char)
- **Loading mechanism**: **插件自己在 `context` hook 里追加**三块 SystemPart 到 `event.system`——`~/.opencode/memx-protocol.md`（协议）+ `USER.md`（画像）+ `MEMORY.md`（索引），每块硬上限 200 行 / 25KB，截断时追加可见提示行。**⚠️ `opencode.json` 的 `instructions` 在 v2.0.26 是死字段**（宿主只从 AGENTS.md 组装，全仓无消费方），不要指望它注入。注入范围由 `memx.config.json` 的 `inject.{enabled,includeAgents,excludeAgents}` 控制，**代码里不硬编码任何 agent 名**
- **AGENTS.md prompts**: `~/.config/opencode/AGENTS.md` 是宿主唯一验证过的指令通道（memx **不写**它，见 Quirks 的所有权缺口）

## Architecture

> ✅ **2026-10-11 阶段 1 分层落地**：`src/` 已重排为 `core/`（signals/refine/store/health/llm/config/types，**零宿主依赖**——禁 import `@opencode*`）+ `hosts/opencode/`（插件壳 index.ts + session-llm 适配 + context-shape.ts）+ `cli/`（doctor，阶段 4）。行为等价迁移。
>
> ✅ **2026-10-12 阶段 2 V2 移植闭环**（`d79d248` / `50f36fa`）：v2-only 插件，端到端实测通过（STYLE_SIGNAL → 捕获 → 子会话提炼 → 写盘）。依赖已升到 `@opencode/plugin ^2.0.26`。**v2 契约陷阱见下方 Quirks——那几条都是实机打出来的，不要凭生成的 `.d.ts` 想当然**（其中 `session.prompt` 的 `text` 字段，生成的类型与在跑的二进制载荷校验就不一致）。

```
src/
  core/                        # 零宿主依赖：禁 import @opencode-*
    types.ts                   - StyleSignal, StyleProposal, UserMdDoc, Zod schemas (Track 1)
    config.ts                  - `~/.opencode/memx.config.json` load + Zod validation
    memory-types.ts            - MemorySignal, MemoryProposal, Zod schemas + deriveSlug() (Track 2)
    signals/signal-capture.ts  - STYLE_SIGNAL HTML comment parser + SignalBuffer (max 20, dedup by evidence)
    signals/memory-capture.ts  - MEMORY_SIGNAL parser + MemorySignalBuffer
    refine/prompts.ts          - Track 1 system prompt constants
    refine/refinement.ts       - Track 1 LLM batch refinement + Zod + extractJson (LLMClient interface 定义在此)
    refine/memory-prompts.ts   - Track 2 system prompt constants
    refine/memory-refinement.ts- Track 2 LLM batch refinement + Zod validation
    store/user-md.ts           - read/write/parse/backup USER.md（parse→UserMdDoc，保留非受管内容）
    store/memory-md.ts         - MEMORY.md index + .mem/*.md + backup（同一保留契约）
    store/markdown-lines.ts    - 两个序列化器共用的空行边界工具（保幂等）
    health/memory-health.ts    - Index health check (dead links, orphan files) + auto-fix with guardrails
    llm/throttle.ts            - 内存节流（宿主重启即重置）
  hosts/opencode/
    index.ts                   - Plugin 入口（只 default 导出）：event + context hook + tool.transform + dispose
    session-llm.ts             - LLMClient 适配：子会话 create→prompt→wait→context→remove
    context-shape.ts           - V2 消息形状：toMessages / extractLastTurn（上面两个文件共享）
  cli/                         - doctor（阶段 4）
tests/                         - 12 文件 / 137 测试（基线，低于即回归）
  fixtures/                    - mock conversations + sample USER.md
```

> ⚠️ `hosts/opencode/` 内 index → session-llm → context-shape 单向依赖，**`session-llm.ts` 绝不能回头 import `index.ts`**，会成环。共享逻辑一律下沉到 `context-shape.ts`。

## Quirks & gotchas

- **`session.idle` 在 v2 回合结束后根本不发**（2026-10-11 实测；v1 时代才有）。每轮必发的是 **`session.execution.succeeded`**（v2 负载取 `event.data.sessionID`）——触发器已改用它。手工验证走 `reflect` 工具（`force=true`，绕节流）。
- **`ctx.session.context({sessionID})` 返回消息数组本身**，不是 `{messages:[...]}` 信封。HTTP 线上是 `{data:[...]}`，SDK 里 `.then(v => v.data)` 已经拆包（`@opencode/client/dist/chunks/service-timing-*.js`）。按信封解包 → 恒 `[]` → 捕获永远静默早退。统一过 `toMessages()`（数组为准、信封兜底）。
- **取消息只有 `session.context` 一条路**：`ctx.rpc.call("message.list")` 宿主**未注册该方法**（调用抛 `Object.entries(null)`）；`session.inbox.delivered` 事件的 `event.data` 是**空对象**，拿不到用户文本。别再试这两条。
- **`session.create` 的 `model` 要 `Model.Ref` 对象**（`{providerID, id, variant?}`），传 `"provider/model"` 字符串 → `SchemaError(Expected Model.Ref | null at ["model"])`。用 `toModelRef()` 转换；串里没有 `/` 就整个省略 `model` 交回宿主默认，别臆造 providerID。
- **`session.prompt` 的 `text` 在 2.0.26 二进制上是裸字符串**——生成的 `SessionPromptInput` 类型写的是对象（`text: {text, files?...}`），**类型与载荷校验不一致**。实机 A/B：`{"text":{"text":"hi"}}` → `400 Expected string at ["text"]`；`{"text":"hi"}` → 200。**别按 `.d.ts` 改回对象形态**。
- **⚠️ 禁止在 `context` hook 里 `event.tools = {}`**：会让子会话的模型请求被免费档网关拒绝——`finish:"error"` + `error.type:"provider.auth"` status 403 `FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`，`content: []` → `refine()` 收到 `""` → JSON 解析失败 → **永远不写盘，且 `failures` 不涨、`lastError` 为空**（症状极具误导性）。二分法证明唯一变量就是这一行。要约束输出就用 `event.system` 替换。
- **子会话空回复时先看 `finish` / `error` / `rawFinish`**，不要只看 `content` 的 parts——故障全藏在那三个字段里。
- **`ctx.storage` 的键是全局的**：所有 memx 实例（任何进程、任何目录）写同一行，后写者覆盖先写者，`lastError`/`failures` 会被抹掉。键已按目录隔离成 `"diag:" + deriveSlug(directory)`（首次出现时用旧全局值做一次性种子迁移）。注意**同目录多实例仍会打架**（`opencode run --server` 客户端也会实例化插件）——排查时优先看 serve 日志而不是 kv 行。
- **子会话自激循环**（2026-10-12 实测，10 秒生成 106 个子会话）：`session-llm` 的 `finally` 先 `remove` 再 `onRemoved`，`childSessions` 在 `session.deleted` 事件到达**之前**就被清空了；事件处理器只看 `childSessions` 就会把"自己删自己的子会话"误判成用户删会话，而那一支是 `force=true` → 再生子会话 → 无限循环，且绕过节流。`childSessionIds` 集合就是为此存在：它活到 deleted 事件被消费掉。
- **写盘必须保留非受管内容**：USER.md / MEMORY.md 的 parse 只投影受管集合（分类小节 + `- [日期]` 条目），其余（协议块、用户自写标题、散文、未知 `##` 小节）现在由 `preamble` / `section.extras` 原样带回。曾经因为直接丢弃，首次成功提炼就把 USER.md 的协议块冲掉了——协议块没了，AI 就不会再发 STYLE_SIGNAL，memx 从第二轮起静默失效。
- **`context` hook 是全插件最要害的一段**：每个 step 都跑在宿主组装管线上，写坏 `event.system` 的表现是"模型静默变笨"而不是报错。两条分支**顺序固定**：子会话（提炼）先判、**整体替换** system + temperature 0.2、注入绝不参与；其余会话**只 append 绝不替换**——hook 触发时 `event.system` 已含 `agent.system` + AGENTS.md 合并正文（`model-request.ts:110-116`），替换会抹掉宿主内容。hook 内不 await、任何异常退化为"不注入"，绝不半途写坏。
- **注入不伤缓存**：宿主 `cache:"auto"` 的断点打在"最后一个 distinct system part"，我们追加在尾部 → 注入内容**落在缓存前缀之内**。失效只发生在 USER.md/MEMORY.md 被改写时（节流 10 分钟 + 仅有信号时写，一个会话通常 0-1 次）。免费档走的是 opencode 网关，不在 `RESPECTS_INLINE_HINTS` 白名单（`cache-policy.ts:40-52`），靠提供商隐式前缀缓存，逻辑同理。
- **注入频率**：每个 step 一次；文件读走 `stat(mtimeMs+size)` 缓存，诊断写盘节流 5s。提炼（LLM 调用 + 写盘）每回合最多一次，10 分钟节流。
- **⚠️ 所有权缺口（未修）**：协议只约束"不要重复上报已记录的事实"，**没约束"不要改 AGENTS.md"**。2026-10-12 e2e 实测：模型把测试对话里的偏好当成用户真实偏好，自行写进全局 `~/.config/opencode/AGENTS.md`（10→26 行，已人工回滚）。而 AGENTS.md 是每会话必注入的竞争通道——在补上该约束前，system 前缀存在被模型自行改掉的风险。参照：Aider 把 conventions 文件标只读，就是为了不让模型改自己的记忆。
- **Src changes require an OpenCode restart** - plugins load once at startup; touching the entry file does NOT hot-reload. Config file changes apply immediately.
- **`exactOptionalPropertyTypes`** in tsconfig: optional fields like `target_line?: number` cannot be explicitly set to `undefined`. Use `target_line != null` checks instead of loose equality. Use `.nullish()` in Zod for nullable optional fields.
- **`noUncheckedIndexedAccess`**: array access returns `T | undefined`. Always use `[0] ?? fallback`.
- **No `bun:test`**: environment has Node.js + vitest, not Bun. Don't import from `bun:test`.
- **Design docs**: `prd.md` is reference only - don't treat it as code.
- **`.opencodeignore`**: repo convention file (gitignore style) listing paths agents should not read or modify (`prd.md`, `docs/`, `.superpowers/`, etc.). Honor it even though opencode has no built-in support.
- **Signal capture is HTML comment parsing** (<5ms): never call LLM in Stage 1 (runs inside the `session.execution.succeeded` event handler). Main AI emits `<!-- STYLE_SIGNAL: ... -->` / `<!-- MEMORY_SIGNAL: ... -->` comments; plugin parses them. 注意 `captureSignals` **只解析 AI 消息**（user 参数故意未用），且 `diag.lastCapture.styleHit` 只是子串正则——`styleHit:true` 但 `signalCount:0` 是正常的（AI 提到了这个词却没按注释格式输出）
- **The `reflect` tool** manually triggers BOTH tracks' refinement (fallback when the event trigger doesn't fire / is throttled)
- **判断插件真实状态永远查 kv 表**：`memx_status` 的格式化器只打固定字段（captured/refinements/written/failures/lastError/updatedAt），看不到 `evtCounts` / `lastCapture` / `rawContext`。sqlite3 命令见 Key facts 的 Diagnostics 条
- **Slug derivation**: `/root/project/foo` -> `root-project-foo` (path `/` -> `-`, strip leading/trailing). Avoid spaces/Chinese/special chars in working directory path.

## Test patterns

- **基线：12 文件 / 137 测试全绿 + `pnpm run typecheck` 0 错误**（低于即回归）。用 `pnpm test` / `pnpm run typecheck` 跑（仓库的 npm scripts 经 pnpm 调用；**不要 install、不要动 lockfile**）
- Tests use `vitest` API (`describe`, `it`, `expect`)
- LLM calls are mocked in refinement tests (`refine` / `refineMemory`)
- Tests mock `homedir` to a tmp home - they must NEVER touch real `~/.opencode` files
- **每个测试文件用自己独立的 tmp home**（如 `/tmp/memx-test-home-<文件名>`）：共享一个 tmp home 时，并行线程下某文件的 `afterAll` 清理会把别的文件的状态删掉，报出假失败。撞上可疑竞态先 `rm -rf /tmp/memx-test-home*` 再跑一遍确认
