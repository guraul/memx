# memx - 项目说明

**Updated:** 2026-10-25

双宿主双轨记忆插件（OpenCode v2 + DSH；Track 1 用户风格 + Track 2 项目记忆），阶段 4 追加报警账本、doctor 只读面板与多机云同步；#17 追加 DSH 宿主壳与宿主无关流水线。项目知识库已按模块拆分到 `docs/knowledge-base/`，本文件只承担**路由**与**强制规定**两个职责。功能细节、数据格式、钩子机制、陷阱一律查阅知识库，不要在本文重复。

## 知识库路由（优先查阅）

| 场景 | 加载文档 |
|------|----------|
| 全局认知、技术栈、仓库拓扑、数据流 | `docs/knowledge-base/INDEX.md`（每次对话优先） |
| 架构分层、双宿主钩子映射、core/hosts 边界、正确性机制 | `docs/knowledge-base/ARCHITECTURE.md` |
| 对外接口（宿主工具 4+3 / CLI / 配置 / core 导出） | `docs/knowledge-base/API.md` |
| 改信号捕获 / 缓冲 / 游标 | `docs/knowledge-base/modules/signals.md` |
| 改提炼（提示词 / 三态 / LLM 调用） | `docs/knowledge-base/modules/refine.md` |
| 改写盘格式 / 单遍应用 / 去重自愈 / 检索 / 锁 / 备份 | `docs/knowledge-base/modules/store.md` |
| 改注入内容 / 上限 / agent 闸门 / DSH 按项目节注入 | `docs/knowledge-base/modules/injection.md` |
| 改报警账本 / 面包屑 / 销账 / doctor 面板 | `docs/knowledge-base/modules/alerts.md` |
| 改多机云同步 / PII 闸门 / 删除传播 / 手工通道 / dry-run | `docs/knowledge-base/modules/sync.md` |
| 改 OpenCode 壳（事件循环 / 5 个工具 / 诊断 / 同步接线） | `docs/knowledge-base/modules/host-opencode.md` |
| 改 DSH 壳（注入段 / 3 个工具 / 轮末补记 / 会话级节流） | `docs/knowledge-base/modules/host-dsh.md` |
| 记忆文件格式、落盘路径、诊断查询 | `docs/knowledge-base/DATA.md` |
| 安装、配置项、CLI 命令、测试、调试 | `docs/knowledge-base/OPERATIONS.md` |
| **陷阱、历史包袱、修改红线** | `docs/knowledge-base/CONVENTIONS.md` |
| DSH 适配：已落地并安装（薄壳包 `dsh-plugin-memx`） | `docs/knowledge-base/DSH-ADAPT.md` |
| 面向普通用户的说明（非开发文档） | `docs/USER-GUIDE.md` |

**查询流程**：先基于知识库定位涉及模块与文件，给出方案；信息不足时再针对性读源码片段，不要全量读码。涉及架构/数据模型变更时，事后同步更新知识库对应文档。

## CODING GUIDELINES

见 `~/.dsh/AGENTS.md` §6（编码前思考 / 简洁优先 / 手术式修改 / 目标驱动执行 + 验证纪律）。

## 强制规定（完整红线清单见 CONVENTIONS.md §4）

1. **提交前必过两项**：`pnpm run typecheck` 0 错误 + `pnpm test` 全绿（基线 **26 文件 / 416 用例**，低于即回归）。**不要 install、不要动 lockfile。**
2. **包管理器只用 pnpm**：见 `~/.dsh/AGENTS.md` §3。
3. **两宿主导出契约相反，不能互抄**：`src/hosts/opencode/index.ts` **只 default 导出**（多导出任何命名函数都会被宿主当插件调用而 crash：`plugin config hook failed`；`~/.config/opencode/plugins/memx.ts` 的 re-export 同理）；`src/hosts/dsh/index.ts` **必须具名导出** `name` / `inject` / `Config` / `apply`（Cordis 不认 default）。
4. **core 层零宿主依赖**：`src/core/` 禁止 import `@opencode-*` 或 `@deepseek-ai/*`；core 也不反向依赖宿主持有的实例（AlertStore 由宿主注入、面包屑字符串由宿主算好传入）。`src/hosts/dsh/**` 同样不得 import `@deepseek-ai/*`（结构类型手写在 `types.ts`）。
5. **hosts 壳单向依赖 + 流水线只有一份**：OpenCode 侧 index → session-llm → context-shape，`session-llm.ts` 绝不能回头 import `index.ts`（成环），共享逻辑下沉 `context-shape.ts`；流水线语义（缓冲/节流/三态/写盘/报警）只在 `src/core/pipeline/session.ts`，宿主差异一律走 `PipelineHost` 窄口。
6. **context hook 是最要害的一段**：非子会话**只 append 绝不替换** system；提炼子会话整体替换 + temperature 0.2，注入绝不参与；hook 内不 await、异常退化为"不注入"。写坏 `event.system` 的表现是"模型静默变笨"而非报错。
7. **禁止在 context hook 里 `event.tools = {}`**：子会话请求被免费档网关 403，症状是"永不写盘且 failures 不涨、lastError 为空"。
8. **相对 import 一律带 `.ts` 扩展名**：CLI 走 `node --experimental-strip-types` 直载源码，缺扩展名 tsc/vitest 都发现不了（`tests/import-style.test.ts` 与 `tests/scripts-smoke.test.ts` 会拦）。
9. **提炼模型出问题：报告，不降级不换模型**（用户硬约束）。生产默认 `opencode/mimo-v2.6-flash-free`；本机开发用 `~/.opencode/memx.config.json` 覆盖 `opencode-go/longcat-2.5-preview-free`（本机免费档被网关 403/429 挡）。deepseek 官方 key 无效，勿用。
10. **写盘保留非受管内容**（否则 memx 第二轮起静默失效）；**LLM 调用绝不进文件锁**；**同步 push/pull 永不 await**。
11. **报警只走 `recordAlert` / `AlertStore`**（`~/.opencode/memx-alerts.json` 是事实源，`diag.alerts` 只是只写镜像）；可自愈故障恢复后要 `resolve(code)` 销账。
12. **改 src 必须重启宿主**（OpenCode / dsh web 都没有源码热更）；`memx.config.json` 的 `refinementModel` / `inject.*` 即时生效，**OpenCode 的 `sync` 段例外——只在 setup 读一次，改完必须重启**。DSH 的四个 cordis 字段（provider / model / autoRefine / throttleMinutes）每次轮末现读，即时生效。
13. **状态面板用 `pnpm run doctor`**，别用 `pnpm doctor`（pnpm 有同名内建命令，会静默跑成 pnpm 自检）。DSH 侧没有 doctor / `memx_status`，看宿主日志 `[memx] …`。
14. **测试每文件用独立 tmp home**，绝不碰真实 `~/.opencode`；测试禁 `bun:test`。
15. **判断插件真实状态先跑 doctor / 查 kv 表**——`memx_status` 回执只是固定字段（`alerts` 例外，以账本文件为准）。DSH 没有 kv：诊断只在内存 + 宿主日志，重启清零。
16. **worktree 纪律**：通用纪律见 `~/.dsh/AGENTS.md` §7。
    - **本仓特有**：任务分支必须落在仓库外的 `/Users/gubin/workspace/memx-worktrees/`（本机 opencode 从主仓加载本插件源码，主仓切到未合并分支会让插件加载到未合并代码，已真实发生过一次）；`scripts/pipeline/new-task.sh` 依赖 HTTPS fetch、在本机可能挂 → 先 `git fetch`（SSH）再手工 `git worktree add`。
17. **读写记忆**：使用规则见 `~/.dsh/AGENTS.md` §10。本仓实现：DSH 与 opencode 都经宿主工具调 core——写 `writeProjectMemory`、检索 `searchMemories`、软删 `forgetMemory` + `writeMemoryIndex`（**同一写入口 + 同一把锁**）。原对外 CRUD 面 CLI（`mem` 脚本）已于 2026-10-23 删除（检索逻辑上提到 `src/core/store/memory-search.ts`）。
    - 实现位置：`src/hosts/dsh/index.ts`（宿主工具）+ `src/core/store/memory-search.ts`（检索）；说明见 `docs/knowledge-base/OPERATIONS.md §3.1`（已退役说明）与 `src/hosts/dsh/README.md`「工具」。
18. **DSH 已实际安装并运行**：本仓 `src/hosts/dsh/` 是适配器，接线由独立仓的薄壳包 `dsh-plugin-memx`（`~/workspace/self-dsh-plugins/dsh-plugin-memx`）完成——它 link 进 DSH web profile、声明四个 `.volatile()` 配置字段、提供 Web 设置页「记忆」，并通过 TypeScript load hook 直接加载本仓 `src/hosts/dsh/index.ts`。**别再说"DSH 尚不能安装"**。三条已知缺口仍成立：`inject.*` 闸门未接、云同步未接、`turn/end` 未按 `reason` 过滤。⚠️ 薄壳包 `lib/index.js` 硬编码 `MEMX_ROOT=/Users/gubin/workspace/memx/`，搬仓/换 clone 必须同步改，否则加载旧代码。

## 常用命令（详情见 OPERATIONS.md）

```bash
pnpm test            # vitest run（基线 26 文件 / 416 用例）
pnpm run typecheck   # tsc --noEmit
pnpm run doctor      # 只读状态面板：alerts / memory files / opencode diag / sync（含 sync.unsyncedCommits）
pnpm sync:dry-run    # 同步只读预览（加 `-- --fetch` 先取远端；永不 push）
pnpm sync:op -- status|pull|push|both [--machine=<name>]
pnpm sync:op pii     # 只读 PII 自查：命中明细 file / 行号 / 规则名（绝不回显内容）
pnpm alerts:clear [--code=SYNC_ERROR] [--dry-run]
```
