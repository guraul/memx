# modules/signals.md — 信号捕获

> 最后更新: 2026-10-25 · commit `c232168`

## 职责

把主 AI 回复里的 HTML 注释标记解析成结构化信号，入内存缓冲，供提炼消费。纯正则解析（<5ms），**事件路径绝不调 LLM**——识别偏好交给主 AI（它有完整上下文），插件只负责可靠收集。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/signals/signal-capture.ts` | Track 1：`STYLE_SIGNAL` 解析 + `SignalBuffer`（上限 20、按 evidence 去重、FIFO 淘汰） |
| `src/core/signals/memory-capture.ts` | Track 2：`MEMORY_SIGNAL` 解析 + `MemorySignalBuffer`（同规格） |
| `src/hosts/opencode/context-shape.ts` | `planCapture()` 增量决策 + `toMessages()` 消息归一 + `extractTurns()` 轮次切片（**仅 OpenCode**） |
| `src/core/pipeline/session.ts` | 缓冲的消费者：`SessionPipeline` 持有 `style` / `memory` 两个 buffer 并驱动提炼 |

## 信号格式

Track 1（由协议 v1.2.0 约束，真源 `src/core/protocol-template.ts`）：

```
<!-- STYLE_SIGNAL: {"category":"communication|toolchain|architecture|pitfall","content":"...","evidence":"...","confidence":"...","source":"..."} -->
```

Track 2：

```
<!-- MEMORY_SIGNAL: {"type":"project|reference|feedback|user","name":"...","description":"...","content":"...","why":"...","how_to_apply":"...","evidence":"...","confidence":"...","source":"..."} -->
```

`feedback` / `project` 类型**强制** `why` + `how_to_apply`（Zod superRefine，见 memory-types.ts）。

## 游标与增量（P0-1）

`planCapture(messages, cursor)` 纯函数，三态决策：

| 态 | 条件 | 行为 |
|----|------|------|
| fresh | 该会话无游标 | 全量扫 |
| resumed | 游标锚点消息 id 仍在 | 只扫锚点之后的轮次 |
| anchor-lost | 锚点被压缩/分叉裁掉 | 退全量重扫 + 记 `CAPTURE_CURSOR_LOST` warn——**预期降级，不是崩溃**，缓冲 evidence 去重兜底 |

游标存 `ctx.storage` 的 `cursor:<sessionID>`（键全局，sessionID 全局唯一故不冲突）；`session.deleted` 分支负责删除，不清就是垃圾行。

**DSH 侧没有游标**（DSH 无 `session.deleted` 等价物）：`turn/end` 只对"本轮累积的 assistant 文本"跑 `captureMemorySignals`，不做跨轮增量，也不需要清理。别为了对齐 OpenCode 硬造游标。

## 对外接口

- `captureSignals(_userMessage, aiMessage): StyleSignal[]` / `captureMemorySignals(aiMessage): MemorySignal[]` — 从消息文本解析出信号（`captureSignals` 只解析 AI 消息，user 参数保留未用）
- `planCapture` / `toMessages` / `extractTurns` — OpenCode 宿主壳调用
- 缓冲 `.pushAll()` / `.getAll()` / `.clear()` / `.length` — `SessionPipeline` 消费（invalid-output 时保留原缓冲）
- `SessionPipeline.styleCount` / `.memoryCount` — 诊断计数

## 依赖关系

- 依赖：`core/types.ts` / `core/memory-types.ts`（Zod schema）；纯解析，不碰 fs。
- 被依赖：`core/pipeline/session.ts`（持有两个缓冲并驱动提炼）、`hosts/opencode/index.ts`（游标增量后入缓冲）、`hosts/dsh/index.ts`（`captureMemorySignals` 扫本轮文本）。

## 修改注意事项与红线

1. **`captureSignals` 只解析 AI 消息**（user 参数故意未用）——用户消息里的注释不算信号，别"顺手补全"。
2. **`diag.lastCapture.styleHit` 只是子串正则**：`styleHit:true` 但 `signalCount:0` 是正常现象（AI 提到了词却没按注释格式输出），不是 bug。
3. **别拿 `extractLastTurn` 做捕获**（历史遗留名）——它已让位给 `planCapture` 增量游标；退回"只扫最后一轮"会让跨多轮的信号漏采。
4. 缓冲上限 20 是硬编码常量（config 的 `maxSignalsPerSession` 目前无消费方，见 CONVENTIONS.md）；改上限动常量并同步测试。
5. `ctx.storage.set` 的值类型是 `Schema.Json`：用 `type` 别名（非 interface）声明结构体才有隐式索引签名，否则 TS 报 not assignable。

## 测试

`tests/signal-capture.test.ts` / `memory-capture.test.ts` / `hosts-context.test.ts`（`context-shape` 的游标三态各有用例）。每文件独立 tmp home。
