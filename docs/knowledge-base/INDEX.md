# INDEX.md — 项目知识库索引总览

> 最后更新: 2026-10-15 · commit `fe26fa1`

## 使用说明

- **每次对话优先加载本文件**，建立全局认知后再按需加载对应模块文档。
- 改某条管道 → 加载对应 `modules/<名>.md`（signals / refine / store / injection / alerts / sync / host-opencode）。
- 记忆文件格式、落盘路径、诊断查询 → [DATA.md](DATA.md)。
- 安装、配置、命令、测试、调试 → [OPERATIONS.md](OPERATIONS.md)。
- 陷阱与修改红线 → [CONVENTIONS.md](CONVENTIONS.md)。
- DSH 宿主适配 → [DSH-ADAPT.md](DSH-ADAPT.md)。
- 面向普通用户的说明 → 仓库根 `docs/USER-GUIDE.md`（不属本知识库，别混淆）。
- **更新约定**：涉及架构/接口/数据模型变更时同步更新对应文档；纯实现细节不必更新。每份文档顶部标注最后更新日期 + commit 短 hash。

## 项目一句话定位

OpenCode V2 双轨记忆插件：主 AI 在回复里用 HTML 注释打信号标记 → 插件捕获 → 子会话 LLM 批量提炼 → 带锁写盘到本机 Markdown（`~/.opencode/`）→ 每个模型 step 自动注入回 system prompt，让 AI 跨会话记住「用户是谁、怎么协作」（Track 1 用户风格）和「这个项目在干什么」（Track 2 项目记忆）。阶段 4 追加：报警账本 + doctor 只读面板 + 多机云同步（可选，默认关）。

## 核心功能清单

| 功能 | 所属层 | 入口文件 |
|------|--------|----------|
| 插件总入口（事件订阅 + 工具注册 + 清理） | hosts | `src/hosts/opencode/index.ts`（default 导出 Plugin） |
| 信号捕获 Track 1（STYLE_SIGNAL 解析 + 缓冲） | core | `src/core/signals/signal-capture.ts` |
| 信号捕获 Track 2（MEMORY_SIGNAL 解析 + 缓冲） | core | `src/core/signals/memory-capture.ts` |
| 增量捕获决策（消息 id 游标） | hosts | `src/hosts/opencode/context-shape.ts`（`planCapture`） |
| Track 1 提炼（LLM 裁决 → StyleProposal[]，三态） | core | `src/core/refine/refinement.ts` + `prompts.ts` + `refine-outcome.ts` |
| Track 2 提炼（LLM 裁决 → MemoryProposal[]，三态） | core | `src/core/refine/memory-refinement.ts` + `memory-prompts.ts` |
| 子会话 LLM 适配（create→prompt→wait→context→remove） | hosts | `src/hosts/opencode/session-llm.ts` |
| USER.md 解析/序列化/单遍应用/锚点/去重自愈/备份 | core | `src/core/store/user-md.ts` |
| MEMORY.md 索引 + .mem/*.md 写盘/备份/forget | core | `src/core/store/memory-md.ts` |
| 跨进程文件锁（mtime TTL 夺锁） | core | `src/core/store/lock.ts` |
| 显式写入出口（memory_write 工具的写路） | core | `src/core/memory-write.ts` |
| 记忆库健康检查（死链/孤儿，auto-fix ≤3） | core | `src/core/health/memory-health.ts` |
| 报警账本（单一事实源 + 剪龄 + 销账） | core | `src/core/alerts.ts` |
| 多机云同步（Git 镜像 + PII 闸门 + dry-run） | core | `src/core/sync.ts` |
| system prompt 注入装配（三块、200 行/25KB 上限、agent 闸门） | core | `src/core/injection.ts` + `pipeline/injection-source.ts` |
| context hook 判定（子会话整体替换 vs 其余 append） | hosts | `src/hosts/opencode/context-hook.ts` |
| 信号协议唯一真源（v1.1.0） | core | `src/core/protocol-template.ts` |
| 配置加载（memx.config.json + Zod 默认值） | core | `src/core/config.ts` |
| 提炼节流（内存态，默认 10 分钟） | core | `src/core/llm/throttle.ts` |
| 4 个工具：reflect / memory_write / forget / memx_status | hosts | `src/hosts/opencode/index.ts`（`ctx.tool.transform`） |
| doctor 只读面板（alerts/记忆文件/kv/sync 四段） | scripts | `scripts/doctor.ts`（`pnpm run doctor`） |
| 同步 dry-run 预览 | scripts | `scripts/sync-dry-run.ts`（`pnpm sync:dry-run`） |
| 同步手工操作（status/pull/push/both） | scripts | `scripts/sync-op.ts`（`pnpm sync:op`） |
| 报警账本手工清理 | scripts | `scripts/alerts.ts`（`pnpm alerts:clear`） |
| 协议落盘脚本（幂等写 memx-protocol.md） | scripts | `scripts/sync-protocol.ts`（install.sh 第 5 步调用） |

> ⚠️ 历史文档里的 `src/cli/` **不存在**——阶段 4 的 CLI 全部落在 **`scripts/`**（doctor / sync-dry-run / sync-op / alerts / sync-protocol）。

## 技术栈表

| 类别 | 技术/库 | 版本 | 用途 |
|------|---------|------|------|
| 插件 API | @opencode/plugin | ^2.0.26 | `Plugin.define`：event / session.hook("context") / tool.transform / dispose |
| 宿主客户端 | @opencode/client | ^2.0.26 | 宿主插件加载环境需要；src/ 内无直接 import |
| 运行时校验 | zod | ^4.4.3 | 信号/提案/配置 schema；LLM 返回强制校验 |
| 语言 | typescript | ^7.0.2（dev） | strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess；noEmit，宿主直接加载 TS |
| 运行环境 | Node.js | ≥22.6（@types/node ^26.1.2） | ESM；CLI 脚本走 `node --experimental-strip-types` 直载 `.ts` |
| 测试 | vitest | ^4.1.10（dev） | 基线 **24 文件 / 338 用例** |
| 包管理 | pnpm | 仓库只维护 pnpm-lock.yaml | install.sh 强制 pnpm（无 pnpm 退出） |

## 仓库拓扑

```
memx/
├── src/
│   ├── core/                     # 零宿主依赖层（禁 import @opencode-*）
│   │   ├── types.ts              # Track 1：分类/来源/置信度/动作枚举、Signal/Proposal、USER.md 文档模型、Zod
│   │   ├── memory-types.ts       # Track 2：MEMORY_TYPES、Signal/Proposal Zod、deriveSlug()
│   │   ├── config.ts             # memx.config.json 加载（含 sync 段）+ 默认值
│   │   ├── protocol-template.ts  # 信号协议唯一真源（PROTOCOL_VERSION=1.1.0）
│   │   ├── injection.ts          # 注入装配纯函数（顺序/上限/截断提示/闸门真值表）
│   │   ├── pipeline/             # 宿主无关流水线（#17）：session.ts + injection-source.ts
│   │   ├── alerts.ts             # 报警账本（文件单一事实源 + 面包屑/面板格式化）
│   │   ├── sync.ts               # 多机云同步（GitRunner 注入 + PII 闸门 + dry-run 报告）
│   │   ├── memory-write.ts       # memory_write 工具的 core 写路（含确定性文件名哈希）
│   │   ├── signals/              # signal-capture.ts（T1）/ memory-capture.ts（T2）
│   │   ├── refine/               # prompts / memory-prompts / refinement / memory-refinement / refine-outcome
│   │   ├── store/                # user-md / memory-md / markdown-lines / lock
│   │   ├── health/memory-health.ts
│   │   └── llm/throttle.ts
│   └── hosts/opencode/           # OpenCode 宿主壳
│       ├── index.ts              # Plugin 入口（~880 行，只 default 导出）
│       ├── context-hook.ts       # context hook 纯逻辑（可测）
│       ├── session-llm.ts        # 子会话 LLMClient 适配 + toModelRef
│       └── context-shape.ts      # v2 消息形状归一 + planCapture/extractTurns（防环共享层）
├── scripts/                      # 阶段 4 CLI（node --experimental-strip-types 直载 .ts）
│   ├── doctor.ts                 # 只读状态面板（四段，退出码恒 0）
│   ├── sync-dry-run.ts           # 同步预览（永不 push）
│   ├── sync-op.ts                # 同步手工操作（与插件同一条 createSync 代码路径）
│   ├── alerts.ts                 # 报警账本清理（--code / --dry-run）
│   └── sync-protocol.ts          # 协议落盘（幂等）
├── tests/                        # 24 文件 / 338 用例；每文件独立 tmp home；fixtures/
├── install.sh                    # 6 步安装器
├── docs/knowledge-base/          # 本知识库
├── docs/USER-GUIDE.md            # 面向普通用户的说明
├── docs/handoff/                 # 阶段交接历史文档
├── prd.md                        # 历史 PRD，仅参考（.opencodeignore 排除）
└── .opencode-example/memx.config.json
```

## 模块依赖关系（文字版依赖图）

core 层自底向上：

```
types.ts / memory-types.ts / config.ts / store/markdown-lines.ts / store/lock.ts
   / llm/throttle.ts / refine/prompts.ts / refine/memory-prompts.ts / refine/refine-outcome.ts
   / injection.ts / protocol-template.ts / alerts.ts        ← 叶子（无内部依赖）
signals/signal-capture.ts    → types
signals/memory-capture.ts    → memory-types
store/user-md.ts             → types + markdown-lines
store/memory-md.ts           → memory-types + markdown-lines
refine/refinement.ts         → types + prompts + store/user-md（读现有画像）+ refine-outcome
refine/memory-refinement.ts  → memory-types + memory-prompts + store/memory-md + refinement(复用 LLMClient) + refine-outcome
health/memory-health.ts      → store/memory-md
memory-write.ts              → memory-types + store/memory-md + store/lock
sync.ts                      → config(类型) + alerts(类型) + store/lock
pipeline/injection-source.ts  → protocol-template + store/user-md + store/memory-md + injection
```

hosts 壳（单向，严禁回环）：

```
index.ts ──→ session-llm.ts ──→ context-shape.ts
   │             └──→ refinement.ts（仅 LLMClient 类型）
   ├──→ context-hook.ts ──→ core/injection.ts
   ├──→ core/alerts.ts（AlertStore：诊断镜像 + 面包屑）
   ├──→ core/sync.ts（createSync，仅配置启用时）
   └──→ core 其余各模块
```

> 红线：`session-llm.ts` 绝不能 import `index.ts`（成环）；共享逻辑一律下沉 `context-shape.ts`；core 不反向 import 宿主。

## 数据流向总览

**Track 1（用户风格，跨项目慢变量）**：
`主 AI 发 STYLE_SIGNAL HTML 注释` → `session.execution.succeeded` 事件 → `context-shape.planCapture`（游标增量）→ `signal-capture` 正则解析入缓冲（20 上限、evidence 去重）→ 节流门 → `refinement.refine()` 子会话 LLM 批量裁决（三态）→ `withFileLock` 锁内重读 → `user-md.applyProposals` 单遍应用（append 前归一查重 + 落盘 `dedupeUserMd` 自愈）→ `USER.md`（备份留 5 版）→ 下一 step 的 `context` hook 把协议+画像+索引 append 进 system prompt。

**Track 2（项目记忆，项目绑定快变量）**：
同一条触发/捕获管道 → `memory-refinement.refineMemory()`（独立提示词/缓冲/三态计数）→ `withFileLock` → `memory-md.applyMemoryProposals` 单遍应用（`.mem/*.md` 卡片 + 索引 upsert + `.trash/` 软删）→ 同锁内 `runHealthMaintenance()`（死链/孤儿，auto-fix ≤3）→ 写索引前套一层 `applyAlertBreadcrumb`（有 warn/critical 时在首行插一行 `<!-- memx:` 面包屑）→ 注入的是 **MEMORY.md 索引**（非全文）。

**报警（阶段 4 第一半）**：
任何 `recordAlert(level, code, message)` → `AlertStore.append`（`~/.opencode/memx-alerts.json`，封顶 200、剪龄 7 天）+ `diag.alerts` 只写镜像 → 面包屑 / doctor / `memx_status` 都读 store。

**多机云同步（阶段 4 第二半，默认关）**：
启用后 setup 时 `void sync.pull()` 一次 + 每 `intervalMinutes` 定时拉；**推触发点** = Track 2 提炼写盘成功后 + `memory_write` 工具成功后（`void sync.push()` 不 await）→ `push()` 先 `scanSensitive()` 全量 PII 扫描（命中即拒推 + critical 报警；自查走 `pnpm sync:op pii`，只列 file/行号/规则名）→ `.memx-sync.lock` 串行闸门内做 git 动作（镜像 = USER.md + MEMORY.md + `.mem/**/*.md`，排除 `.trash/`、`.bak.`；`no-change` 判据 = 无文件差异**且** `rev-list --count @{u}..HEAD` = 0，未推提交不再被短路）→ 状态落 `memx-sync-state.json`（含 `unsyncedCommits`）。pull 远端优先，覆盖前把本地差异件存 `.bak.<ts>`。

**显式出口**：用户说"记一下" → `memory_write` 工具 → `memory-write.writeProjectMemory` → 与后台提炼同一条写路（同锁同单遍）→ 成功后同样触发 `sync.push()`。

## 速查表

| 常见任务 | 涉及文件 |
|----------|----------|
| 加/改提炼字段（Track 1） | `core/types.ts` → `refine/prompts.ts` → `protocol-template.ts` → `store/user-md.ts`（如需落盘）→ 对应测试 |
| 加/改提炼字段（Track 2） | `core/memory-types.ts` → `refine/memory-prompts.ts` → `protocol-template.ts` → `store/memory-md.ts` + `health/memory-health.ts`（frontmatter 解析）→ `memory-write.ts` + index.ts 工具 schema |
| 改触发条件/节流 | `hosts/opencode/index.ts`（事件循环、flushAll）+ `core/llm/throttle.ts` + `core/config.ts`（throttleMinutes） |
| 改注入内容/顺序/上限 | `core/injection.ts` + `core/pipeline/injection-source.ts` + `hosts/opencode/context-hook.ts` + index.ts（诊断计数） |
| 加一个工具 | `hosts/opencode/index.ts` 的 `ctx.tool.transform`（参照 memory_write 的 `codemode:false`） |
| 改记忆文件格式 | `store/memory-md.ts`（writeMemoryFile/parse/serialize）+ `health/memory-health.ts` |
| 改提炼模型 | `~/.opencode/memx.config.json` 的 `refinementModel`（即时生效）+ `hosts/opencode/session-llm.ts` 的 `toModelRef` |
| 改协议文本 | `protocol-template.ts`（递增 PROTOCOL_VERSION）→ 重跑 `scripts/sync-protocol.ts` |
| 改报警行为/格式 | `core/alerts.ts`（store 语义 / 面包屑 / 面板）+ index.ts 的 `recordAlert` / `applyAlertBreadcrumb` |
| 改同步行为 | `core/sync.ts`（镜像范围 / PII 规则 / 重试与备份 / 锁）+ `core/config.ts` 的 sync 段 + index.ts 的三个触发点 |
| 加/改 CLI 命令 | `scripts/*.ts` + `package.json` scripts + `tests/scripts-smoke.test.ts`（真跑才算过） |
| 查/改项目 slug | `core/memory-types.ts` 的 `deriveSlug()`；对照 `~/.opencode/projects/` 目录名 |
| 调试插件真实状态 | 先跑 `pnpm run doctor`（只读面板）；深挖查 kv 表，命令见 [DATA.md](DATA.md) §诊断 |

## 文档导航

| 文档 | 适用场景 |
|------|----------|
| [INDEX.md](INDEX.md) | 每次对话优先加载，建立全局认知 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层、四钩子机制、core/hosts 边界、正确性机制、阶段 4 架构 |
| [modules/signals.md](modules/signals.md) | 改信号捕获、缓冲、游标 |
| [modules/refine.md](modules/refine.md) | 改提炼提示词、三态、LLM 调用 |
| [modules/store.md](modules/store.md) | 改写盘格式、单遍应用、去重自愈、锁、备份 |
| [modules/injection.md](modules/injection.md) | 改注入内容、上限、agent 闸门 |
| [modules/alerts.md](modules/alerts.md) | 改报警账本、面包屑、销账、doctor 面板 |
| [modules/sync.md](modules/sync.md) | 改多机云同步、PII 闸门、手工通道、dry-run |
| [modules/host-opencode.md](modules/host-opencode.md) | 改宿主壳：事件循环、4 个工具、子会话 LLM、诊断、同步接线 |
| [DATA.md](DATA.md) | 记忆文件格式、全部落盘路径、诊断查询 |
| [OPERATIONS.md](OPERATIONS.md) | 安装、配置项、CLI 命令、测试、调试 |
| [CONVENTIONS.md](CONVENTIONS.md) | 陷阱、历史包袱、修改红线 |
| [DSH-ADAPT.md](DSH-ADAPT.md) | DSH 宿主适配调查与施工图 |
