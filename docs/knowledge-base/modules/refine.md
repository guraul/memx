# modules/refine.md — LLM 批量提炼

> 最后更新: 2026-10-25 · commit `c232168`

## 职责

把缓冲里的信号批量交给 LLM 辩证裁决（存/改/废/不值得存），产出 Zod 校验过的提案数组。两条轨道各一套提示词与计数，共用三态框架与 `LLMClient` 接口。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/refine/refinement.ts` | Track 1 提炼；**`LLMClient` 接口定义在此** |
| `src/core/refine/prompts.ts` | Track 1 system 提示词（含 `COMPRESSION_PROMPT`——⚠️ 死代码，无调用方） |
| `src/core/refine/memory-refinement.ts` | Track 2 提炼（复用 LLMClient） |
| `src/core/refine/memory-prompts.ts` | Track 2 system 提示词（四类记忆、description 是唯一"何时读"钩子、相对日期转绝对、冲突 deprecate+append 带 supersedes、合并带 merges） |
| `src/core/refine/refine-outcome.ts` | `RefineOutcome` 三态 + `INVALID_OUTPUT_STREAK_LIMIT = 3` |
| `src/core/pipeline/session.ts` | 三态的消费者：落盘 / 清缓冲结案 / 保留重试 + 连击报警 |
| `src/hosts/opencode/session-llm.ts` | OpenCode 侧 LLMClient 实现（子会话五步法） |
| `src/hosts/dsh/llm.ts` | DSH 侧 LLMClient 实现（`ctx.llm.stream` 一次性调用） |

## 三态契约（P0-2，`refine-outcome.ts`）

`refine()` / `refineMemory()` 返回 `RefineOutcome`：

| 态 | 含义 | 上层动作 |
|----|------|----------|
| `proposals` | 合法提案数组 | 落盘 + 清缓冲 |
| `adjudicated-empty` | LLM 裁决"不值得存"（合法空数组） | **清缓冲结案**——否则同批信号每轮重烧 LLM |
| `invalid-output` | 坏 JSON / schema 不合法 | **保留缓冲重试**；连续 3 次丢弃 + critical alert（防坏模型无限循环） |

提取细节：`extractJson` 先剥 markdown 围栏再 `JSON.parse`；解析后强制 `Schema.safeParse`。子会话空回复时**先看 `finish` / `error` / `rawFinish`**，故障全藏在那三个字段里，别只看 content parts。

## LLM 调用（两侧实现）

**OpenCode（`session-llm.ts`）**：`createSessionLLMClient(ctx, systemText)` → `session.create({title, model: toModelRef(...)})` → `session.prompt({sessionID, text})` → `session.wait` → `session.context` 取 assistant 全文 → finally `session.remove`。提炼 system 靠 context hook 的 `event.system` **整体替换**注入（`childSessions` map 登记）。

**DSH（`dsh/llm.ts`）**：`createDshLLMClient(ctx.llm, route)` 返回 `LLMClient`；一次 `ctx.llm.stream({provider, model, system, messages, temperature, maxTokens})`，合并 `text-delta`（优先）或 `block-end` 整块文本。不造子会话，因此没有注入/自激/`event.tools` 三个坑。

宿主契约陷阱（实机打出来的，改这块前先读 CONVENTIONS.md §1）：

- `session.create` 的 `model` 必须是 `Model.Ref` 对象；串里没有 `/` 就整个省略 `model` 交宿主默认，别臆造 providerID。
- `session.prompt` 的 `text` 在 2.0.26 二进制上是**裸字符串**——生成的 .d.ts 写的是对象，**类型与载荷校验不一致**，别按 d.ts 改回对象。
- **禁止在 context hook 里 `event.tools = {}`**：子会话请求被免费档网关 403（FreeTierError），content 为空 → JSON 解析失败 → 永不写盘且 `failures` 不涨、`lastError` 为空（症状极具误导性）。要约束输出用 system 替换。

## 输入构造

- Track 1 user 消息 = 信号清单 + **带行号的现有 USER.md 快照**（LLM 用行号做 update/deprecate 的 target_line 兜底）。
- Track 2 同理带 MEMORY.md 索引快照。
- temperature 0.2；maxTokens 1024（T1）/ 2048（T2）。

## 对外接口

- `refine(signals, llm, existingContent?, model?)` / `refineMemory(signals, llm, existingIndex?, model?)` → `RefineOutcome`
- `LLMClient`：`{ chat({ system, messages, temperature?, maxTokens?, model? }): Promise<string> }`（定义在 `refinement.ts`；`messages` 是 `{role, content}[]`，role 为字符串）
- 调用方是 `SessionPipeline`（两宿主共用），不是宿主壳——宿主只提供 `createLLM`。

## 依赖关系

- 依赖：`core/types.ts` / `core/memory-types.ts`、各自 prompts、`store/user-md.ts`（读现有画像快照）、`store/memory-md.ts`（读索引快照）、`refine-outcome.ts`。
- 被依赖：`core/pipeline/session.ts`（唯一调用方）；`LLMClient` 由 `hosts/opencode/session-llm.ts` 与 `hosts/dsh/llm.ts` 各自实现。

## 修改注意事项与红线

1. **合法空数组与坏输出必须区分**——合并处理会让每轮重烧 LLM 或丢用户信号，两种死法都很难查。
2. 提示词里的存/不存规则（What NOT to save、跨项目适用性自问）是防记忆膨胀的第一道闸，删减前先看 CONVENTIONS.md 的历史教训。
3. 节流在 `core/llm/throttle.ts`，`markRun()` 在 LLM 调用**前**置位（防止调用抛错后立刻重试打风暴）。
4. 提炼子会话不被注入、不被自激触发（`childSessionIds`，见 ARCHITECTURE.md §5）。

## 测试

`tests/refinement.test.ts` / `memory-refinement.test.ts`——LLM 全部 mock，覆盖三态与连续坏输出上限（三态本身在 `tests/hosts-context.test.ts` 里按流水线行为断言）。
