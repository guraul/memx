# modules/host-dsh.md — DSH 宿主壳

> 最后更新: 2026-10-25 · commit `c232168`

## 职责

memx 与 DSH（DeepSeek Harness）的唯一接缝：注册注入段、3 个工具、轮末补记、把 `ctx.llm.stream` 适配成 core 的 `LLMClient`。**零 `@deepseek-ai/*` import**（结构类型手写在 `types.ts`），所有判定/写盘/提炼走 `src/core/`，与 OpenCode 共用同一份实现与同一个数据目录。**已实际安装运行**（薄壳包 `dsh-plugin-memx`，独立仓）。

## 加载与安装（已落地）

本目录是**源码**，不能被 DSH 直接 `dsh plugin add`。接线由独立仓的薄壳包 **`dsh-plugin-memx`**（`~/workspace/self-dsh-plugins/dsh-plugin-memx`）完成：

- profile 侧：`~/.dsh/profiles/web/package.json` 里有 `"dsh-plugin-memx": "link:…"` 且 `dsh.profile.bundles` 含它；`cordis.patch.yml` 有 `- id: memx / name: dsh-plugin-memx / config: {provider, model}`。
- 薄壳包 `lib/index.js` 用 `registerHooks` + `stripTypeScriptTypes`（transform 模式）**直接加载本仓 `src/hosts/dsh/index.ts`**，再转发 `name` / `inject` / `apply`。
- 因此：改本目录源码 → **重启 dsh web** 即可，不用重编薄壳包；改薄壳包 `src/config.ts` / `src/client/**` → `pnpm build` 后重启。
- ⚠️ `lib/index.js` 的 `MEMX_ROOT` 硬编码 `/Users/gubin/workspace/memx/`；搬仓 / 多 checkout 必须同步改。

安装命令与实测证据见 [DSH-ADAPT.md](../DSH-ADAPT.md) §0/§3。

## 入口与关键文件

| 文件 | 职责 |
|------|------|
| `src/hosts/dsh/index.ts`（743 行） | 具名导出 `name` / `inject` / `Config` / `apply`；注入段、3 工具、`session/event` 轮末补记、内存诊断 |
| `src/hosts/dsh/llm.ts` | `createDshLLMClient(llm, route)` → `LLMClient`；`resolveRoute(provider, model)`（两者都非空才算可用） |
| `src/hosts/dsh/types.ts` | 官方 d.ts 的最小子集（`DshContext` / `DshAgent` / `DshTools` / `DshLlm` / `DshSessionEvent` …） |
| `src/hosts/dsh/README.md` | **DSH 侧最详细文档**：工具表、配置、与 OpenCode 对照、API 对照、已知限制 |
| `src/core/pipeline/session.ts` | 共享流水线（`SessionPipeline`），DSH 通过 `PipelineHost` 注入 createLLM / recordAlert / decorateIndex |

## 导出契约（与 OpenCode 相反）

```ts
export const name = "memx";
export const inject = ["systemPrompt", "tools", "workingDirectory", "llm", "agents"] as const;
export const Config = { /* 手写 standard-schema：~standard.validate */ };
export function apply(ctx: DshContext, config: DshMemxConfig = {}): void
```

⚠️ OpenCode 侧是"只 default 导出"，DSH 侧**必须具名导出**；两边不能互抄。

## ① 注入

- `ctx.systemPrompt.section({ name: "memx:memory", order: 12000, interpolate: false, text })`。
- 内容 = `readInjectionSourcesForSlug(cache, slug, cwd)` → 协议 + USER.md + **当前项目一节 + related**（不是整份 MEMORY.md；related = 其它节里按 cwd 末段 + 词边界命中的条目，见 `modules/injection.md`）。
- **每会话只求值一次**：`WeakMap<agent, string>` 缓存；无 `agent`/`scope` 时不缓存（宁可重算，也不让 A 项目小节串给 B 项目）。
- 文本里**无时间/计数/随机**——字节恒定是宿主缓存不失效的前提。
- ⚠️ **不读 `inject.*` 闸门**（`enabled` / `includeAgents` / `excludeAgents` 只在 OpenCode 生效）。

## ② 工具（`ctx.tools.register`）

| 工具 | 参数 | 行为 |
|------|------|------|
| `memory_write` | `text`（必填）/ `type` / `name` / `description` / `why` / `how_to_apply` / `evidence` | `writeProjectMemory`（同名同义 = 修订；同名不同义 = hash 尾缀 fork，#31） |
| `memory_search` | `keyword`（必填）/ `slug` | `searchMemories`（只读；slug 推导不出 → 全库；最多 20 条） |
| `forget` | `keyword`（必填）/ `slug` | 锁内 `forgetMemory` + `writeMemoryIndex`（软删到 `.trash/`） |

- 工具定义用**原始 JSON Schema**，输出用 `output.render`；没有 codemode 包装。
- 异常只变 `[memx] … 失败：<原因>` 回执，绝不抛回宿主。
- 写入成功后 `applyBreadcrumbLine(result.newIndex, formatBreadcrumb(alertStore))` 刷新 MEMORY.md 首行面包屑。

## ③ 轮末补记（`session/event`）

```
turn/start        → 清本轮 writesThisTurn / turnText
assistant/message → 累积本轮 assistant 文本
turn/end          → queueMicrotask（绝不 await）
   ├─ autoRefine === false            → skipped.disabled
   ├─ 同 turn 已处理                  → skipped.duplicate
   ├─ 本轮有工具写入                  → skipped.written
   ├─ captureMemorySignals 无信号     → skipped.empty
   ├─ 会话级节流（throttleMinutes）   → skipped.throttle
   ├─ 路由取不到（配置→会话模型）     → skipped.noModel（不猜、不回落）
   └─ pipeline.refineMemory(true) → 写盘 → 有写入则 agent.inject("[memx] 已记住 N 条")
```

- **只有 Track 2**（项目记忆）在 DSH 侧自动补记；Track 1 风格靠 `memory_write` 显式写。
- 节流按会话计（`lastRefineAt`），默认 10 分钟；`throttleMinutes` 优先取 cordis 配置，缺省回落 `memx.config.json`。
- `turn/end` **未过滤 `reason`**（aborted/cancelled 也会进判定，有信号才提炼）。

## ④ 诊断与报警

- 诊断**只在内存**（`DshDiagnostics`：injections / capturedTurns / toolWrites / notices / skipped.* + 流水线字段）；`persist` 是空实现。
- 异常走 `ctx.logger.warn("[memx] …")` 落宿主日志；无 `memx_status`、无 doctor 面板、无 kv 行。
- 报警落**同一份** `~/.opencode/memx-alerts.json`（两宿主共用账本）。

## 依赖与红线

- `src/hosts/dsh/**` **不得 import 任何 `@deepseek-ai/*`**；`package.json` 也不声明（#17 纪律：不 install、不动 lockfile）。
- 只经 `PipelineHost` 窄口调 core；流水线语义改动放 `core/pipeline/session.ts`，不许在壳里复制。
- 任何 hook try-catch；轮末补记是后台任务，**绝不 await 阻塞事件分发**。
- 不照搬 OpenCode 的 `codemode:false` / `childSessionIds` / `event.tools={}` / `toModelRef` 省略分支。

## 配置（cordis 字段，设置页「记忆」或 profile patch 可改）

| 字段 | 默认 | 语义 |
|------|------|------|
| `provider` / `model` | `""` | 提炼路由；空 = 跟随当前会话 |
| `autoRefine` | `true` | 轮末自动提炼；`false` 只关补记，显式 `memory_write` 不受影响 |
| `throttleMinutes` | `10` | 会话级节流（1–1440） |

四个都是 volatile 字段，**每次轮末现读**；本机 profile 当前设为 `provider: opencode-go` / `model: mimo-v2.6-flash`。`memx.config.json` 的 `refinementModel` 对 DSH 不生效。

## 已知限制

- 本会话新写的记忆本会话不可见（注入每会话一次）。
- 装配上下文缺 `agent`/`scope` 时不缓存（slug 也取不到 → 只出协议 + 画像）。
- `createUserMessage` 动态 import 可能失败 → 只跳过"已记住 N 条"提示，写盘不受影响。
- 设置页「记忆」**只改配置**，不显示计数/诊断；诊断在内存 + 宿主日志 `[memx] …`，重启清零。
- `inject.*` 闸门未接；云同步未接；`turn/end` 未按 `reason` 过滤（见 [CONVENTIONS.md](../CONVENTIONS.md) §5）。
- 薄壳包 `MEMX_ROOT` 硬编码（见上「加载与安装」）。

## 测试

`tests/hosts-dsh.test.ts`：假 `ctx`（systemPrompt / tools / llm / agents / workingDirectory）覆盖插件契约（导出 / `Config` 校验）、注入段注册与字节恒定、`memory_write` / `memory_search` / `forget` 的成功与失败回执、轮末补记（触发 / 节流 / 本轮已写跳过 / autoRefine=false / 无模型）与 volatile 配置现读。**未覆盖**：`agent.inject` 的「已记住 N 条」提示（依赖宿主 `createUserMessage`，代码里只做降级容错）。
