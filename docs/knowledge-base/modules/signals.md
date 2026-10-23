# modules/signals.md — 信号捕获

> 最后更新: 2026-10-13 · commit `1bb53cc` · 2026-10-15 复核：内容未变（`fe26fa1`，仅 import 扩展名统一）

## 职责

把主 AI 回复里的 HTML 注释标记解析成结构化信号，入内存缓冲，供提炼消费。纯正则解析（<5ms），**事件路径绝不调 LLM**——识别偏好交给主 AI（它有完整上下文），插件只负责可靠收集。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/signals/signal-capture.ts` | Track 1：`STYLE_SIGNAL` 解析 + `SignalBuffer`（上限 20、按 evidence 去重、FIFO 淘汰） |
| `src/core/signals/memory-capture.ts` | Track 2：`MEMORY_SIGNAL` 解析 + `MemorySignalBuffer`（同规格） |
| `src/hosts/opencode/context-shape.ts` | `planCapture()` 增量决策 + `toMessages()` 消息归一 + `extractTurns()` 轮次切片 |

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

## 对外接口

- `captureSignals(text, buffer)` / `captureMemorySignals(text, buffer)` — 从消息文本解析入缓冲
- `planCapture` / `toMessages` / `extractTurns` — host 壳调用
- 缓冲 `.takeAll()` — 提炼取走并清空（invalid-output 时由上层放回）

## 修改注意事项与红线

1. **`captureSignals` 只解析 AI 消息**（user 参数故意未用）——用户消息里的注释不算信号，别"顺手补全"。
2. **`diag.lastCapture.styleHit` 只是子串正则**：`styleHit:true` 但 `signalCount:0` 是正常现象（AI 提到了词却没按注释格式输出），不是 bug。
3. **别拿 `extractLastTurn` 做捕获**（历史遗留名）——它已让位给 `planCapture` 增量游标；退回"只扫最后一轮"会让跨多轮的信号漏采。
4. 缓冲上限 20 是硬编码常量（config 的 `maxSignalsPerSession` 目前无消费方，见 CONVENTIONS.md）；改上限动常量并同步测试。
5. `ctx.storage.set` 的值类型是 `Schema.Json`：用 `type` 别名（非 interface）声明结构体才有隐式索引签名，否则 TS 报 not assignable。

## 测试

`tests/signal-capture.test.ts` / `memory-capture.test.ts` / `context-shape.test.ts`（游标三态各有用例）。每文件独立 tmp home。
