# API.md — 对外接口清单

> 最后更新: 2026-10-25 · commit `c232168`

## 0. 边界说明

memx **没有 HTTP / RPC 服务**，不监听端口，**也没有鉴权层**（全部接口在宿主进程内、由宿主自己鉴权；CLI 由本机用户权限约束）。对外接口只有三类：

| 类别 | 消费方 | 入口 |
|------|--------|------|
| 宿主工具（模型可调） | 主 AI | OpenCode 4 个（`ctx.tool.transform`）/ DSH 3 个（`ctx.tools.register`） |
| CLI 命令（人可跑） | 用户 / 运维 | `scripts/*.ts`，经 `package.json` scripts 暴露 |
| 配置文件 | 用户手写 | `~/.opencode/memx.config.json`（两宿主共读）+ DSH cordis 配置 |

所有工具与 CLI **共用同一份 core 实现**（同一把 `withFileLock`、同一套 `applyMemoryProposals`），不存在第二套写路。

## 1. 宿主工具

### 1.1 OpenCode（`src/hosts/opencode/index.ts`）

| 工具 | 入参 | 出参（`state.content[0].text`） | 实现路径 |
|------|------|------------------------------|----------|
| `reflect` | 无 | `"<style 回执> \| <memory 回执>"` / `[memx] 失败: <原因>` | `captureFromSession` → `pipeline.refineStyle(true)` → `pipeline.refineMemory(true)` |
| `memory_write` | `text`（必填）`type` `name` `description` `why` `how_to_apply` `evidence` | `✅ 已记住（<type> · 新增\|更新）：<name>` + 文件路径行（warnings 时追加 `⚠️ …`）/ `[memx] memory_write 失败：<原因>` | `core/memory-write.ts` → `writeProjectMemory` |
| `forget` | `keyword`（必填；**无 slug**，用当前会话目录） | `[memx] forgot N memories: <files>` / `[memx] forget: no memories matched "<kw>"` / `[memx] forget: keyword is required` / `[memx] forget failed: <原因>` | `core/store/memory-md.ts` → `forgetMemory` + `writeMemoryIndex` |
| `memx_status` | 无 | `[memx] 诊断` 多行固定字段：version / captured / refinements / written / failures / lastError / invalidStreak / `inject.*` / updatedAt / `capture.cursor` / warnings / health / alerts / toolWrites；失败 `[memx] status failed: <原因>` | index.ts（读 kv `diag:<slug>` + `AlertStore`） |

要点：
- `memory_write` 声明 `options: { codemode: false }`（默认 codemode 会把调用包成 `execute` 工具，App 的回执 chip 按工具名认不出）。
- 工具结果在 **`state.content: [{type:"text",text}]`**，不是 `state.output`。
- `forget` / `memory_write` 成功后 `void sync?.push()`（不 await）。
- `memx_status` 的 alerts 段读账本文件；其余字段只是 kv 快照，完整真相查 kv（见 [DATA.md](DATA.md) §4）。

### 1.2 DSH（`src/hosts/dsh/index.ts`）

| 工具 | 入参 | 出参 | 实现路径 |
|------|------|------|----------|
| `memory_write` | 同 OpenCode 版（`text` 必填 + 6 个可选） | `[memx] 已记住：<name>` / `[memx] memory_write 失败：<原因>` | `core/memory-write.ts` |
| `memory_search` | `keyword`（必填）`slug`（可选，缺省按会话 cwd 推导；推导不出 → 全库） | `slug/file:line — <命中行>`（最多 20 条）/ `[memx] 未匹配：<kw>` | `core/store/memory-search.ts` → `searchMemories` |
| `forget` | `keyword`（必填）`slug`（可选；**推导不出直接失败**，不猜项目） | `[memx] 已遗忘 N 条：<files>` / `[memx] 未匹配：<kw>` | `core/store/memory-md.ts` → `forgetMemory` + `writeMemoryIndex` |

要点：
- DSH 侧**没有** `reflect` / `memx_status`；轮末补记由 `turn/end` 事件自动触发（见 [modules/host-dsh.md](modules/host-dsh.md)）。
- 工具定义用**原始 JSON Schema**（`parameters`），输出用 `output.render`；没有 codemode 包装，不需要 `codemode:false` 补丁。工具返回 `{ok, name?, message}`，`render` 只渲染 `message`。
- 任何异常只变成 `[memx] … 失败：<原因>` 回执，绝不抛回宿主；`forget` 另有 `keyword 不能为空` / `取不到会话工作目录` 两类前置失败文案。

## 2. CLI 命令

全部走 `node --experimental-strip-types` 直载 `.ts`（**相对 import 必须带 `.ts` 扩展名**）。

| 命令 | 子命令 / 参数 | 行为 | 退出码 | 文件 |
|------|--------------|------|--------|------|
| `pnpm run doctor` | 无 | 只读面板四段：alerts / memory files / opencode diag / sync | 恒 0 | `scripts/doctor.ts` |
| `pnpm sync:dry-run` | `-- --fetch` | 只读预览：待同步清单 + 双向行数 + PII + 远端 log；**永不 push** | 恒 0 | `scripts/sync-dry-run.ts` |
| `pnpm sync:op` | `status` / `pii` / `pull` / `push` / `both`，可加 `--machine=<name>` | 手工同步通道（与插件同一 `createSync`）；`pii` 只列 file/行号/规则名 | 恒 0 | `scripts/sync-op.ts` |
| `pnpm alerts:clear` | `--code=<CODE>` / `--dry-run` | 清理报警账本（不传 code = 清全部） | 恒 0 | `scripts/alerts.ts` |
| `node --experimental-strip-types scripts/sync-protocol.ts [目标路径]` | 目标路径（缺省 `~/.opencode/memx-protocol.md`） | 幂等落盘协议文本 | 0 | `scripts/sync-protocol.ts` |

⚠️ 状态面板必须用 `pnpm run doctor`，**别用 `pnpm doctor`**（pnpm 内建同名命令会静默接管）。

## 3. 配置面

| 文件 | 读方 | 生效语义 |
|------|------|----------|
| `~/.opencode/memx.config.json` | core `config.ts`（两宿主都读） | `refinementModel` / `inject.*` / `throttleMinutes` 即时重读；**`sync` 段只在 OpenCode setup 读一次**，改完重启 |
| DSH cordis 配置（`provider` / `model` / `autoRefine` / `throttleMinutes`） | `hosts/dsh/index.ts`（薄壳包 `dsh-plugin-memx` 声明字段） | 四个都是 volatile 字段，**每次轮末现读**；在 Web 设置页「设置 → 记忆」或 profile 的 `cordis.patch.yml` 改 |
| `~/.config/opencode/plugins/memx.ts` | OpenCode 宿主 | 只 re-export default；改完重启 |

字段全集见 [OPERATIONS.md](OPERATIONS.md) §2。

## 4. core 公共导出（模块间接口）

给"再加一个宿主"或写脚本时用；宿主壳只允许调这些，不允许自己重写判定/写盘。

| 导出 | 文件 | 签名要点 |
|------|------|----------|
| `SessionPipeline` | `core/pipeline/session.ts` | `refineStyle(force?)` / `refineMemory(force?)` / `flushAll(force)`；宿主提供 `PipelineHost`（loadConfig / createLLM / recordAlert / persist / decorateIndex / onMemoryWritten） |
| `LLMClient` | `core/refine/refinement.ts` | `chat({ system, messages, temperature?, maxTokens?, model? }): Promise<string>` |
| `buildInjectionParts` | `core/injection.ts` | `(sources) => { parts, ... }`；顺序协议→画像→索引，200 行/25KB 上限 |
| `readInjectionSources` / `readInjectionSourcesForSlug` | `core/pipeline/injection-source.ts` | 整份索引 / 只取当前 slug 一节（DSH 用） |
| `writeProjectMemory` | `core/memory-write.ts` | `(slug, input, breadcrumb?) => MemoryWriteOutcome`（锁内单遍） |
| `searchMemories` | `core/store/memory-search.ts` | `(keyword, slug?) => SearchHit[]`，只读、不加锁 |
| `forgetMemory` / `writeMemoryIndex` / `applyMemoryProposals` | `core/store/memory-md.ts` | 软删 / 索引写盘 / 单遍应用 |
| `applyProposals` / `dedupeUserMd` | `core/store/user-md.ts` | Track 1 单遍应用 + 去重自愈 |
| `createFileAlertStore` / `formatBreadcrumb` / `formatAlertsPanel` | `core/alerts.ts` | 账本读写 + 两个纯格式化器 |
| `createSync` | `core/sync.ts` | 注入 `GitRunner`；`push()` / `pull({force})` / `dispose()` |
| `deriveSlug` | `core/memory-types.ts` | 目录 → slug（`/a/b` → `a-b`） |

## 5. 非接口（不要当契约用）

| 项 | 原因 |
|----|------|
| `ctx.storage` 的 kv 键 | 宿主内部存储；`memx_status` 只打固定字段，键按 `diag:<slug>` 隔离（见 [DATA.md](DATA.md) §4） |
| DSH `diag` 对象 | 只在内存，宿主重启即清零，不是持久接口 |
| `~/.opencode/memx-protocol.md` | 协议产物，真源是 `src/core/protocol-template.ts` |
