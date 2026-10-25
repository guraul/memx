# modules/host-opencode.md — OpenCode 宿主壳

> 最后更新: 2026-10-25 · commit `c232168`

## 职责

memx 与 OpenCode v2 的唯一接缝：事件订阅、捕获编排、5 个工具注册、结构化诊断、子会话 LLM 适配、报警装配与云同步接线。**流水线本身（缓冲/节流/提炼/写盘/报警）已上提到 `core/pipeline/session.ts`**（#17 第一步 A），本壳只剩接线。**只 default 导出一个 Plugin**；所有 hook try-catch，错误绝不抛回宿主。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/hosts/opencode/index.ts` | `Plugin.define({id:"memx", setup})`（695 行，原 883 行）：事件循环、游标管理、诊断写盘、报警装配（`recordAlert` / `applyAlertBreadcrumb`）、同步接线（`createSync` + 定时拉 + 三个 push 触发点）、5 工具、flushAll、dispose、`PipelineHost` 装配 |
| `src/core/pipeline/session.ts` | 宿主无关流水线 `SessionPipeline`（`refineStyle` / `refineMemory` / `flushAll`）+ `PipelineHost` 窄口——两宿主共用 |
| `src/hosts/opencode/context-hook.ts` | `session.hook("context")` 判定与装配（纯逻辑，抽出只为可测） |
| `src/hosts/opencode/session-llm.ts` | `createSessionLLMClient`：子会话五步法 + `toModelRef` |
| `src/hosts/opencode/context-shape.ts` | v2 消息形状：`toMessages` / `planCapture` / `extractTurns`（index 与 session-llm 共享，防环） |

## 事件循环（index.ts）

```
session.execution.succeeded（每回合必发；v2 不发 session.idle）
  → captureFromSession：ctx.session.context({sessionID}) → toMessages() 归一
  → planCapture 增量决策 → captureSignals / captureMemorySignals 入缓冲
  → pipeline.refineStyle()（Track 1）→ pipeline.refineMemory()（Track 2），串行
session.deleted → 删 cursor:<sessionID> 游标
dispose → pipeline.flushAll 强制冲刷 + 落盘诊断 + sync.dispose()
reflect 工具（force=true）→ 手动触发两轨提炼，绕节流
setup（仅当 sync.enabled && machineName 非空）→ void sync.pull({force:true}) + setInterval(pull, intervalMinutes)
Track 2 写盘成功（onMemoryWritten）/ memory_write / forget 成功后 → void sync.push()（不 await）
```

`PipelineHost` 装配（index.ts:231）把宿主差异收进窄口：`loadConfig` / `createLLM`（造子会话客户端）/ `recordAlert` / `persist` / `decorateIndex`（面包屑）/ `onMemoryWritten`（推同步）。

`SessionPipeline.inFlight` 互斥 + `markRun()` 在 LLM 调用**前**置位，防"事件重叠 → 子会话风暴 / 重复写入"。节流是 in-memory（`lastRunAt`），**重启宿主即重置**。

## 5 个工具（`ctx.tool.transform`）

| 工具 | 入口 | 说明 |
|------|------|------|
| `reflect` | index.ts | 手动触发两轨提炼；`force=true` 绕节流 |
| `memory_write` | `core/memory-write.ts` | 显式写入（出口①）；**声明 `options: { codemode: false }`**——默认 codemode 会把调用包成 `execute` 工具（参数在 `state.input.code`、结果在 `state.content`），App 按工具名渲染的回执 chip 认不出；直调后 `part.tool` 才是 `memory_write`。成功后触发 `void sync.push()` |
| `memory_search` | `core/store/memory-search.ts` `searchMemories` | 与 DSH 宿主**共用 core**（#29），回执逐字一致：`slug/file:line — 命中行`（最多 20 条，超出追加 `… 另有 N 处未显示`）/ `[memx] 未匹配：<kw>` / `[memx] memory_search 失败：<原因>`。`slug` 缺省 = `currentSlug`（与注入同一 `deriveSlug`）；派生失败（空 cwd → `""`）**退化为全库**，不报错。同样声明 `options: { codemode: false }`；只读，不推 sync |
| `forget` | `core/store/memory-md.ts` `forgetMemory` | 软删匹配记忆到 `.trash/`（**无 slug 参数**，用当前会话目录）；成功后 `void sync.push()`（issue #21：不推会被下一轮 pull 拉回） |
| `memx_status` | index.ts | 固定字段回执（captured/refinements/written/failures/lastError/updatedAt + inject.* + alerts 段）；**alerts 以 AlertStore 为准**（不是 kv 镜像），其余字段**不是真相**，见下 |

v2 工具结果形状（2026-10-12 真机实测）：结果在 **`state.content: [{type:"text",text}]`**，不是 `state.output`（state 只有 status/input/content/metadata）。消费工具输出时别只读 `output`。

## 子会话 LLM（session-llm.ts）

`createSessionLLMClient(ctx, system)` 返回 core `LLMClient` 实现。五步：`session.create({title, model: toModelRef(...)})` → onCreated 登记 `childSessions` + `childSessionIds` → `session.prompt({sessionID, text})` → `session.wait` → `session.context` 取 assistant 全文 → finally `session.remove` + onRemoved。

契约陷阱全集见 CONVENTIONS.md §1（Model.Ref 对象、text 裸字符串、禁 event.tools={}、空回复看 finish/error/rawFinish、自激循环 childSessionIds）。

## 报警与同步接线（阶段 4）

**报警装配**：
- `recordAlert(level, code, message)` 一处收口：`AlertStore.append`（`~/.opencode/memx-alerts.json`，单一事实源）+ `diag.alerts` 只写镜像（老 kv 消费端不破）。
- `applyAlertBreadcrumb(content)`：写 MEMORY.md 前调用——薄包装，实际逻辑是 core `memory-write.ts` 的 `applyBreadcrumbLine(content, formatBreadcrumb(alertStore))`（先删首行旧 `<!-- memx:` 行，非空则插新行）；只这一行，不含健康日志/报警列表（走 preamble，不违反保留契约）。两条写路都刷新：提炼写索引 + `memory_write` 工具（第三个参数传面包屑）。
- 详见 modules/alerts.md。

**同步接线**：
- setup 时若 `initialConfig.sync.enabled && machineName !== ""` → `createSync({config, alerts: alertStore})` + `void sync.pull({ force: true })` + `setInterval(() => void sync?.pull(), intervalMinutes * 60_000)`；`dispose` 清定时器。
- **三个 push 触发点**都在"写盘成功之后"：Track 2 提炼写盘成功（`onMemoryWritten`，index.ts:252）、`memory_write` 成功（index.ts:569）、`forget` 成功（index.ts:601）；一律 `void sync?.push()`，**绝不 await**。
- 未启用时 `sync` 为 undefined，全部走可选链，零副作用。**DSH 壳未接同步**。
- 详见 modules/sync.md。

## 诊断（ctx.storage）

- 键：`"diag:" + deriveSlug(ctx.location.directory ?? "")`（按目录隔离；首次用旧全局 `diag` 值种子迁移）。
- 内容：计数（captured/refinements/written/failures）、`evtCounts`、`lastCapture`（userLen/assistantLen/styleHit/signalCount/msgCount）、`lastWarnings`、`injection.*`（hookFires/injections/truncations/gate/empty）、`alerts`、`health`、`invalidStreak`。
- `memx_status` 只格式化固定字段；完整真相查 kv 表（命令见 DATA.md §诊断）。

## 依赖关系

- 依赖：`core/*`（pipeline/session、memory-write、memory-md、alerts、sync、injection、protocol-template、memory-types）、`session-llm.ts`、`context-hook.ts`、`context-shape.ts`。
- 被依赖：`~/.config/opencode/plugins/memx.ts`（install.sh 写入，只 re-export default）。

## 修改注意事项与红线

1. **入口只 default 导出**——多导出任何命名函数会被宿主当插件调用而 crash（`plugin config hook failed`）。`~/.config/opencode/plugins/memx.ts` 的 re-export 同理只导 default。
2. index → session-llm → context-shape 单向依赖；`session-llm.ts` 绝不回头 import index.ts。
3. slug 在 setup 时算一次（`currentSlug`），诊断键、projects 目录共用；目录即身份。
4. 改 src 后**必须重启 OpenCode**（插件启动时加载一次）；`memx.config.json` 改动即时生效——**例外：`sync` 段只在 setup 读一次，改完必须重启**。
5. 所有 hook 保持 try-catch；context hook 的退化路径见 modules/injection.md。
6. **同步的 push/pull 永远不 await**（在写盘路径上）；**报警永远走 `recordAlert`**（不要直接 push `diag.alerts`）。

## 测试

`context-hook.test.ts`（hook 两分支与退化）/ `session-llm.test.ts`（子会话 LLMClient 适配）/ `hosts-context.test.ts`（`context-shape` 的 `toMessages` / `planCapture`）/ `hosts-opencode.search.test.ts`（#29：入口 `index.ts` 的插件级测试——最小 ctx stub 直调 `setup()`，覆盖 `memory_search` 的命中 / 空结果 / core 抛错三类回执 + 20 条上限 + 空 cwd 退化全库）/ `alerts.test.ts` / `sync.test.ts` / `scripts-smoke.test.ts`。`@opencode/plugin` 不真实加载；其余工具回执仍只在 DSH 侧由 `hosts-dsh.test.ts` 覆盖。
