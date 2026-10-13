# memx - Agent Guide

## Project

OpenCode V2 dual-track memory plugin. Track 1: captures user style preferences (cross-project, slow-changing) via `STYLE_SIGNAL` HTML comments -> refines to `~/.opencode/USER.md`. Track 2: captures project-scoped memory (ongoing work, external resources, feedback) via `MEMORY_SIGNAL` HTML comments -> refines to `~/.opencode/MEMORY.md` index + `~/.opencode/projects/<slug>/.mem/*.md` files. Both tracks share the same trigger pipeline (`session.execution.succeeded` / `reflect` / `dispose`) but have separate signal buffers, refinement prompts, and write targets.

## Commands

```bash
pnpm test          # vitest run
pnpm run typecheck # tsc --noEmit
pnpm run doctor    # node --experimental-strip-types scripts/doctor.ts — 只读状态面板
pnpm sync:dry-run  # 只读预览云同步待推内容（加 `-- --fetch` 先对齐远端，见「多机云同步」）
```

⚠️ 必须用 `pnpm run doctor`，**别用 `pnpm doctor`**——pnpm 自己有同名内建命令，`pnpm doctor` 会静默跑成 pnpm 自检而不是 memx 面板（`sync:dry-run` 无此冲突）。

Always run `typecheck` before committing - TypeScript strict mode catches easy-to-miss errors.

## Key facts

- **Entry point**: `src/hosts/opencode/index.ts` default-exports the V2 `Plugin`. The host-side entry `~/.config/opencode/plugins/memx.ts` re-exports ONLY `default` from it - never widen that re-export or add named exports at the entry, extra exported functions get invoked as plugins and crash OpenCode (`plugin config hook failed`)
- **Hooks**: `event` (订阅 `session.execution.succeeded` + `session.deleted`) + `session.hook("context")` (子会话 system 替换/注入) + `tool.transform` (`reflect` / `forget` / `memx_status` / `memory_write`) + `dispose`
- **Install**: `~/.config/opencode/plugins/memx.ts` re-exports `default` from `src/hosts/opencode/index`
- **Model override**: `~/.opencode/memx.config.json` 的 `refinementModel` (`provider/model` 格式), 运行时每次读取 - 改配置**无需重启**. Default: `opencode/mimo-v2.6-flash-free` (**生产目标**——生产 opencode 无 `opencode-go` provider)。**本机开发**用 `~/.opencode/memx.config.json` 覆盖成 `opencode-go/longcat-2.5-preview-free`（本机免费档被网关 403/429 挡）。**遇到问题停下报告，不降级不换模型**；deepseek 官方 key 无效，不要用
- **LLM calls**: 子会话 `session.create({title, model: ModelRef})` -> `session.prompt({sessionID, text})` -> `session.wait` -> `session.context` 取 assistant 全文 -> `session.remove` (finally), 见 `src/hosts/opencode/session-llm.ts`. 提炼 system 提示词靠 `context` hook 的 `event.system` 替换注入
- **Track 1 paths**: `~/.opencode/USER.md` (hardcoded in `src/core/store/user-md.ts`)
- **Track 2 paths**: `~/.opencode/MEMORY.md` (index) + `~/.opencode/projects/<slug>/.mem/*.md` (content), hardcoded in `src/core/store/memory-md.ts`. Slug derived from plugin's `directory` context via `deriveSlug()` in `src/core/memory-types.ts`
- **Backup rotation**: `writeUserMd` / `writeMemoryIndex` auto-backups before every write, keeps 5 versions
- **All hooks try-catched**: never let plugin errors reach the host
- **LLM returns Zod-validated**: `StyleProposalArraySchema` in `src/types.ts` (Track 1) + `MemoryProposalArraySchema` in `src/memory-types.ts` (Track 2); `extractJson` strips markdown fences before parse
- **Conflict handling**: when a new memory contradicts an existing one, LLM returns `deprecate` (old) + `append` (new, with `supersedes` field). Code writes `**Supersedes:**` audit line in new file, moves old file to `.mem/.trash/` (not physically deleted)
- **Health check**: `runHealthCheck` runs after each memory refinement in `reflect` / `session.execution.succeeded`. Detects dead links (index points to non-existent files) and orphan files (`.mem/*.md` not in index). Auto-fixes with guardrail: max 3 per run, logs as HTML comments in MEMORY.md, escalates bloat/conflicts to manual
- **Alerts（阶段 4）**: 单一事实源 `~/.opencode/memx-alerts.json`（JSON 数组，封顶 200 条，超出丢最旧；`src/core/alerts.ts`，零宿主依赖，坏 JSON/IO 失败容错不抛）。`memx doctor`（`scripts/doctor.ts`，命令是 **`pnpm run doctor`**）出只读面板（alerts / memory files / opencode diag / sync 四段，退出码恒 0）。MEMORY.md 只有可能的一行 `<!-- memx:` 面包屑（有 warn/critical 时插在文件第一行，走 preamble，不含健康日志/报警列表）；`diag.alerts`（kv）保留为只写镜像，`memx_status` 的 alerts 段以 store 为准
- **多机云同步（阶段 4 第二半）**: `src/core/sync.ts`（零宿主依赖，GitRunner 接口可注入，默认 `child_process.spawnSync`）。**默认关**（`sync.enabled=false`，machineName 为空同样不启动——不注册定时器、不 clone）。启用后：启动时 `void sync.pull()` 一次 + `intervalMinutes` 定时拉；**推触发点** = `runMemoryRefinement` 写盘成功后 + `memory_write` 工具成功后（`void sync.push()` 异步不 await，绝不阻塞写盘）。工作目录 `~/.opencode/memx-sync-repo/`（不存在则 clone，存在则 fetch）；push 被拒（非快进）→ fetch+rebase+重试一次，再失败记 `SYNC_PUSH_FAILED` warn；pull 冲突 → `rebase --abort` + `SYNC_CONFLICT` critical，留人工。状态落 `~/.opencode/memx-sync-state.json`（doctor 读最近 push/pull/PII 扫描事实）。开启 sync 要改 `memx.config.json` **并重启宿主**（配置只在 setup 读一次）
  - **身份兜底**：新 clone 的 workdir 未必有 git 身份（prod 就没配过）→ commit 前探 `git config user.email`，没有就用 `-c user.name=memx-sync -c user.email=memx@localhost` 现造一个；有真身份时不覆盖
  - **拉取备份**：pull 是**远端优先**，覆盖前若本地内容与远端不同，先把本地存成 `<file>.bak.<ts>`（每文件保留最新 5 份，`.bak.` 不入镜像）。没有这一步会静默吞掉本地未推的改动（首合并、推送失败后尤其危险）
  - **报警去重**：`sync` 模块内的 `alert()` 会跳过与上一条完全同 code+message 的记录——离线机器的定时拉每 30 分钟失败一次，不去重会把 200 条账本刷满同一行
  - **已知限制（v1 有意不做）**：删除不传播（本地删掉的文件会留在仓里，远端删掉的会在下次 pull 时被本地版本推回）；不做逐行合并（同一文件两台机器都改 → 靠 git rebase，冲突即 abort 留人工）；仓库地址硬编码 SSH（`git@github.com:<repo>.git`）；**pull 不持文件锁**（与提炼写盘并发时最后写者胜，靠覆盖前 `.bak.` 备份兜底）
- **PII 脱敏闸门**: `push()` 先对**全部待推文件**跑 `scanSensitive()`（`src/core/sync.ts`，8 类规则：openai-key / aws-access-key / github-token / github-pat / slack-token / jwt / private-key / env-assignment），命中即**拒推** + `SYNC_PII_BLOCKED` critical alert，只报**行号+规则名**，绝不回显内容。`pnpm sync:dry-run`（`scripts/sync-dry-run.ts`）只读预览（config / 待同步清单+双向行数 / PII 命中 / 远端 git log，**永不 push**，退出码恒 0）；加 `-- --fetch` 会先 clone/fetch 到缓存 workdir（**只动 workdir，不碰 `~/.opencode` 记忆文件**）——首合并预演（新机器第一次拉之前想看清远端有什么）必须用这个模式，否则 workdir 不存在、报告只会写「远端未取到」
- **Concurrency guard**: `runRefinement` + `runMemoryRefinement` share mutex (`refinementInFlight`), `markRun()` fires BEFORE the LLM call - both prevent child-session storms / duplicate writes when events overlap. Throttle is **in-memory only** (`lastRunAt`), so restarting the host resets it
- **捕获游标（P0-1）**: per-session 增量游标锚在**消息 id** 上，存 `ctx.storage` 的 `cursor:<sessionID>`；决策全在 `planCapture()`（`context-shape.ts`，纯函数可单测：fresh / resumed / anchor-lost），host 侧只做 storage 读写与信号解析。`session.deleted` 时删游标。**别再拿 `extractLastTurn` 做捕获**（它留给 session-llm 取子会话回复），否则又退回"只扫最后一轮"
- **提炼三态（P0-2）**: `refine()` / `refineMemory()` 返回 `RefineOutcome`（`refine/refine-outcome.ts`）：`proposals` 落盘；`adjudicated-empty` **清缓冲结案**（合法空数组 ≠ 坏输出，否则同批信号每轮重烧 LLM）；`invalid-output` 保留缓冲 + `diag.invalidStreak` 计数，连续 3 次才丢弃并记 alert
- **写盘（P0-3 / P0-4）**: 整批提案走 `applyProposals` / `applyMemoryProposals` **单遍应用**（parse 一次 → 内存改完 → serialize 一次）；read-modify-write 包 `withFileLock(userMdLockPath()|memoryIndexLockPath(), …)`，**锁内重读文件**再应用（消掉快照读→写盘窗口里的丢更新）。update/deprecate 定位顺序：`target_text` 精确 → 归一（去空白/markdown 装饰）→ 唯一包含 → `target_line` 兜底；降级与未命中都写 `diag.lastWarnings`，绝不静默改错条目
- **健康日志（P0-5）**: `runHealthMaintenance()` 返回 `{index, logs, report}`，logs 只进 `diag.health` / alerts；**不再把 `formatHealthLog()` 追加进 MEMORY.md**（那些 HTML 注释会被下一次序列化吃掉，是历史 bug）
- **显式写入（出口①，issue #82 §B）**: `memory_write` 工具 → `core/memory-write.ts` 的 `writeProjectMemory(slug, input)` → 与后台提炼**同一条写路**（`applyMemoryProposals` 单遍 + `withFileLock` 锁内重读索引）。写盘逻辑放 core 的理由 = 多宿主（opencode 今天、DSH 未来）只有一份格式/锁实现，宿主壳只做参数映射与回执文案。同名同类型 = 修订（update）；纯中文名走确定性哈希文件名（否则每次写都新建文件，更新语义失效）。**工具声明 `options: { codemode: false }`**——2026-10-12 真机实测：默认 codemode 会把调用包成 `execute` 工具（参数在 `state.input.code`、结果在 `state.content`），App 按工具名渲染的回执 chip 认不出来；直调后 `part.tool` 就是 `memory_write`
- **v2 工具结果形状（2026-10-12 真机实测）**: 工具结果在 **`state.content: [{type:"text",text}]`**，**不是 `state.output`**（`state` 字段实测只有 `status/input/content/metadata`）。App/宿主侧消费工具输出时别再只读 `output`
- **Child-session guard**: `childSessions` map (sessionID → system) for the `context` hook, PLUS `childSessionIds` set that lives until the child's `session.deleted` event is consumed - see the self-excitation trap in Quirks. Both are populated in `onCreated`
- **Diagnostics**: v2 has no `client.app.log` - structured diagnostics go to `ctx.storage` under `"diag:" + deriveSlug(ctx.location.directory)`. **The tool output is not the truth** (`memx_status` prints fixed fields only); read the kv row directly: `sqlite3 ~/.local/share/opencode/opencode.db "SELECT value FROM kv WHERE key LIKE 'plugin:%'"` (namespace = `plugin:` + "memx" as 4 hex digits per char)
- **Loading mechanism**: **插件自己在 `context` hook 里追加**三块 SystemPart 到 `event.system`——`~/.opencode/memx-protocol.md`（协议）+ `USER.md`（画像）+ `MEMORY.md`（索引），每块硬上限 200 行 / 25KB，截断时追加可见提示行。**⚠️ `opencode.json` 的 `instructions` 在 v2.0.26 是死字段**（宿主只从 AGENTS.md 组装，全仓无消费方），不要指望它注入。注入范围由 `memx.config.json` 的 `inject.{enabled,includeAgents,excludeAgents}` 控制，**代码里不硬编码任何 agent 名**
- **AGENTS.md prompts**: `~/.config/opencode/AGENTS.md` 是宿主唯一验证过的指令通道（memx **不写**它，见 Quirks 的所有权缺口）

## Architecture

> ✅ **2026-10-11 阶段 1 分层落地**：`src/` 已重排为 `core/`（signals/refine/store/health/llm/config/types，**零宿主依赖**——禁 import `@opencode*`）+ `hosts/opencode/`（插件壳 index.ts + session-llm 适配 + context-shape.ts）+ `cli/`（doctor，阶段 4）。行为等价迁移。
>
> ✅ **2026-10-12 阶段 2 V2 移植闭环**（`d79d248` / `50f36fa`）：v2-only 插件，端到端实测通过（STYLE_SIGNAL → 捕获 → 子会话提炼 → 写盘）。依赖已升到 `@opencode/plugin ^2.0.26`。**v2 契约陷阱见下方 Quirks——那几条都是实机打出来的，不要凭生成的 `.d.ts` 想当然**（其中 `session.prompt` 的 `text` 字段，生成的类型与在跑的二进制载荷校验就不一致）。
>
> ✅ **2026-10-12 阶段 3 P0 五项**（handoff-20261011 §4 阶段 3）：P0-1 捕获改 per-session 消息 id 增量游标（`planCapture`，游标存 `ctx.storage` 的 `cursor:<sessionID>`，锚点丢失退全量扫）；P0-2 提炼三态返回 + 连续坏输出上限（`refine-outcome.ts`）；P0-3 单遍应用 + 内容锚点寻址（`applyProposals`，target_text → 归一 → 唯一包含 → 行号兜底）；P0-4 USER.md/MEMORY.md 文件锁 + mtime TTL（`store/lock.ts`）；P0-5 健康日志不再写进 MEMORY.md（`runHealthMaintenance` 只回传 logs，落 `diag.health`）。

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
    refine/refine-outcome.ts   - RefineOutcome 三态（proposals / adjudicated-empty / invalid-output）+ 失败上限
    refine/memory-prompts.ts   - Track 2 system prompt constants
    refine/memory-refinement.ts- Track 2 LLM batch refinement + Zod validation
    store/user-md.ts           - read/write/parse/backup USER.md（parse→UserMdDoc，保留非受管内容；applyProposals 单遍 + 内容锚点）
    store/memory-md.ts         - MEMORY.md index + .mem/*.md + backup（同一保留契约；applyMemoryProposals 单遍）
    store/markdown-lines.ts    - 两个序列化器共用的空行边界工具（保幂等）
    store/lock.ts              - P0-4 文件锁（锁文件 + mtime TTL 夺锁；只包 read-modify-write，绝不包 LLM）
    sync.ts                    - 多机云同步（阶段 4 第二半）：GitRunner 可注入 + PII 闸门 + dry-run；状态落 memx-sync-state.json
    memory-write.ts            - 出口① 显式写入（memory_write 工具）→ 与提炼共用单遍应用 + 锁
    health/memory-health.ts    - Index health check (dead links, orphan files) + auto-fix with guardrails
    llm/throttle.ts            - 内存节流（宿主重启即重置）
  hosts/opencode/
    index.ts                   - Plugin 入口（只 default 导出）：event + context hook + tool.transform + dispose
    session-llm.ts             - LLMClient 适配：子会话 create→prompt→wait→context→remove
    context-shape.ts           - V2 消息形状：toMessages / extractLastTurn（上面两个文件共享）
  cli/                         - doctor（阶段 4）+ sync-dry-run（阶段 4 第二半）
tests/                         - 21 文件 / 314 测试（基线，低于即回归）
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
- **文件锁的边界（P0-4）**：`withFileLock` 只包 read-modify-write，**绝不能把 LLM 调用包进去**（持锁几十秒会把别的实例全卡住）。持锁者崩溃靠 mtime TTL 兜（默认 30s 可夺锁）；等锁超 `timeoutMs`（默认 5s）抛 `FileLockTimeoutError` → 落 `diag.lastError`、缓冲保留、下轮重试。锁文件是 `~/.opencode/.USER.md.lock` / `.MEMORY.md.lock`，正常路径下不该长期存在。
- **`ctx.storage` 的 cursor 键**：`cursor:<sessionID>` 与 `diag:<slug>` 同处全局命名空间；sessionID 全局唯一所以不冲突，但**不清就是垃圾行**——`session.deleted` 分支已负责删除。另：`ctx.storage.set` 的参数类型是 `Schema.Json`，用 `type` 别名（不是 `interface`）声明结构体才有隐式索引签名，否则 TS 报 not assignable
- **capture 全量重扫不是错误**：`planCapture` 找不到游标锚点（上下文被压缩/分叉裁掉）时会退回全量扫，靠缓冲的 evidence 去重；这是**预期降级**，会在 `diag.alerts` 留一条 `CAPTURE_CURSOR_LOST` warn，看到它别当崩溃处理
- **`context` hook 是全插件最要害的一段**：每个 step 都跑在宿主组装管线上，写坏 `event.system` 的表现是"模型静默变笨"而不是报错。两条分支**顺序固定**：子会话（提炼）先判、**整体替换** system + temperature 0.2、注入绝不参与；其余会话**只 append 绝不替换**——hook 触发时 `event.system` 已含 `agent.system` + AGENTS.md 合并正文（`model-request.ts:110-116`），替换会抹掉宿主内容。hook 内不 await、任何异常退化为"不注入"，绝不半途写坏。
- **注入不伤缓存**：宿主 `cache:"auto"` 的断点打在"最后一个 distinct system part"，我们追加在尾部 → 注入内容**落在缓存前缀之内**。失效只发生在 USER.md/MEMORY.md 被改写时（节流 10 分钟 + 仅有信号时写，一个会话通常 0-1 次）。免费档走的是 opencode 网关，不在 `RESPECTS_INLINE_HINTS` 白名单（`cache-policy.ts:40-52`），靠提供商隐式前缀缓存，逻辑同理。
- **注入频率**：每个 step 一次；文件读走 `stat(mtimeMs+size)` 缓存，诊断写盘节流 5s。提炼（LLM 调用 + 写盘）每回合最多一次，10 分钟节流。
- **⚠️ 所有权缺口（2026-10-12 已补软约束，仍未硬防）**：2026-10-12 e2e 实测——模型把测试对话里的偏好当成用户真实偏好，自行写进全局 `~/.config/opencode/AGENTS.md`（10→26 行，已人工回滚）。协议 v1.1.0 起加了规则 9（"Never write memory into any file yourself"，点名 AGENTS.md / opencode.json / README / 记忆文件本身，说明后果），但**这是系统提示词层面的软约束，不是文件级权限**——模型仍可能违例。真正的硬防要等宿主侧只读/白名单能力（真护栏恢复那条 backlog）或把 conventions 文件标只读。参照：Aider 把 conventions 文件标只读，就是为了不让模型改自己的记忆。
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

- **基线：21 文件 / 314 测试全绿 + `pnpm run typecheck` 0 错误**（低于即回归）。用 `pnpm test` / `pnpm run typecheck` 跑（仓库的 npm scripts 经 pnpm 调用；**不要 install、不要动 lockfile**）
- Tests use `vitest` API (`describe`, `it`, `expect`)
- LLM calls are mocked in refinement tests (`refine` / `refineMemory`)
- Tests mock `homedir` to a tmp home - they must NEVER touch real `~/.opencode` files
- **每个测试文件用自己独立的 tmp home**（如 `/tmp/memx-test-home-<文件名>`）：共享一个 tmp home 时，并行线程下某文件的 `afterAll` 清理会把别的文件的状态删掉，报出假失败。撞上可疑竞态先 `rm -rf /tmp/memx-test-home*` 再跑一遍确认
