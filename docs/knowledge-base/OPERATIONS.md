# OPERATIONS.md — 安装、配置、测试与调试

> 最后更新: 2026-10-15 · commit `fe26fa1`

## 1. 安装（install.sh，6 步幂等）

```bash
git clone https://github.com/guraul/memx.git
cd memx
bash install.sh            # 默认装到 ~/workspace/memx；bash install.sh <路径> 覆盖
```

| 步 | 做什么 | 失败提示 |
|----|--------|----------|
| 1 | clone / `git pull --ff-only` 到 `~/workspace/memx`（先建父目录） | — |
| 2 | `pnpm install` | 无 pnpm → 提示 `corepack enable pnpm` 后重跑，**不用 npm/yarn/bun** |
| 3 | 写 `~/.config/opencode/plugins/memx.ts`：`export { default } from "<repo>/src/hosts/opencode/index";` | 只 default 导出 |
| 4 | 确保 `~/.config/opencode/package.json` 有 v2 三件套（`@opencode-ai/plugin` v1 名自动改写；坏 JSON 报错不覆盖） | — |
| 5 | `node scripts/sync-protocol.ts ~/.opencode/memx-protocol.md`（幂等；需 **Node ≥22.6**） | — |
| 6 | 幂等补 `opencode.json` 的 `instructions` 三条（**v2.0.26 上是死字段 no-op**，仅向前兼容） | — |

装后验证：**重启 OpenCode**（插件启动时加载）→ `/status` 显示 memx → 跑 `memx_status` 看 `inject.*`（`hookFires` 触发数 vs `injections` 真注入数）→ 确认 UI 渲染层会剥离 HTML 注释（宿主不从 system prompt 剥注释，这是渲染层的事）。

老安装升级注意：`~/.opencode/USER.md` 里若还有手写协议块要删掉（协议已独立成 `memx-protocol.md`，放 USER.md 里会被提炼冲掉）。

## 2. 配置（`~/.opencode/memx.config.json`，改完 30 秒内生效、无需重启）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `refinementModel` | string | `opencode/mimo-v2.6-flash-free` | 提炼模型 `provider/model`。**生产保持免费档**；本机开发覆盖为 `opencode-go/longcat-2.5-preview-free`（本机免费档被网关 403/429 挡）。deepseek 官方 key 无效勿用 |
| `throttleMinutes` | number | 10 | 提炼节流（分钟） |
| `inject.enabled` | boolean | false→**true** | 是否注入 |
| `inject.includeAgents` | `"all"` \| string[] | `"all"` | 生效集合 |
| `inject.excludeAgents` | string[] | `[]` | 永远压过 include |
| `maxSignalsPerSession` | number | 20 | ⚠️ **已解析但无消费方**（缓冲上限硬编码 20，见 CONVENTIONS.md） |
| `autoBackupCount` | number | 5 | ⚠️ **已解析但无消费方**（备份 5 版硬编码） |

模型可用性出问题：**停下报告，不降级不换模型**（用户硬约束）。

### 2.1 云同步（阶段 4 第二半，默认关）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `sync.enabled` | boolean | `false` | 总开关；默认关 = 不注册定时器、不 clone |
| `sync.repo` | string | `"guraul/memx-sync"` | `owner/name`，或完整 URL / 绝对路径 / `file:`（本机自测） |
| `sync.branch` | string | `"main"` | 目标分支 |
| `sync.machineName` | string | `""` | **空同样不启动**；非空才启用 |
| `sync.intervalMinutes` | number | `30` | 定时拉取间隔 |

⚠️ **与上表不同：`sync` 段只在插件 setup 时读一次，改完必须重启宿主**（`refinementModel` / `inject.*` 才是即时生效）。开启步骤建议：

```bash
pnpm sync:dry-run                 # 1) 只读预览：待同步清单 + PII 命中
pnpm sync:op pii                  # 1b) 只看 PII 自查明细（file / 行号 / 规则名；绝不回显内容）
pnpm sync:op -- push --machine=<name>   # 2) 人工首推（不改配置，宿主无感）
# 3) 确认无误后再改 memx.config.json 开 sync.enabled + machineName，然后重启宿主
```

详细语义（PII 闸门 / 重试 / 备份 / 锁 / 已知限制）见 [modules/sync.md](modules/sync.md)。

## 3. 开发与验证

```bash
pnpm test            # vitest run —— 基线 25 文件 / 366 用例全绿，低于即回归
pnpm run typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）

# 阶段 4 CLI（全部只读或显式手工操作，退出码恒 0）
pnpm run doctor      # 只读状态面板：alerts / memory files / opencode diag / sync
pnpm sync:dry-run    # 同步只读预览（加 `-- --fetch` 先取远端；永不 push）
pnpm sync:op -- status|pull|push|both [--machine=<name>]
pnpm sync:op pii     # 只读 PII 自查：命中明细 file / 行号 / 规则名（绝不回显内容）
pnpm alerts:clear [--code=SYNC_ERROR] [--dry-run]
```

## 3.1 对外 CRUD 面（`scripts/mem.ts`，issue #13 / agent-mobile#62 路径 A 切片 1）

DSH 与外部工具当客户端、经 bash 直接调用的**只读+受控写**入口。命令面：

```bash
pnpm mem slug [--dir <path>]                # 按宿主同款规则推导 slug（deriveSlug）
pnpm mem list [--json]                      # 列索引里的 slug 小节与条目
pnpm mem search <kw> [--slug <s>] [--json]  # 跨 .mem/*.md 检索（标题/hook/正文，给行号）
pnpm mem get <slug> <filename> [--json]     # 打印单条记忆
pnpm mem status [--json]                    # 计数 + 健康摘要
pnpm mem write --slug <s> [--dry-run] [--json]   # stdin 读 JSON（MemoryProposal[]）→ 锁内 applyMemoryProposals + 写索引
pnpm mem forget <keyword> --slug <s> [--dry-run] [--json]  # 软删（进 .trash）+ 移除索引条目
```

- `--slug` 与 `--dir` 二选一（`--dir` 走 `deriveSlug`）；`slug`/`list`/`status` 之外缺这两者报用法错误。
- 退出码：`0` 成功 / `1` 用法错误 / `2` 业务错误（slug 不存在、未匹配、载荷非法）。
- **与提炼单写者的关系**：提炼（refine/refineMemory）仍是**唯一写者**、路径不变；CLI 与 `memory_write` 工具**共用同一写入口**（`withFileLock` + `applyMemoryProposals` / `forgetMemory` + `writeMemoryIndex`），不另写解析、不直写 markdown——避免两个写者 + 格式分叉。
- 写盘副作用：`writeMemoryIndex` 覆盖前自动生成 `MEMORY.md.bak.<ts>`（留 5 份）；`forget`/`deprecate` 把文件移入 `.mem/.trash/`（软删可恢复）。
- 集成测试 `tests/mem-cli.test.ts`：每用例独立 `HOME=<tmp>`（绝不碰真实 `~/.opencode`），child_process 真跑 CLI。

- ⚠️ **必须 `pnpm run doctor`**，别用 `pnpm doctor`——pnpm 有同名内建命令，会静默跑成 pnpm 自检而不是 memx 面板。
- CLI 走 `node --experimental-strip-types` 直载 `.ts`：**相对 import 必须带 `.ts` 扩展名**（缺了 tsc/vitest 都发现不了，运行时才 `ERR_MODULE_NOT_FOUND`）；`tests/scripts-smoke.test.ts` 真跑脚本兜这条，所以**加了 CLI 就要让它进冒烟测试**。
- **提交前必过 typecheck + test**；不要 install、不要动 lockfile。
- 测试 mock homedir 到独立 tmp home；**每测试文件用自己独立的 tmp home**（如 `/tmp/memx-test-home-<文件名>`）——共享 home 时并行线程下某文件的 afterAll 清理会把别的文件状态删掉，报假失败。撞上可疑竞态先 `rm -rf /tmp/memx-test-home*` 再跑一遍确认。
- 环境是 Node + vitest，**不是 bun**——别 import `bun:test`。

## 4. 调试流程

1. **先跑 `pnpm run doctor`**（只读面板：alerts / 记忆文件规模 / kv 诊断 / sync 四段）——多数问题一眼可见，且它不写盘不联网。
2. **分清"哪一层没生效"**：信号没捕获 / 提炼没跑 / 写盘没落 / 注入没进。`memx_status` 的 captured → refinements → written → injections 四个计数就是四个关口。
3. **查 kv 表拿真相**（`memx_status` 只是固定字段；alerts 以账本文件为准）：
   ```bash
   sqlite3 ~/.local/share/opencode/opencode.db "SELECT value FROM kv WHERE key LIKE 'plugin:%'"
   ```
4. **看宿主日志**：`~/.local/share/opencode/log/opencode.log`——搜 `level=ERROR`；成功写盘搜 `Updated USER.md` / `Updated MEMORY.md`；LLM 原始返回搜 `llm raw(N):`（400 字符截断，确认是否合法 JSON）。
5. **子会话空回复**：先看 `finish` / `error` / `rawFinish` 三个字段，别只看 content parts。
6. **手工触发提炼**：调 `reflect` 工具（`force=true` 绕节流）。
7. **改了 src 不生效**：插件只在启动时加载——重启 OpenCode。改配置文件则即时生效（**`sync` 段例外，要重启**）。

常见症状速查：

| 症状 | 先查 |
|------|------|
| 永不写盘且 failures 不涨、lastError 空 | 子会话 403 FreeTierError（禁 event.tools={}，见 CONVENTIONS.md §1） |
| `hookFires > 0` 但 `injections == 0` | `inject.gate` 与 `inject.empty` |
| `styleHit:true` 但 `signalCount:0` | 正常：AI 提到词但没按注释格式输出 |
| 出现 `CAPTURE_CURSOR_LOST` warn | 预期降级（上下文压缩/分叉），非崩溃 |
| 同批信号每轮重烧 LLM | 三态处理被破坏（adjudicated-empty 没清缓冲） |
| MEMORY.md 首行有 `<!-- memx: ⚠️ … -->` | 有 warn/critical 报警未销账——`pnpm run doctor` 看明细，修好后 `pnpm alerts:clear --code=X` |
| 同步没动静 | `doctor` 的 sync 段：`enabled` / `machineName` 是否都非空；改过配置是否忘了重启宿主 |
| 同步一直失败刷屏 | `memx-sync-state.json` 的 `lastError` / `consecutiveFailures`；报警已按同 code+message 去重 |
| push 被拒（PII） | `pnpm sync:op pii`（或 `pnpm sync:dry-run`）看命中的 file/行号/规则名；**不要**为了推上去而删规则，先确认是真密钥（清理记忆内容）还是词形误报（调规则 + 补正反例测试） |
| push 返回 `no-change` 但本地有提交没推出去 | `doctor` 的 `sync.unsyncedCommits`；issue #12 后 `no-change` 只在"无文件差异**且**无未推提交"时成立，>0 会照常 push |
| pull 后本地改动没了 | 找 `<file>.bak.<ts>`（pull 覆盖前自动备份，每文件留 5 份） |

## 5. 发布物与兼容

- 依赖：`@opencode/plugin` / `@opencode/client` ^2.0.26（v2-only）；v1 的 `@opencode-ai/plugin` 代码不再 import。
- `opencode.json` 的 `instructions` 是死字段（宿主只从 AGENTS.md 组装指令）——不要指望它注入。
- `~/.config/opencode/AGENTS.md` 是宿主唯一验证过的指令通道；memx **不写**它（所有权缺口，见 CONVENTIONS.md §3）。
- **相对 import 一律带 `.ts` 扩展名**（阶段 4 起）：CLI 走 `node --experimental-strip-types` 直载源码，缺扩展名只有真跑才炸。新增文件时照抄现有风格。
- CLI 全部位于 `scripts/`（不是 `src/cli/`）；新增命令要同时改 `package.json` scripts 与 `tests/scripts-smoke.test.ts`。
