# memx

[English](README.md) | **[中文](README_zh.md)**

OpenCode V2 双轨记忆插件。从对话历史中自动提炼跨会话的用户偏好（Track 1）和项目背景（Track 2），分别持久化到 `~/.opencode/USER.md` 和 `~/.opencode/projects/<slug>/.mem/*.md`。

## 设计哲学

`memx` 基于一个核心洞察：**用户偏好（User Style）和项目事实（Memory）是两种截然不同的记忆类型**。

- **Track 1（User Style）**：跨项目通用的慢变量画像（沟通风格、工具链偏好、技术审美）。单文件 `USER.md`，四分类，200 行压缩。主 AI 通过 `STYLE_SIGNAL` HTML 注释标记信号，子 AI 批量提炼。
- **Track 2（Project Memory）**：项目绑定的快变量日志（进行中的工作、外部资源、协作指导）。索引 `MEMORY.md` + 独立 `.mem/*.md`（带 frontmatter，feedback/project 强制 Why + How to apply）。主 AI 通过 `MEMORY_SIGNAL` HTML 注释标记信号，子 AI 批量提炼。

两条轨道共享同一触发管道（`session.idle` / `reflect`），但信号缓冲、提炼、写入完全独立。

### 开源实现借鉴

| 参考项目 | 借鉴部分 | 本插件中的体现 |
| :--- | :--- | :--- |
| **CodeBuddy** | 索引+内容分离、frontmatter、强制 Why/How to apply、What NOT to save | Track 2 的 `MEMORY.md` + `.mem/*.md` 结构 + `MEMORY_REFINEMENT_SYSTEM_PROMPT` |
| **Honcho** | 辩证式推理 Prompt | System Prompt 要求 LLM 自问"跨项目是否仍适用"，区分临时指令与长期偏好 |
| **Mem0** | 去重与增量更新机制 | `StyleProposal.action` / `MemoryProposal.action`（append/update/deprecate）+ 去重规则 |
| **OpenClaw** | 时间衰减与生命周期管理 | 200 行压缩机制 + 废弃条目删除线标记（不物理删除） |
| **OpenCode V2 Plugin API** | Hook 体系 + 会话组装 hook | `event` / `tool.reflect` / `dispose` + 插件用自己的 `context` hook 注入 system prompt |
| **Zod** | Runtime Schema Validation | 所有 LLM 返回值强制 runtime validate，防止 JSON Mode 输出漂移 |

### 关键设计决策

| 决策 | 理由 |
| :--- | :--- |
| **主 AI 发 HTML 注释标记** | 主 AI 拿完整对话上下文，识别偏好的能力远超正则。用户看不到注释，插件解析。 |
| **子 AI 批量提炼** | 去重、冲突检测、schema 校验由 Stage 2 子会话 LLM 完成，主 AI 只负责"识别信号" |
| **自动写入 + 备份** | 去掉了人工确认环节，每次写入前自动备份 + 保留最近 5 版 |
| **插件自己注入 system prompt** | 插件在 `context` hook 里把 `memx-protocol.md` + `USER.md` + `MEMORY.md` **追加**到 `event.system`（宿主已组装好的 agent.system + AGENTS.md 正文之后）。每块各占一个 `SystemPart`，顺序：协议 → 画像 → 索引。每块上限 200 行 / 25KB，截断时追加可见的 `[memx: truncated — ...]` 提示行，不做静默截断。`opencode.json` 里的 `instructions` 条目在 v2.0.26 上**是死的**（宿主只从 `AGENTS.md` 组装指令），保留只为向前兼容 |
| **按项目隔离** | Track 2 的 `.mem/` 目录按工作目录 slug 隔离（`/root/project/foo` -> `root-project-foo`），跨项目记忆互不污染 |

## 双轨管道

```
[信号捕获]                    ->    [批处理提炼 + 持久化]
 session.execution.succeeded / reflect session.execution.succeeded / reflect
      │                                  │
 Track 1: STYLE_SIGNAL HTML 注释      Track 1: LLM 辩证提炼
 Track 2: MEMORY_SIGNAL HTML 注释    + USER.md 比对 + 增量 Patch
      │                                  │
 内存缓冲区 (上限 20, 按 evidence      Track 2: LLM 辩证提炼
  去重)                                + MEMORY.md 比对
      │                                  + .mem/*.md 写入
      ↓                                  ↓
 ctx.storage 诊断 + 清空缓冲区        USER.md + MEMORY.md 自动备份
```

## 触发机制

- `session.execution.succeeded`：每回合结束都发（**v2 不再发 `session.idle`**），自动增量捕获信号并提炼（受 `throttleMinutes` 节流）。
- `session.deleted` / 退出（`dispose`）：强制冲刷缓冲区（并删掉该会话的捕获游标），不拉取会话历史。
- `reflect` 工具：手动触发完整提炼（跳过节流），同时运行 Track 1 和 Track 2。用于事件触发被节流或没发时的兜底。
- 插件自动跳过自己创建的提炼子会话，不会自我触发；提炼过程互斥串行（`refinementInFlight`），防止并发风暴与重复写入。

## 正确性保证（阶段 3 P0 修复）

- **增量捕获**：每轮都扫，不再只扫最后一轮。游标锚在**消息 id** 上、存 `ctx.storage`（`cursor:<sessionID>`）；锚点丢失（上下文压缩/分叉）时退全量重扫，按 evidence 去重，并记一条 warn 报警。
- **提炼三态**：`proposals` / `adjudicated-empty` / `invalid-output`。LLM 裁决"不值得存"→ 清缓冲结案；输出坏 JSON/schema 不合法 → 保留缓冲重试，连续 3 次才丢弃并记报警（防坏模型无限循环）。
- **单遍写盘 + 内容锚点**：一批提案 parse 一次、内存内改完、序列化一次（批内行号不再漂移）。`update`/`deprecate` 靠抄写目标条目原文定位（精确 → 归一 → 唯一包含 → 行号兜底），每次降级/未命中都有告警。
- **跨进程文件锁**：USER.md / MEMORY.md 的 read-modify-write 走带 mtime TTL 的锁文件（`~/.opencode/.*.lock`），并在锁内**重读**文件；LLM 调用绝不进锁。
- **健康日志不写进 MEMORY.md**：auto-fix 结果落 `ctx.storage` 诊断/报警，索引保持纯索引。

## 安装

### 快速安装

```bash
git clone https://github.com/guraul/memx.git
cd memx
bash install.sh
```

脚本会自动克隆到 `~/workspace/memx`（可用 `bash install.sh <路径>` 覆盖），安装 pnpm 依赖，创建插件入口，声明依赖，写出信号协议文件 `~/.opencode/memx-protocol.md`，并写入 `opencode.json` 的 `instructions` 条目（仅为向前兼容，见下）。完成后重启 OpenCode，`/status` 验证即可。

> **信号协议从 `USER.md` 搬到了独立文件**。协议正文现在只存在于 `src/core/protocol-template.ts`，由 `scripts/sync-protocol.ts` 落盘，由**插件自己的 `context` hook** 注入。**不要**再把协议块手写进 `~/.opencode/USER.md`——那是 memx 每次提炼都会重写的数据文件，协议放里面会被抹掉。
>
> **内容到底怎么到模型眼前**：插件注册 `session.hook("context", …)`，把三块内容**追加**到宿主已组装好的 system prompt 后面（`agent.system` + 合并后的 `AGENTS.md` 正文）：`memx-protocol.md`（怎么发信号）→ `USER.md`（Track 1 画像）→ `MEMORY.md`（Track 2 索引）。缺文件静默跳过；三块都缺则整个 hook 什么都不做。提炼用的**子会话永远不被注入**——那一支仍整体替换 system 并锁 temperature 0.2。
>
> `opencode.json` 的 `instructions` 数组在 **opencode v2.0.26 上是死字段**：宿主唯一的指令组装插件（`packages/core/src/config/plugin/instruction.ts`）只加载 `AGENTS.md`，没有任何代码消费归一化后的 `config.instructions`。所以 `install.sh` 写的那几条今天完全是 no-op，留着只为将来宿主若支持了能白捡。

### 手动安装

如果你想逐步操作：

1. 克隆仓库并安装依赖（本仓库只用 pnpm，不用 npm/yarn/bun）：
   ```bash
   git clone https://github.com/guraul/memx.git /path/to/memx
   cd /path/to/memx
   pnpm install        # 没有 pnpm 时先执行 corepack enable pnpm
   ```

2. 创建全局插件入口（指向 `src/hosts/opencode/index.ts`）：
   ```bash
   mkdir -p ~/.config/opencode/plugins
   echo 'export { default } from "/path/to/memx/src/hosts/opencode/index";' > ~/.config/opencode/plugins/memx.ts
   ```
   > ⚠️ **只写 default 导出**。宿主会把插件入口的每个命名导出也当成插件去调用，多一个命名导出就会 `plugin config hook failed` 崩掉 OpenCode。

3. 声明依赖（若 `~/.config/opencode/package.json` 不存在）——注意 v1 的 `@opencode-ai/plugin` 已改名为 v2 的 `@opencode/plugin`：
   ```json
   {
     "dependencies": {
       "zod": "^4.4.3",
       "@opencode/plugin": "^2.0.26",
       "@opencode/client": "^2.0.26"
     }
   }
   ```

4. 写出信号协议文件（协议正文的唯一真源是 `src/core/protocol-template.ts`，不要手改产物；脚本用 `.ts` 扩展名 import，需要 **Node ≥ 22.6** 原生 strip types）：
   ```bash
   node scripts/sync-protocol.ts ~/.opencode/memx-protocol.md   # 幂等，内容一致不重写
   ```

5. （可选，仅为向前兼容）在 `~/.config/opencode/opencode.json` 加 `instructions` 字段：
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "instructions": [
       "~/.opencode/USER.md",
       "~/.opencode/MEMORY.md",
       "~/.opencode/memx-protocol.md"
     ]
   }
   ```
   在 opencode v2.0.26 上宿主**并不读**这个数组——注入靠插件自己（第 1–4 步做完就够用了）。`install.sh` 会幂等补齐缺失的条目，不动其它键。

6. 确认你的回复渲染层会剥离 HTML 注释——否则用户会直接看到 `<!-- STYLE_SIGNAL: ... -->` 原文。（宿主**不会**从 system prompt 里剥注释，这是渲染层的事。）

7. 重启 OpenCode，`/status` 应显示 `memx`；再跑 `memx_status` 工具看 `inject.*` 几行：`hookFires` 是 hook 触发总次数，`injections` 是真正追加了内容的次数。若 `hookFires > 0` 但 `injections == 0`，先看 `inject.gate` 与 `inject.empty`。

### 配置

通过 `~/.opencode/memx.config.json` 自定义：

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `refinementModel` | `string` | `opencode/mimo-v2.6-flash-free` | 提炼模型（`provider/model` 格式）。**生产保持这个免费档模型**；本机开发用 `~/.opencode/memx.config.json` 覆盖成 `opencode-go/longcat-2.5-preview-free`（本机免费档被网关 403/429 挡） |
| `maxSignalsPerSession` | `number` | `20` | 信号缓冲区上限 |
| `autoBackupCount` | `number` | `5` | 备份保留数 |
| `throttleMinutes` | `number` | `10` | 提炼节流间隔（分钟） |
| `inject.enabled` | `boolean` | `true` | `context` hook 是否注入 memx 内容到 system prompt |
| `inject.includeAgents` | `string[] \| "all"` | `"all"` | `"all"` = 全部 agent；数组 = 只有列出的 |
| `inject.excludeAgents` | `string[]` | `[]` | 永远压过 `includeAgents` |

闸门语义：`enabled=false` 时一个字节都不注入；否则生效集合 = `includeAgents` 减去 `excludeAgents`。**仓库里不硬编码任何 agent 名**（memx 必须宿主无关）——该排除哪些 agent 由消费方决定（例如会把 system prompt 原样回显的 agent 会把协议泄给用户）。生效中的闸门显示在诊断的 `inject.gate`。改配置 30 秒内生效，不必重启宿主。

### 注入上限

三块内容各自独立封顶：**200 行或 25KB，先到先算**。一旦截断，注入文本末尾会追加一行可见提示：

```
[memx: truncated — showing first 200 of 512 lines (18400 of 30000 bytes); 200-line cap]
```

这样模型和 `inject.truncations` 诊断都知道"有内容被丢掉了"——这里要避免的失败模式正是静默截断。常量是 `src/core/injection.ts` 里的 `INJECT_MAX_LINES` / `INJECT_MAX_BYTES`，**刻意不做成配置项**（写盘侧的 `isOverLimit` 本来就把画像压在 200 行内，这个上限是兜底而非日常旋钮；真出现需要调的负载再暴露成配置）。

## USER.md 格式

插件管理的用户风格文件位于 `~/.opencode/USER.md`：

```markdown
# User Profile & Style

> Auto-generated by memx. Last updated: 2026-07-29

## 沟通与交互风格
- [2026-07-29] 偏好直接给出重构后的完整代码，而非分步骤解释

## 工具与环境偏好
- [2026-07-25] 使用 pnpm 而非 npm/yarn

## 架构与技术决策
- [2026-07-22] 新项目默认使用 SvelteKit + Drizzle ORM

## 踩坑与禁忌
- [2026-07-27] 不要在代码注释中使用 Emoji
- ~~[2026-07-15] 偏好 Vue 3 Composition API~~ (Deprecated: 已迁移至 Svelte)
```

**格式规则：**
- 每条以 `- [YYYY-MM-DD]` 开头
- 废弃条目用 `~~删除线~~` 标记，不物理删除
- 四个固定分类标题，不可新增
- 硬限制 200 行，超限自动压缩

## MEMORY.md 格式（Track 2 - 项目记忆）

插件同时管理项目级记忆，索引文件位于 `~/.opencode/MEMORY.md`，具体记忆文件位于 `~/.opencode/projects/<slug>/.mem/*.md`。

```
~/.opencode/
├── USER.md                    # Track 1: 全局用户风格
├── MEMORY.md                  # Track 2: 项目记忆索引（按项目分节）
└── projects/
    └── <slug>/
        └── .mem/
            ├── project_auth_rewrite.md
            ├── reference_grafana.md
            └── feedback_testing.md
```

**MEMORY.md 索引格式**：
```markdown
## root-project-foo
- [auth rewrite](~/.opencode/projects/root-project-foo/.mem/project_auth_rewrite.md) - auth middleware rewrite driven by compliance
- [grafana dashboard](~/.opencode/projects/root-project-foo/.mem/reference_grafana.md) - grafana.internal/d/api-latency is oncall dashboard

## root-project-bar
- [loop scheduler](~/.opencode/projects/root-project-bar/.mem/project_loop_scheduler.md) - scheduler refactor in progress
```

**记忆文件格式**（带 frontmatter，feedback/project 强制 Why + How to apply）：
```markdown
---
name: auth rewrite
description: auth middleware rewrite driven by compliance
type: project
---
Rewriting auth middleware for compliance.

**Why:** Legal flagged session token storage.
**How to apply:** Scope decisions favor compliance over ergonomics.
```

**四类记忆**：
- `project`：进行中的工作、目标、事故（不可从代码推出）
- `reference`：外部资源指针（Linear、grafana 等）
- `feedback`：协作指导（纠正 + 确认）
- `user`：用户角色、知识背景

## 命令

### `reflect`
手动触发风格 + 项目记忆提炼（`session.idle` 未自动触发时使用）。

### `memx doctor`
只读状态面板：alerts / memory files / opencode diag / sync。命令是 **`pnpm run doctor`**——别用 `pnpm doctor`，
pnpm 有同名内建命令。想查看 memx 健康状态而不触发提炼时使用。

## 多机同步

通过 GitHub 仓（默认 `guraul/memx-sync`）在多台机器间同步 USER.md / MEMORY.md / `.mem/*.md`。
**默认关**——在 `~/.opencode/memx.config.json` 里开：`{"sync": {"enabled": true, "machineName": "mbp"}}`
（改完需重启 OpenCode）。每次记忆写盘后自动推；启动时拉一次 + 每 `intervalMinutes` 定时拉。
`pnpm sync:dry-run` 只读预览待同步内容（永不 push）；加 `-- --fetch` 会先 clone/fetch 到缓存 workdir
再比对——**新机器第一次拉之前必须用这个模式**，否则 workdir 不存在，报告只能写「远端未取到」。
拉取是**远端优先**：覆盖前若本地内容与远端不同，先把本地存成 `<file>.bak.<ts>`（每文件保留 5 份）。
`pnpm sync:op -- status|pull|push` 走**与插件同一条代码路径**做一次手工同步；`--machine=<name>` 会显式
覆盖成 `{enabled:true, machineName:<name>}` 但**不改配置文件**——这是"同步还没开、先人工跑一次首推/首拉"的通道。
PII 闸门（8 类规则）拦截含 token/密钥的推送——命中只报 文件+行号+规则名，绝不回显内容。
v1 有意不做：删除传播、逐行合并（同一文件两台机器都改靠 git rebase，冲突即 abort 留人工）。

## 故障排查

- **`session.idle` 迟迟不触发**：该事件只在会话真正空闲（一轮回复完全结束）后触发，连续工具调用 / 活跃回合会无限延迟。直接调用 `reflect` 工具手动触发。
- **改代码不生效**：插件在 OpenCode 启动时加载一次，修改 `src/` 后必须重启 OpenCode；修改 `~/.opencode/memx.config.json` 则即时生效（每次提炼时重新读取）。
- **提炼模型**：默认 `opencode/mimo-v2.6-flash-free`（**生产目标**——生产 opencode 的模型目录里没有 `opencode-go`）。本机开发用 `~/.opencode/memx.config.json` 覆盖成 `opencode-go/longcat-2.5-preview-free`，因为本机免费档被网关挡（403 指纹校验 / 429 限流）。deepseek 官方 key 在当前环境无效，不要配置 `deepseek/*` 模型。
- **日志**：位于 `~/.local/share/opencode/log/opencode.log`。插件的 `app.log` 消息不显示 `service` 字段，排查时搜索 `level=ERROR`，成功写入搜索 `Updated USER.md` 或 `Updated MEMORY.md`。
- **LLM 输出排查**：每次提炼会记录 `llm raw(N): ...`（400 字符截断），可确认 LLM 原始返回是否合法 JSON。

## 开发

```bash
pnpm install       # 安装依赖
pnpm test          # 运行测试（基线：22 文件 / 322 用例全绿，低于即回归）
pnpm run typecheck # 类型检查
```

## 协议

MIT
