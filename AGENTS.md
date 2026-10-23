# memx - 项目说明

**Updated:** 2026-10-15

OpenCode V2 双轨记忆插件（Track 1 用户风格 + Track 2 项目记忆），阶段 4 追加报警账本、doctor 只读面板与多机云同步。项目知识库已按模块拆分到 `docs/knowledge-base/`，本文件只承担**路由**与**强制规定**两个职责。功能细节、数据格式、钩子机制、陷阱一律查阅知识库，不要在本文重复。

## 知识库路由（优先查阅）

| 场景 | 加载文档 |
|------|----------|
| 全局认知、技术栈、仓库拓扑、数据流 | `docs/knowledge-base/INDEX.md`（每次对话优先） |
| 架构分层、钩子机制、core/hosts 边界、正确性机制 | `docs/knowledge-base/ARCHITECTURE.md` |
| 改信号捕获 / 缓冲 / 游标 | `docs/knowledge-base/modules/signals.md` |
| 改提炼（提示词 / 三态 / LLM 调用） | `docs/knowledge-base/modules/refine.md` |
| 改写盘格式 / 单遍应用 / 去重自愈 / 锁 / 备份 | `docs/knowledge-base/modules/store.md` |
| 改注入内容 / 上限 / agent 闸门 | `docs/knowledge-base/modules/injection.md` |
| 改报警账本 / 面包屑 / 销账 / doctor 面板 | `docs/knowledge-base/modules/alerts.md` |
| 改多机云同步 / PII 闸门 / 手工通道 / dry-run | `docs/knowledge-base/modules/sync.md` |
| 改宿主壳（事件循环 / 4 个工具 / 诊断 / 同步接线） | `docs/knowledge-base/modules/host-opencode.md` |
| 记忆文件格式、落盘路径、诊断查询 | `docs/knowledge-base/DATA.md` |
| 安装、配置项、CLI 命令、测试、调试 | `docs/knowledge-base/OPERATIONS.md` |
| **陷阱、历史包袱、修改红线** | `docs/knowledge-base/CONVENTIONS.md` |
| DSH 宿主适配调查与施工图 | `docs/knowledge-base/DSH-ADAPT.md` |
| 面向普通用户的说明（非开发文档） | `docs/USER-GUIDE.md` |

**查询流程**：先基于知识库定位涉及模块与文件，给出方案；信息不足时再针对性读源码片段，不要全量读码。涉及架构/数据模型变更时，事后同步更新知识库对应文档。

## CODING GUIDELINES

1. **编码前先思考** - 不要假设。明确陈述假设。如果不确定，请询问。
2. **简洁优先** - 解决问题的最小代码量。不做推测性工作。如果写了200行可以是50行，请重写。
3. **手术式修改** - 只触碰必须的部分。匹配现有风格。移除由你的修改导致的未使用代码。
4. **目标驱动执行** - 定义成功标准。循环直到验证。

## 强制规定（完整红线清单见 CONVENTIONS.md §4）

1. **提交前必过两项**：`pnpm run typecheck` 0 错误 + `pnpm test` 全绿（基线 **25 文件 / 366 用例**，低于即回归）。**不要 install、不要动 lockfile。**
2. **包管理只用 pnpm**（全局规则）；不用 npm/yarn/bun/npx。
3. **宿主入口只 default 导出**：`src/hosts/opencode/index.ts` 多导出任何命名函数都会被宿主当插件调用而 crash（`plugin config hook failed`）；`~/.config/opencode/plugins/memx.ts` 的 re-export 同理只导 default。
4. **core 层零宿主依赖**：`src/core/` 禁止 import `@opencode-*`；core 也不反向依赖宿主持有的实例（AlertStore 由宿主注入、面包屑字符串由宿主算好传入）。
5. **hosts 壳单向依赖**：index → session-llm → context-shape；`session-llm.ts` 绝不能回头 import `index.ts`（成环）；共享逻辑一律下沉 `context-shape.ts`。
6. **context hook 是最要害的一段**：非子会话**只 append 绝不替换** system；提炼子会话整体替换 + temperature 0.2，注入绝不参与；hook 内不 await、异常退化为"不注入"。写坏 `event.system` 的表现是"模型静默变笨"而非报错。
7. **禁止在 context hook 里 `event.tools = {}`**：子会话请求被免费档网关 403，症状是"永不写盘且 failures 不涨、lastError 为空"。
8. **相对 import 一律带 `.ts` 扩展名**：CLI 走 `node --experimental-strip-types` 直载源码，缺扩展名 tsc/vitest 都发现不了（`tests/import-style.test.ts` 与 `tests/scripts-smoke.test.ts` 会拦）。
9. **提炼模型出问题：报告，不降级不换模型**（用户硬约束）。生产默认 `opencode/mimo-v2.6-flash-free`；本机开发用 `~/.opencode/memx.config.json` 覆盖 `opencode-go/longcat-2.5-preview-free`（本机免费档被网关 403/429 挡）。deepseek 官方 key 无效，勿用。
10. **写盘保留非受管内容**（否则 memx 第二轮起静默失效）；**LLM 调用绝不进文件锁**；**同步 push/pull 永不 await**。
11. **报警只走 `recordAlert` / `AlertStore`**（`~/.opencode/memx-alerts.json` 是事实源，`diag.alerts` 只是只写镜像）；可自愈故障恢复后要 `resolve(code)` 销账。
12. **改 src 必须重启 OpenCode**；`memx.config.json` 的 `refinementModel` / `inject.*` 即时生效，**`sync` 段例外——只在 setup 读一次，改完必须重启**。
13. **状态面板用 `pnpm run doctor`**，别用 `pnpm doctor`（pnpm 有同名内建命令，会静默跑成 pnpm 自检）。
14. **测试每文件用独立 tmp home**，绝不碰真实 `~/.opencode`；测试禁 `bun:test`。
15. **判断插件真实状态先跑 doctor / 查 kv 表**——`memx_status` 回执只是固定字段（`alerts` 例外，以账本文件为准）。
16. **worktree 纪律（2026-10-17 用户明确「issue 关闭，相应的 worktree 也要清理」）**：
    - ① **issue / PR 一旦关闭，必须立刻清理对应 worktree + 本地分支**：`git worktree remove --force <path>` → `git branch -D <branch>`（squash 合并后提交**不是** main 祖先，故用 `-D`）→ `git worktree prune` → `git worktree list` 确认只剩主工作区。
    - ② **本仓的任务分支必须落在仓库外的 worktree 容器** `/Users/gubin/workspace/memx-worktrees/`，**绝不** checkout 在主仓 —— 本机 opencode **从主仓加载本插件源码**（`~/.config/opencode/plugins/memx.ts` → `src/hosts/opencode/index`），主仓切到未合并分支会让**插件加载到未合并代码**（已真实发生过一次）。
    - ③ 建 worktree 一律**绝对路径 + 从主仓根执行**（在子目录里跑 `git worktree add .worktrees/X` 会嵌进错误的 worktree）；`scripts/pipeline/new-task.sh` 依赖 HTTPS fetch、在本机可能挂 → 先 `git fetch`（SSH）再手工 `git worktree add`。
17. **读写记忆只走宿主工具（`memory_write` / `memory_search` / `forget`）或提炼单写者（#24 起 CLI 退役）**：DSH 与 opencode 两边都经宿主工具调 core——写 `writeProjectMemory`、检索 `searchMemories`、软删 `forgetMemory` + `writeMemoryIndex`（**同一写入口 + 同一把锁**）。原对外 CRUD 面 CLI（`mem` 脚本）已于 2026-10-23 删除（检索逻辑上提到 `src/core/store/memory-search.ts`）。
    - **禁止直写 `~/.opencode/**` 的 markdown**：会绕过 `withFileLock` + 索引更新 + `.bak`，留下"**不在索引里的孤儿**"（2026-10-17 实测（当时的 `status` 子命令）报 `orphanFiles=3`：文件在磁盘、注入链看不到）与格式分叉。
    - 读单条记忆就直接只读 `~/.opencode/projects/<slug>/.mem/<file>.md`；需要全文检索用 `memory_search`（大小写不敏感、返回 `file:line`）。
    - 语义（规格如此，勿当 bug）：`memory_search` 缺省只查当前项目（不传 slug 才全库）；`forget` 是软删（文件进 `.mem/.trash/` + 移除索引条目），回执 `[memx] 已遗忘 N 条：…` / `[memx] 未匹配：<kw>`。
    - 实现：`src/hosts/dsh/index.ts`（宿主工具）+ `src/core/store/memory-search.ts`（检索）；说明见 `docs/knowledge-base/OPERATIONS.md §3.1`（已退役说明）与 `src/hosts/dsh/README.md`「工具」。

## 常用命令（详情见 OPERATIONS.md）

```bash
pnpm test            # vitest run（基线 26 文件 / 396 用例）
pnpm run typecheck   # tsc --noEmit
pnpm run doctor      # 只读状态面板：alerts / memory files / opencode diag / sync（含 sync.unsyncedCommits）
pnpm sync:dry-run    # 同步只读预览（加 `-- --fetch` 先取远端；永不 push）
pnpm sync:op -- status|pull|push|both [--machine=<name>]
pnpm sync:op pii     # 只读 PII 自查：命中明细 file / 行号 / 规则名（绝不回显内容）
pnpm alerts:clear [--code=SYNC_ERROR] [--dry-run]
```
