# OPERATIONS.md — 安装、配置、测试与调试

> 最后更新: 2026-10-25 · commit `c232168`

## 1. 安装（install.sh，6 步幂等，**只装 OpenCode 半边**）

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

### 2.0.1 DSH 侧配置（cordis 配置，不是 `memx.config.json`）

DSH 的四个字段由薄壳包 `dsh-plugin-memx` 用 schemastery `.volatile()` 声明（**已落地并安装**；在 Web 设置页「设置 → 记忆」或 profile 的 `cordis.patch.yml` 的 `id: memx` 段修改）：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `provider` | string | `""` | 提炼用 provider；空 = 跟随当前会话（`agent.options`） |
| `model` | string | `""` | 提炼用 model；空 = 跟随当前会话 |
| `autoRefine` | boolean | `true` | 轮末自动提炼；`false` 只关轮末补记，显式 `memory_write` 不受影响 |
| `throttleMinutes` | number | `10` | 会话级节流（1–1440）；缺省回落 `memx.config.json` 的 `throttleMinutes` |

四个都是 volatile 字段，**每次轮末现读**（改完即时生效，无需重启）。`~/.opencode/memx.config.json` 的 `refinementModel` 对 DSH **不生效**（路由来自上面两个字段或会话模型）。

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
pnpm test            # vitest run —— 基线 29 文件 / 459 用例全绿，低于即回归
pnpm run typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）

# 阶段 4 CLI（除 doctor 的顶距报警外都只读；退出码恒 0 —— 唯一例外：backfill --push 推送失败退 1）
pnpm run backfill:created --dry-run   # created 回填预演：只报数不写盘
pnpm run backfill:created --push      # created 回填真跑并推送（**必须**：只写不推会被下一次 sync pull 覆盖）
pnpm run doctor      # 只读状态面板：alerts / memory files / memory stats / opencode diag / sync
pnpm sync:dry-run    # 同步只读预览（加 `-- --fetch` 先取远端；永不 push）
pnpm sync:op -- status|pull|push|both [--machine=<name>]
pnpm sync:op pii     # 只读 PII 自查：命中明细 file / 行号 / 规则名（绝不回显内容）
pnpm alerts:clear [--code=SYNC_ERROR] [--dry-run]
```

### 3.0 doctor 的 memory stats 段（#30）

`memory files` 之后新增四类行（`src/core/health/memory-stats.ts`，纯只读）：

```
memory index: 15.8KB / 25KB（已用 63.1%，顶距 36.9%；阈值 <20% 触发 HEADROOM_LOW）
  Users-gubin-workspace-agent-mobile: 30 条, 8.3KB, 33.4% of 25KB
  …
card age: ≤7天=1 8-30天=0 31-90天=0 >90天=0 未知=88（共 89 张，按 frontmatter created；缺失计未知，不用 mtime）
trash: 26 个文件（Users-gubin-workspace-agent-mobile=10 …）
```

| 行 | 口径 | 会不会报警 |
|----|------|-----------|
| `memory index` | 整份 `MEMORY.md` 的 UTF-8 字节 / `INJECT_MAX_BYTES`（25KB，与注入闸门同源）；顶距 = 100 − 已用 | **会**：顶距 <20% → 账本记一条 `critical/HEADROOM_LOW`（同 code+message 去重，`pnpm alerts:clear --code=HEADROOM_LOW` 销账） |
| 各 slug 节 | 节头 + 指针行 + extras 原样行的字节，不含节间空行/preamble；百分比 = 该节字节 / 25KB（可 >100） | 不会（用来定位"该拆哪个节"） |
| `card age` | 读卡片 frontmatter `created`（UTC 日期）分桶 ≤7 / 8-30 / 31-90 / >90 天；缺失或不可解析 → **未知**。**绝不用 mtime**（update 与 sync pull 都会重置它） | 不会 |
| `trash` | `projects/<slug>/.mem/.trash/` 下普通文件数（含空 slug 遗留 `projects/.mem/`）；子目录不计 | 不会（软删残留是可恢复历史，不是故障） |

因此 **doctor 是唯一会写盘的诊断命令**：只在阈值以下往 `~/.opencode/memx-alerts.json` append 一条，不改任何记忆文件。`scripts-smoke` 的新用例全部用临时 `HOME` 起子进程，不碰本机账本。

## 3.1 对外 CRUD 面（已退役，2026-10-23 / #24）

原对外 CRUD 面 CLI（`mem` 脚本，`slug|list|search|get|status|write|forget` 子命令）已删除。外部客户端
不再经 bash 调 CLI，改由**宿主工具**走同一份 core：

| 需求 | 现在的入口 |
|------|------------|
| 读：检索 / 列条目 / 看健康 | 宿主工具 `memory_search`（DSH）/ opencode 侧 `memx_status` |
| 写一条记忆 | 宿主工具 `memory_write`（与提炼共用 `withFileLock` + `applyMemoryProposals`） |
| 软删 | 宿主工具 `forget`（锁内 `forgetMemory` + `writeMemoryIndex`，文件进 `.mem/.trash/`） |
| 单条详情 | 直接读 `~/.opencode/projects/<slug>/.mem/<file>.md`（只读） |

检索逻辑保留在 core `src/core/store/memory-search.ts`（`searchMemories(keyword, slug?)`），
所以删 CLI **没有**丢掉"跨 `.mem/*.md` 找 file:line"的能力。

- 写盘副作用不变：`writeMemoryIndex` 覆盖前自动生成 `MEMORY.md.bak.<ts>`（留 5 份）；`forget`/`deprecate` 把文件移入 `.mem/.trash/`（软删可恢复）。
- 宿主工具的 slug 缺省按会话 cwd 用 `deriveSlug` 推导（与注入一致）；DSH 的 `forget` 推导不出 slug 时直接失败（不猜项目）。

### 3.2 DSH 宿主（已落地并安装）

现状：适配器在本仓 `src/hosts/dsh/`；接线由独立仓的薄壳包 `dsh-plugin-memx`（`~/workspace/self-dsh-plugins/dsh-plugin-memx`）完成——已 link 进 `~/.dsh/profiles/web`，`cordis.patch.yml` 里有 `id: memx` 行。薄壳包用 TypeScript load hook **直接加载本仓源码**，所以改 memx 不用重编薄壳包。

| 场景 | 做法 |
|------|------|
| 安装 / 升级薄壳包 | `dsh plugin --profile web add /Users/gubin/workspace/self-dsh-plugins/dsh-plugin-memx`，然后重启 dsh web |
| 跑 DSH 适配器测试 | `pnpm test tests/hosts-dsh.test.ts`（假 ctx：systemPrompt / tools / llm / agents / workingDirectory） |
| 改本仓 `src/hosts/dsh/**` | **重启 dsh web**（无 HMR；launchd 服务 `com.deepseek.dsh-web.*`）；不用重编薄壳包 |
| 改薄壳包 `src/config.ts` / `src/client/**` | `pnpm build`（esbuild 出 `lib/config.js` / `lib/client.js`）后重启 dsh web |
| 改 cordis 配置 / profile bundles | 即时热生效（web profile `patchReload: live`） |
| 改设置页「记忆」四个字段 | 即时生效（volatile，轮末现读） |
| 改 `~/.opencode/memx.config.json` | 即时生效（每次提炼重读），但 `refinementModel` 对 DSH 不生效 |

⚠️ 薄壳包 `lib/index.js` 硬编码 `MEMX_ROOT=/Users/gubin/workspace/memx/`：搬仓 / 换 clone / 多 checkout 必须同步改，否则 DSH 静默加载旧代码。

DSH 侧**没有** `pnpm run doctor` 的对应面板：诊断在内存 + 宿主日志（`[memx] …`）；Web 设置页只改配置、不显示计数。

### 3.3 通用约定

- ⚠️ **必须 `pnpm run doctor`**，别用 `pnpm doctor`——pnpm 有同名内建命令，会静默跑成 pnpm 自检而不是 memx 面板。
- CLI 走 `node --experimental-strip-types` 直载 `.ts`：**相对 import 必须带 `.ts` 扩展名**（缺了 tsc/vitest 都发现不了，运行时才 `ERR_MODULE_NOT_FOUND`）；`tests/scripts-smoke.test.ts` 真跑脚本兜这条，所以**加了 CLI 就要让它进冒烟测试**。
- **提交前必过 typecheck + test**；不要 install、不要动 lockfile。
- 测试 mock homedir 到独立 tmp home；**每测试文件用自己独立的 tmp home**（如 `/tmp/memx-test-home-<文件名>`）——共享 home 时并行线程下某文件的 afterAll 清理会把别的文件状态删掉，报假失败。撞上可疑竞态先 `rm -rf /tmp/memx-test-home*` 再跑一遍确认。
- **并发安全，但仍建议单进程跑**（#35）：每文件的 tmp home 带 `process.pid`，4 进程同时跑全量也全绿（实测 4 进程 × 3 轮）。验证脚本 `bash scripts/test-concurrent.sh`（等价 `pnpm test:concurrent`）默认 4 进程 × 3 轮，`PROCS` / `ROUNDS` 可调；每进程用一次性 HOME（不碰真实库），任一进程失败即非零退出并打印**每进程的失败用例名**。CI 与本机同一份脚本；日常门禁仍跑单进程 `pnpm test`——并发只用于验证隔离性，会让负载翻倍而不更早暴露逻辑问题。
- 负向断言（"不该发生"）**不要用固定 sleep**：等被测代码自己给出的 quiescent 信号（DSH 侧是 `apply()` 返回的 `diag.skipped.<reason>` 自增）再断言未发生，否则满载时会在判定执行前就断言成功，形成假绿。
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
7. **改了 src 不生效**：插件只在启动时加载——重启 OpenCode / dsh web。改配置文件则即时生效（**OpenCode 的 `sync` 段例外，要重启**）。
8. **DSH 侧排查**：没有 kv、没有 `memx_status`，看宿主日志里的 `[memx] …`；"轮末没写"按 `skipped.*` 六类计数定位（`disabled` / `duplicate` / `written` / `empty` / `throttle` / `noModel`，只在内存，重启清零）。

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
| forget 掉的文件又被拉回来 / `doctor` 的 `memory files` 段显示孤儿不降 | `doctor` 看 `sync.pendingDeletions`（远端还有、本地已删）：>0 说明删除还没推出去，跑 `pnpm sync:op -- push` 收敛；issue #21 起 `forget` 成功后会自动推 |
| push 被拒（PII） | `pnpm sync:op pii`（或 `pnpm sync:dry-run`）看命中的 file/行号/规则名；**不要**为了推上去而删规则，先确认是真密钥（清理记忆内容）还是词形误报（调规则 + 补正反例测试） |
| push 返回 `no-change` 但本地有提交没推出去 | `doctor` 的 `sync.unsyncedCommits`；issue #12 后 `no-change` 只在"无文件差异**且**无未推提交"时成立，>0 会照常 push |
| pull 后本地改动没了 | 找 `<file>.bak.<ts>`（pull 覆盖前自动备份，每文件留 5 份） |
| DSH 会话里看不到刚写的记忆 | 设计语义：DSH 注入每会话只算一次（下个会话生效），不是丢失 |
| DSH 轮末不提炼 | 宿主日志 `[memx]`；按 `skipped.*` 判断：`disabled`（autoRefine=false）/ `throttle` / `noModel`（provider/model 取不到，不猜不回落） |
| DSH 提示「已记住 N 条」不出现 | `createUserMessage` 动态 import 失败 → 只跳过提示，写盘不受影响 |

## 5. 发布物与兼容

- 依赖：`@opencode/plugin` / `@opencode/client` ^2.0.26（v2-only）；v1 的 `@opencode-ai/plugin` 代码不再 import。
- DSH 侧**不声明任何 `@deepseek-ai/*` 依赖**（结构类型手写在 `src/hosts/dsh/types.ts`）；接线在独立仓薄壳包 `dsh-plugin-memx`（声明 `dsh.bundle.patch` + schemastery 配置 + Web 设置页）。
- `opencode.json` 的 `instructions` 是死字段（宿主只从 AGENTS.md 组装指令）——不要指望它注入。
- `~/.config/opencode/AGENTS.md` 是宿主唯一验证过的指令通道；memx **不写**它（所有权缺口，见 CONVENTIONS.md §2 #30）。
- **相对 import 一律带 `.ts` 扩展名**（阶段 4 起）：CLI 走 `node --experimental-strip-types` 直载源码，缺扩展名只有真跑才炸。新增文件时照抄现有风格。
- CLI 全部位于 `scripts/`（不是 `src/cli/`）；新增命令要同时改 `package.json` scripts 与 `tests/scripts-smoke.test.ts`。
- `package-lock.json`（npm 残留）已于 2026-10-23 删除，仓库只维护 `pnpm-lock.yaml`；**不要重新生成 npm 锁文件**。
