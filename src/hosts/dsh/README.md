# memx · DSH 宿主适配层（#17 第一步 B）

DSH（DeepSeek Harness）侧的记忆插件壳。目标是让 DSH 与 OpenCode 共享同一套记忆库：
`~/.opencode/projects/<slug>/.mem/`（项目记忆）+ `~/.opencode/USER.md`（画像），
而不是各存一份。

本目录只做**宿主接线**，所有判定/写盘/提炼逻辑都在 `src/core/`（第一步 A 已把流水线
上提到 `src/core/pipeline/`），因此 opencode 与 DSH 走的是同一份 `writeProjectMemory`、
同一份 `refine()`、同一份信号捕获。

## 文件

| 文件 | 职责 |
|------|------|
| `index.ts` | 插件入口：`name` / `inject` / `Config` / `apply`。注册注入段、`memory_write` / `memory_search` / `forget` 三个工具、`session/event` 轮末补记 |
| `llm.ts` | `ctx.llm.stream` → core 的 `LLMClient`（一次性模型调用，不造子会话）；`resolveRoute` 校验 provider/model |
| `types.ts` | 零依赖的结构类型（官方 `@deepseek-ai/dsh-*` 声明的最小子集） |

## 依赖纪律（为什么这里没有 `@deepseek-ai/*` import）

memx 是独立包，`package.json` 里没有 DSH 的包，而 #17 的红线是**不 install、不动
lockfile**。所以：

- 结构类型手写在 `types.ts`，字段名与官方 0.2.1-rc.2 声明逐项对应（见下节）；
- `Config` 是**手写的 standard-schema**（`Config["~standard"].validate`），因为 Cordis 只需要
  这个入口就能解析配置；真正的 schemastery 留给第二步的薄壳包；
- `createUserMessage` 用**变量 specifier 动态 import** 尝试取宿主自己的构造函数，取不到就
  降级（只记诊断，不手搓消息对象——那是硬造）。

## 加载方式（第二步：薄壳包）

本目录是**源码**，不能被 DSH 直接 `plugin add`。第二步会在仓库根加一个薄壳包：

```jsonc
// package.json（第二步新增，本步不动）
{
  "name": "dsh-plugin-memx",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: memx
      name: "<包名或绝对路径>"
      config: { }        # provider / model / autoRefine / throttleMinutes
```

配置字段（四个都是"改了即时生效"的热更字段；薄壳包用 schemastery `.volatile()` 声明，
宿主因此以**引用 cell** 的形态把它们传进 `apply`，本层**每次轮末现读**（不在 apply 时快照，
否则设置页改完要等重启才生效））：

| 字段 | 类型 | 缺省 | 语义 |
|------|------|------|------|
| `provider` | string | `""` | 提炼用 provider；空 = 跟随当前会话 |
| `model` | string | `""` | 提炼用 model；空 = 跟随当前会话 |
| `autoRefine` | boolean | `true` | 轮末自动提炼开关；`false` 只关**轮末补记**，显式 `memory_write` 不受影响 |
| `throttleMinutes` | number | `10` | 轮末补记的会话级节流（分钟，1–1440） |

安装与生效语义（细节见 `docs/knowledge-base/DSH-ADAPT.md` §3）：

```bash
dsh plugin --profile web add <包名或绝对路径>
# 改动本目录的 .ts 源码后：必须重启 dsh web，没有热更
# memx.config.json 不用重启（每次提炼重读）
```

## 工具

三个工具都是模型可调入口，**写路径与 opencode 完全同一份 core**（`writeProjectMemory` /
`withFileLock` + `applyMemoryProposals` / `forgetMemory` + `writeMemoryIndex`）。任何异常只
变成 `[memx] … 失败：<原因>` 回执，绝不抛回宿主。

| 工具 | 参数 | 行为 | 回执 |
|------|------|------|------|
| `memory_write` | `text`（必填）/ `type` / `name` / `description` / `why` / `how_to_apply` / `evidence` | 写一条项目记忆（同名同类型视为修订） | `[memx] 已记住：<name>` |
| `memory_search` | `keyword`（必填）/ `slug` | 跨 `.mem/*.md` 全文检索（大小写不敏感），返回 `slug/file:line — 命中行`，最多 20 条 | `[memx] 未匹配：<keyword>`（无命中） |
| `forget` | `keyword`（必填）/ `slug` | 软删：文件移入 `.mem/.trash` + 移除 MEMORY.md 条目（锁内 `forgetMemory`） | `[memx] 已遗忘 N 条：<files>` / `[memx] 未匹配：<keyword>` |

`slug` 缺省都用当前会话 cwd 推导（与注入同一规则，`deriveSlug`）；`memory_search` 在推导不出
slug 时退化成全库检索（只读，最坏多给几条），`forget` 则直接失败（不给"猜项目删记忆"的机会）。

检索逻辑在 core `src/core/store/memory-search.ts`（原 mem CLI 的 `cmdSearch` 上提，
CLI 已退役），因此宿主自己不需要任何 markdown 解析。

## 与 opencode 宿主的对照

| 维度 | `src/hosts/opencode/` | `src/hosts/dsh/` |
|------|----------------------|------------------|
| 注入内容 | 协议 + USER.md + **整份 MEMORY.md** | 协议 + USER.md + **当前项目小节**（`memorySectionForSlug`） |
| 注入时机 | `context` hook 每轮追 SystemPart | `systemPrompt.section`，`order: 12000`，`interpolate: false` |
| 注入稳定性 | 每轮重算（可看到本会话新写的记忆） | **每会话只算一次**（WeakMap by agent），字节恒定以保缓存 |
| 写入 | `memory_write` 工具 | 同左，同一份 `writeProjectMemory` |
| 提炼 | 造子会话（`session.prompt`） | `ctx.llm.stream` 单次调用，不造子会话 |
| 触发 | 进程级 + 游标增量捕获 | `session/event` 的 `turn/end`，会话级节流 |
| 防重复 | `refinementInFlight` 闸门 | 会话级 `SessionPipeline.inFlight` + 本轮已有工具写入则跳过 + 同 turn 幂等标记 |
| 数据目录 | `~/.opencode/`（默认值） | 同一份（`config.ts` 的数据根参数化） |

## 与 DSH 0.2.1-rc.2 的 API 对照

`types.ts` 的每个成员都能在宿主 d.ts 里找到对应，核对位置（本机全局安装）：

| memx 类型 | 官方声明 |
|-----------|----------|
| `DshContext.systemPrompt.section` | `@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts` → `PromptSection`（`name` / `order` / `interpolate` / `text(context)`） |
| `DshAssembleContext.agent` | 同上 `AssembleContext`；`agent` 由 `@deepseek-ai/dsh-agent` 模块扩展挂上（`assembleContextFor` 里 `{ agent, scope: agent }`） |
| `SECTION_ORDERS` 里 12000 | 同上，落在工具说明与 MCP 之间，不与内建段冲突 |
| `DshTools.register` / `output.render` | `@deepseek-ai/dsh-tools/lib/types/index.d.ts` → `ToolDefinition`、`ToolRunContext.agent` |
| `DshLlm.stream` | `@deepseek-ai/dsh-llm/lib/types/index.d.ts` → `LlmRuntime.stream`（`GenerateOptions` / `StreamChunk`） |
| `DshAgent.options.{provider,model}` | `@deepseek-ai/dsh-agent` → `AgentOptions`（会话当前模型） |
| `DshAgent.inject` | 同上 `Agent.inject`（排到下一个 pre-step） |
| `session/event` 的 `turn/start` / `assistant/message` / `turn/end` | 事件名与载荷实测见 `docs/knowledge-base/DSH-ADAPT.md` |

## 运行时行为

1. **注入**：每个会话第一次装配时求值一次 `buildInjectionParts(readInjectionSourcesForSlug(...))`，
   之后同一 `agent` 对象拿到同一串字节。注入正文里**不含时间/计数/随机**——否则每轮字节漂移
   会让宿主缓存全失效。
2. **工具**：`memory_write` 的参数与 opencode 那版逐字段对齐；`memory_search` / `forget` 与
   opencode 同走 core（检索 `searchMemories`、遗忘 `forgetMemory` + 写索引）。成功回执
   `[memx] 已记住：<name>` / `[memx] 已遗忘 N 条：…`。
3. **轮末补记**：`turn/end` → `autoRefine === false` 直接跳过 → 同 turn 幂等 → 本轮有工具写入则跳过
   → `captureMemorySignals` 无信号则跳过 → 会话级节流（`throttleMinutes`）→ 解析路由 →
   `pipeline.refineMemory(true)`。整个过程 `queueMicrotask` 起步，**不 await 阻塞事件分发**。
   （跳过原因计数在 `diag.skipped`：`disabled` / `duplicate` / `written` / `empty` / `throttle` / `noModel`。）
4. **提示**：写入成功且能拿到 `createUserMessage` 时，用 `agent.inject` 排一条
   `[memx] 已记住 N 条`（≤120 字）。

## 已知限制

- **本会话新写的记忆本会话不可见**：注入文本每会话只算一次（拍板语义，下个会话生效）。
- **装配上下文缺 `agent`/`scope` 时不缓存**：没有会话键就没有安全的缓存粒度，此时每次装配都重算
  （slug 也取不到 → 只出协议 + 画像）。宁可多算一次，也不让所有会话共用一条文本、把 A 项目的
  小节串给 B 项目。
- **DSH 没有「关标签页 / 删会话」的钩子**：本层不维护跨会话游标，因此不需要清理逻辑；
  代价是"增量游标"这类语义在 DSH 侧不存在，全靠 `turn/end` 事件。
- **`createUserMessage` 可能不可得**：DSH 若不给 `@deepseek-ai/dsh-llm` 的具名导出，动态 import
  会失败 → 只跳过"已记住 N 条"提示，**写盘不受影响**（诊断里能看到）。
- **模型路由取自会话**：`provider`/`model` 未配置时用 `agent.options`；仍取不到就**跳过本轮补记**
  并记诊断（不猜、不回落其它 provider）。
- **`turn/end` 目前不过滤 `reason`**：aborted/cancelled 的轮次也会进补记判定（有信号才提炼）。
  待第二步拿到实测载荷后收紧成只认 `completed`。
- **诊断在内存**：DSH 侧没有 kv 面板，`persist` 是空实现；异常由 `logger.warn` 落到宿主日志。

## 测试

`tests/hosts-dsh.test.ts` 用假 `ctx`（`systemPrompt` / `tools` / `llm` / `agents` /
`workingDirectory`）覆盖：注入段注册与字节恒定、`Config` 校验、工具成功/失败回执、
本轮写入跳过、节流、无信号跳过、无模型跳过、提示注入与降级。
