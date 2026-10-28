# ARCHITECTURE.md — 架构与数据流

> 最后更新: 2026-10-25 · commit `c232168`

## 1. 分层总览

```
┌─ hosts/opencode/ ─────────────────────────────┐   ┌─ hosts/dsh/ ──────────────────────┐
│ 事件订阅、游标、4 工具、kv 诊断、子会话 LLM、   │   │ 注入段、3 工具、轮末补记、         │
│ 报警装配、同步接线（唯一 import @opencode）    │   │ ctx.llm 适配（零 @deepseek import）│
└──────────────┬────────────────────────────────┘   └───────────────┬───────────────────┘
               ↓ 单向依赖（见 §4）                                   ↓
┌─ core/ ───────────────────────────────────────────────────────────────────────────────┐
│ 零宿主依赖：pipeline（SessionPipeline）/ 信号 / 提炼 / 写盘 / 检索 / 健康 / 注入 /    │
│ 报警 / 同步 / 配置 / 协议                                                              │
└───────────────────────────────────────────────────────────────────────────────────────┘
               ↑
┌─ scripts/ ─────────────────────────────────────┐
│ 阶段 4 CLI：doctor / sync-dry-run / sync-op /   │
│ alerts / sync-protocol（node strip-types 直载） │
│ 与插件共用同一套 core 实现，不是第二套           │
└────────────────────────────────────────────────┘
```

分层是 2026-10-11 阶段 1 的行为等价迁移成果，并在 #17 兑现了多宿主红利：**core 不知道宿主是谁**，宿主壳只做参数映射与回执文案。两个宿主壳共享 `core/pipeline/session.ts`（流水线）、`core/memory-write.ts`（写路）、`core/alerts.ts`（账本）与全部 store/refine 逻辑。CLI 同样只消费 core（`scripts/doctor.ts` 直接 import `core/alerts.ts`、`core/config.ts`、`core/sync.ts`）。

## 2. 钩子与接线

### 2.1 OpenCode 宿主契约（`src/hosts/opencode/index.ts`，695 行）

插件在 `setup(ctx)` 里注册，全部 try-catch，错误绝不抛回宿主：

| 钩子 / 接线 | 用途 | 关键实现 |
|------|------|----------|
| `event("session.execution.succeeded")` | 每回合结束 → 捕获 + 提炼（受节流） | 先 Track 1 后 Track 2 串行；负载取 `event.data.sessionID` |
| `event("session.deleted")` | 删该会话的捕获游标（`cursor:<sessionID>`） | 只删游标，不拉历史 |
| `session.hook("context")` | 每个 model step 注入 system prompt | `context-hook.ts` 两条互斥分支（见 §5） |
| `ctx.tool.transform` | 注册 reflect / memory_write / forget / memx_status | memory_write 声明 `options: { codemode: false }` |
| `dispose` | 宿主退出 → 强制冲刷缓冲 | 与 session.deleted 共用 `flushAll` |
| **流水线装配** | `new SessionPipeline({...} satisfies PipelineHost)` | `createLLM` 造子会话客户端；`onMemoryWritten` 推同步；`decorateIndex` 套面包屑 |
| **报警装配** | `recordAlert()` → `AlertStore.append` + `diag.alerts` 镜像 | `core/alerts.ts`；写 MEMORY.md 前套 `applyAlertBreadcrumb` |
| **同步接线** | 配置启用时 `createSync` + 启动拉一次 + 定时拉 | 推触发点三处（见 §9.2），全部 `void` |

兜底触发：`reflect` 工具（`force=true` 绕节流）。

### 2.2 DSH 宿主契约（`src/hosts/dsh/index.ts`，743 行）

| memx 需要的能力 | DSH 接法 | 实现位置 |
|----------------|----------|----------|
| 注入 | `ctx.systemPrompt.section({ name: "memx:memory", order: 12000, interpolate: false, text })` | `apply()` ① |
| 工具 | `ctx.tools.register(defineTool)` × 3（memory_write / memory_search / forget） | `apply()` ② |
| 回合结束 | `ctx.on("session/event")` 过滤 `turn/start` / `assistant/message` / `turn/end` | `apply()` ③ |
| 提炼 LLM | `ctx.llm.stream({provider, model, system, messages})` → core `LLMClient` | `dsh/llm.ts` |
| 清理 | 无等价物（DSH 无删会话）；本层不维护跨会话游标 | — |
| 诊断 | 内存对象 + `ctx.logger.warn("[memx] …")` | `diag`（无持久化） |
| 报警 | `createFileAlertStore()` → 同一份 `~/.opencode/memx-alerts.json` | `apply()` |
| 依赖声明 | `export const name` / `inject` / `Config` / `apply`（**具名导出，与 OpenCode 相反**） | 文件顶层 |

DSH 侧**没有** `context` hook 的两分支补丁：提炼是一次性 `llm.stream` 调用，不造子会话，因此不需要"子会话整体替换 system"、不需要 `childSessionIds` 防自激环、也不需要 `codemode:false`。详见 [modules/host-dsh.md](modules/host-dsh.md)。

**加载方式**：本仓 `src/hosts/dsh/` 是适配器源码，不能被 `dsh plugin add` 直接加载；接线由**独立仓**薄壳包 `dsh-plugin-memx`（`~/workspace/self-dsh-plugins/dsh-plugin-memx`）完成——它 link 进 `~/.dsh/profiles/web`、在 `cordis.patch.yml` 注册 `id: memx`、用 TypeScript load hook 直接加载本仓 `index.ts`，并声明四个 `.volatile()` 配置 + Web 设置页「记忆」。**已实际安装运行**；改本仓 `src/hosts/dsh/**` 后重启 dsh web 即可。

## 3. 双轨管道（一条流水线，两套独立状态）

```
信号产生（主 AI 按协议发 HTML 注释）
   ↓
回合结束事件：OpenCode session.execution.succeeded / DSH turn/end
   ↓
捕获：OpenCode planCapture 游标增量（fresh / resumed / anchor-lost）
      DSH captureMemorySignals(turnText)（本层无游标）
   ↓  captureSignals / captureMemorySignals：正则解析入内存缓冲（上限 20、evidence 去重、FIFO）
   ↓
SessionPipeline.refineStyle / refineMemory（core，宿主无关）
   ├─ 节流门（in-memory lastRunAt，默认 10 分钟；markRun 在 LLM 调用前置位）
   ├─ inFlight 互斥（force=true 时等待）
   └─ refine() / refineMemory()：LLM 批量裁决 → RefineOutcome 三态
        ├─ proposals           → 落盘
        ├─ adjudicated-empty   → 清缓冲结案（合法空数组 ≠ 坏输出）
        └─ invalid-output      → 保留缓冲重试；连续 3 次丢弃 + alert
   ↓
withFileLock（锁文件 + mtime TTL 30s；锁内重读文件；LLM 调用绝不进锁）
   ↓
applyProposals / applyMemoryProposals：单遍应用（parse 一次 → 内存改完 → serialize 一次）
   ├─ Track 1：append 前归一查重；落盘 dedupeUserMd 两遍自愈
   └─ Track 2：卡片 + 索引 upsert + 同锁内健康检查 → decorateIndex（面包屑）→ 写索引
   ↓
USER.md / MEMORY.md + .mem/*.md（写前备份留 5 版；tmp 写 + rename 原子替换）
   ↓
注入：两宿主同一份来源（协议 → 画像 → 当前节 + related）
      OpenCode 每 step append；DSH 每会话一次 section（字节恒定）
   ↓（Track 2 写盘成功后，仅 OpenCode 壳接线）
void sync.push()（PII 扫描 → 串行锁 → git；异步不 await，绝不阻塞写盘）
```

两条轨道共享触发链与流水线，但**信号缓冲、提炼提示词、三态计数、写盘目标完全独立**（`SessionPipeline.inFlight` 防并发风暴）。

## 4. core / hosts 边界（红线）

- `src/core/**` 禁止 import `@opencode-*` **与 `@deepseek-ai/*`**——这是多宿主分层的唯一保证，破了适配成本翻倍。`alerts.ts` / `sync.ts` 也遵守：报警 store 由宿主注入，sync 只依赖注入的 `GitRunner`。
- OpenCode 壳单向依赖：`index.ts` → `session-llm.ts` → `context-shape.ts`；**`session-llm.ts` 绝不能回头 import `index.ts`**（成环）。共享逻辑一律下沉 `context-shape.ts`（`toMessages` / `planCapture` 两文件共用）。
- DSH 壳：`index.ts` → `llm.ts` → `core/refine/refinement.ts`（仅 `LLMClient` 类型）；`types.ts` 纯类型。`src/hosts/dsh/**` **零 `@deepseek-ai/*` import**（包依赖里没有 DSH，也不 install）。
- `LLMClient` 接口定义在 `core/refine/refinement.ts`（`chat({system, messages, temperature?, maxTokens?, model?})`）——两个宿主各自实现：OpenCode 用子会话五步法，DSH 用 `ctx.llm.stream`。
- 宿主差异一律经 `PipelineHost` 窄口（`loadConfig` / `createLLM` / `recordAlert` / `persist` / `decorateIndex` / `onMemoryWritten`），不把宿主 ctx 漏进 core。
- CLI 脚本与插件**共用 core**（`pnpm sync:op` 走同一个 `createSync`）；不允许出现"第二套实现"。

## 5. context hook：OpenCode 侧最要害的一段

`context-hook.ts` 的 `applyContextHook` 在**每个 model step** 跑在宿主组装管线上，写坏 `event.system` 的表现是"模型静默变笨"而非报错。两条分支互斥、顺序固定：

1. **子会话（memx 自己的提炼调用）** → `childSessions` map 命中 → **整体替换** system 为提炼提示词 + `temperature = 0.2`，注入绝不参与。（注入漏进提炼调用 = 把协议+画像+索引塞进"只输出 JSON 数组"的调用里，提炼质量塌掉且是免费档 403 高危。）
2. **其余会话** → **append 绝不替换**。（hook 触发时 `event.system` 已含 agent.system + AGENTS.md 合并正文，替换会抹掉宿主内容。）

hook 回调本身同步：文件读走 stat(mtimeMs+size) 缓存，配置走 30s TTL 快照，不在此 await；任何异常退化为"不注入"。

### 自激循环防御（`childSessionIds`）

`session-llm` 的 finally 先 `remove` 再 `onRemoved`，`childSessions` 在 `session.deleted` 事件到达**之前**已清空；事件处理器只看它会把"删自己的子会话"误判成用户删会话（那支 `force=true`）→ 再生子会话 → 10 秒 106 个子会话的实机事故。`childSessionIds` 集合活到 deleted 事件被消费为止，专防此环。**DSH 侧无此问题**（不造子会话）。

## 6. 正确性机制

| 机制 | 文件 | 要点 |
|------|------|------|
| 增量捕获游标（P0-1，仅 OpenCode） | `hosts/opencode/context-shape.ts` + index.ts | 游标锚消息 id 存 `ctx.storage` 的 `cursor:<sessionID>`；锚点丢失退全量扫（缓冲去重兜底） |
| 提炼三态（P0-2） | `core/refine/refine-outcome.ts` + `core/pipeline/session.ts` | proposals / adjudicated-empty / invalid-output；连续坏输出 3 次上限（报警码 `REFINEMENT_FAILURE_STREAK`） |
| 单遍写盘 + 内容锚点（P0-3） | `core/store/user-md.ts` / `memory-md.ts` | 一批提案 parse 一次、改一次、serialize 一次；update/deprecate 定位：target_text 精确 → 归一 → 唯一包含 → target_line 兜底，降级全记 `diag.lastWarnings` |
| 跨进程文件锁（P0-4） | `core/store/lock.ts` | wx 独占创建 + mtime TTL 30s 夺锁 + 等锁超 5s 抛 `FileLockTimeoutError`；**只包 read-modify-write，绝不包 LLM** |
| 健康日志迁出（P0-5） | `core/health/memory-health.ts` | auto-fix 结果只落 `diag.health` / alerts；**不再追加健康日志进 MEMORY.md**。唯一例外是**一行自替换报警面包屑**（见 §9.1） |
| Track 1 去重自愈 | `core/store/user-md.ts` | `normalizeAnchor` 归一；append 前查全 doc 同文 active；落盘 `dedupeUserMd` 两遍扫描；命中写 `diag.lastWarnings`（`自愈：…`） |
| 报警单一事实源 | `core/alerts.ts` | 账本文件为准，`diag.alerts` 只写镜像；剪龄 7 天 + 封顶 200；成功即销账（`resolve(code)`） |
| 检索只读 | `core/store/memory-search.ts` | 索引 slug ∪ 磁盘 slug（兜孤儿）；不写盘不加锁，最多看到上一版本 |
| DSH 注入字节恒定 | `hosts/dsh/index.ts` | 每 agent 一次求值 + WeakMap 缓存；文本里**无时间/计数/随机** |

## 7. 诊断体系

- **OpenCode 首选 `pnpm run doctor`**（`scripts/doctor.ts`）：只读面板四段（alerts / memory files / opencode diag / sync），不联网不写盘、退出码恒 0。⚠️ 不要用 `pnpm doctor`（pnpm 内建同名命令会静默接管）。
- **OpenCode 结构化诊断在 `ctx.storage`**（sqlite kv），键为 `"diag:" + deriveSlug(目录)`：
  - **键按目录隔离**：`ctx.storage` 的键是全局的，所有实例写同一行会互相覆盖；slug 隔离后同目录多实例仍会打架（`opencode run --server` 也会实例化插件）——排查优先看 serve 日志。
  - 首次出现时用旧全局 `diag` 值做一次性种子迁移。
  - `diag.alerts` 是**只写镜像**；读报警请用 `AlertStore`（doctor / `memx_status` 的 alerts 段）。
- **`memx_status` 工具输出不是真相**：只打固定字段（captured/refinements/written/failures/lastError/updatedAt + inject.*），`evtCounts` / `lastCapture` / `rawContext` 只在 kv 行里。查询命令见 [DATA.md](DATA.md) §4。
- **DSH 侧诊断只在内存**（`DshDiagnostics`：injections / capturedTurns / toolWrites / notices / skipped.* + 流水线字段），`persist` 为空实现；异常走 `ctx.logger.warn("[memx] …")` 落宿主日志。**DSH 没有 `memx_status` 工具**，也没有 kv 行。

## 8. 注入与缓存

- 三块内容顺序：协议 → 画像 → 索引；各 200 行 / 25KB 上限（先到先算），截断追加可见提示行 `[memx: truncated — ...]`，绝不静默截断。
- OpenCode：三块各占一个 SystemPart，append 在尾部，落在宿主 `cache:"auto"` 的断点之内——**注入本身不伤缓存**；失效只发生在 USER.md/MEMORY.md 被改写时。
- DSH：一个 section（`order: 12000`，`interpolate: false`），文本 = 三块 join；**每会话只算一次**，字节恒定是缓存前提。代价：本会话新写的记忆本会话不可见（下个会话生效）。
- 注入范围闸门 `inject.{enabled,includeAgents,excludeAgents}`：`enabled=false` 一个字节不注入；生效集合 = include 减 exclude；**代码里不硬编码任何 agent 名**。⚠️ **该闸门目前只在 OpenCode 壳生效，DSH 壳未接**（已知缺口，见 [CONVENTIONS.md](CONVENTIONS.md) §5）。

## 9. 阶段 4 架构

### 9.1 报警账本

```
recordAlert(level, code, message)   ← 提炼失败 / 游标丢失 / 健康问题 / 同步故障
   ├─→ AlertStore.append  →  ~/.opencode/memx-alerts.json（封顶 200、剪龄 7 天）
   └─→ diag.alerts.push   →  kv 只写镜像（仅 OpenCode；DSH 无 kv）

读侧（三条，全走 store）：
   ├─ MEMORY.md 首行面包屑  ← applyBreadcrumbLine（core/memory-write.ts 的共享实现；
   │                          host 传入 formatBreadcrumb(alertStore) 算好的字符串，两条写路都用它）
   ├─ pnpm run doctor       ← formatAlertsPanel（counts + 最近 10 条）
   └─ memx_status 的 alerts 段 ← 以 store 为准（不是 kv 镜像；仅 OpenCode）

销账：成功路径调用 store.resolve(code)（同步三处成功分支都会 resolve SYNC_ERROR / SYNC_PUSH_FAILED）
手工：pnpm alerts:clear [--code=X] [--dry-run]
```

设计要点：
- **面包屑走 preamble**：只有一行、每次写盘自替换（先删旧 `<!-- memx:` 行再插），因此不违反 §6 的"非受管内容保留"契约——它属于 preamble 而非健康日志流。
- **容错优先**：坏 JSON 从空开始、目录不存在自动建、任何 IO 失败吞掉不抛（插件不能崩）。ts 不可解析的事件**保留**（宁可多留不可误删）。
- **去重**：`sync` 模块内的 alert 跳过与上一条完全同 code+message 的记录（离线机器每 30 分钟失败一次，不去重会刷满账本）。

### 9.2 多机云同步（默认关，仅 OpenCode 壳接线）

```
配置 sync.enabled=false（默认）→ 不注册定时器、不 clone、零副作用
配置启用（enabled=true 且 machineName 非空）→ setup 时：
   void sync.pull({ force: true })（启动拉一次）+ setInterval(pull, intervalMinutes)

push 触发点（三处，均 void 不 await）：
   SessionPipeline 的 onMemoryWritten（Track 2 写盘成功；index.ts:252）
   memory_write 工具成功后（index.ts:569）
   forget 工具成功后（index.ts:601，issue #21：不推会被下一轮 pull 拉回）

push 流程：scanSensitive(全部待推文件) → block 层命中即拒推 + SYNC_PII_BLOCKED critical；
        alert 层照推 + SYNC_PII_ALERTED warn，明细落 lastPiiScan / piiAlertLog（issue #33 分层）
        → withFileLock(.memx-sync.lock, ttl 10min / 等锁 5min) 内：
             copy → 删除传播（基线里存在且本地已删 → 从 workdir 删）
             → git status（文件差异）+ git rev-list --count @{u}..HEAD（未推提交）
             无文件差异且无未推提交 → no-change 收工
             有未推提交（哪怕无文件差异）→ 照样 push（不造空提交）
             有差异 → add → commit（身份兜底）→ push
             被拒（非快进）→ fetch + rebase + 重试一次 → 再失败 SYNC_PUSH_FAILED warn
        → 状态写 memx-sync-state.json（含 unsyncedCommits / lastRemoteSha）→ 成功 resolve 报警

pull 流程：锁内 fetch → 前置短路（ls-remote sha 未变 → 只刷 lastPullAt）
        → 远端删除（--diff-filter=D，本地先 .bak.<ts> 再 unlink）
        → 逐文件比对（远端优先，覆盖前 .bak.<ts>）
        → 冲突则 rebase --abort + SYNC_CONFLICT critical（留人工）
```

镜像范围（`walkMirror`）：`USER.md` + `MEMORY.md` + `projects/<slug>/.mem/**/*.md`，**排除** `.trash/`（文件名带时间戳，跨机互推必冲突）与 `.bak.*`。细节见 [modules/sync.md](modules/sync.md)。

关键设计：
- **GitRunner 注入**：编排与真实 git 解耦（默认 `spawnSync`，超时 120s）；测试注入脚本化假 runner，另有一条真实 git 端到端。
- **串行闸门用文件锁而非内存互斥**：插件每进程一实例，且同一实例里两次快速写盘也会并发 `void sync.push()`。
- **PII 扫描在锁外**，锁窗口只含 git 动作。
- **远端地址**：`owner/name` → `git@github.com:<owner>/<name>.git`；完整 URL / 绝对路径 / `file:` 原样使用。
- **开启 sync 要改配置并重启宿主**：配置只在 setup 读一次（与 `refinementModel` 的"即时重读"语义不同）。
- **已知限制**：不做逐行合并（rebase 冲突即 abort）；pull 不持记忆文件锁（最后写者胜，靠 `.bak.` 兜底）；删除传播依赖基线（首次同步那一轮保守不删）。

### 9.3 CLI 与冒烟测试

- CLI 全在 `scripts/`，由 `package.json` scripts 暴露：`pnpm run doctor` / `pnpm sync:dry-run` / `pnpm sync:op` / `pnpm alerts:clear`；`sync-protocol.ts` 直接 `node --experimental-strip-types` 调用。
- 走 `node --experimental-strip-types` **直接加载 `.ts`**——因此**相对 import 必须带 `.ts` 扩展名**（缺了 tsc/vitest 都发现不了，运行时才 `ERR_MODULE_NOT_FOUND`）。
- `tests/scripts-smoke.test.ts` 真跑脚本兜这条：值导入缺扩展名只有真跑才炸。
