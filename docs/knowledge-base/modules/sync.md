# modules/sync.md — 多机云同步

> 最后更新: 2026-10-23 · issue #10（PII 词边界）/ #12（未推提交不被 no-change 短路）/ #21（删除传播）

## 职责

把本机记忆（USER.md / MEMORY.md / `.mem/**/*.md`）镜像到一个 Git 仓，实现多机共享与备份。**默认关**，开启后自动拉取（启动 + 定时）与自动推送（写盘成功后），并带 PII 脱敏闸门。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/sync.ts`（717 行） | 全部编排：`GitRunner` / `scanSensitive` / `listToSync` / 状态读写 / `buildDryRunReport` / `createSync` |
| `src/core/config.ts` | `MemxSyncConfigSchema`（enabled / repo / branch / machineName / intervalMinutes） |
| `src/hosts/opencode/index.ts` | 接线：setup 建 sync、启动拉一次、定时拉、两个 push 触发点 |
| `scripts/sync-op.ts` | 手工通道（status / pii / pull / push / both，`--machine=<name>` 覆盖） |
| `scripts/sync-dry-run.ts` | 只读预览（`-- --fetch` 先取远端） |
| `scripts/doctor.ts` | 面板 sync 段（config / pendingFiles / status / unsyncedCommits / pii） |

## 配置（`~/.opencode/memx.config.json` 的 `sync` 段）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `false` | 总开关。**默认关**：不注册定时器、不 clone、零副作用 |
| `repo` | `"guraul/memx-sync"` | `owner/name` 或完整 URL / 绝对路径 / `file:` |
| `branch` | `"main"` | 目标分支 |
| `machineName` | `""` | **空同样视为不启动**；非空才启用（多机身份） |
| `intervalMinutes` | `30` | 定时拉取间隔 |

⚠️ **开启 sync 要改配置并重启宿主**——配置只在 setup 读一次（与 `refinementModel` 的即时重读语义不同）。

## 触发点

| 动作 | 时机 | 实现 |
|------|------|------|
| pull（启动一次） | setup 时 | `void sync.pull({ force: true })`（**强制真实 pull**：重启后要补齐落下的远端变更） |
| pull（定时） | 每 `intervalMinutes` | `setInterval(() => void sync?.pull(), …)`（走前置短路路径） |
| push | **Track 2 提炼写盘成功后** | index.ts:435 `void sync?.push()` |
| push | **`memory_write` 工具成功后** | index.ts:758 `void sync?.push()` |
| push | **`forget` 工具成功后** | issue #21：不立刻推，下一轮 pull 会把刚删的文件拉回 |

三个 push 都是 `void` 异步（绝不阻塞写盘 / 工具返回）。

## push 流程

```
1. scanSensitive(全部待推文件)        ← 锁外做
   命中 → 拒推 + SYNC_PII_BLOCKED critical（只报行号+规则名，绝不回显内容）
2. withFileLock(~/.opencode/.memx-sync.lock, ttl 10min / 等锁 5min)
     copy 到 workdir
     → 删除传播（issue #21）：基线树里有、本地已删的同步文件 → 从 workdir 删掉
       （基线 = lastRemoteSha，旧状态无 sha 但同步过 → HEAD；从未同步 → 不删，见下）
     → git status --porcelain（有无文件差异）
     → git rev-list --count @{u}..HEAD（未推提交数，issue #12；取不到 = null → fail-open 不据此短路）
     → 无文件差异 **且** 未推提交 = 0 → kind="no-change" 收工（销 SYNC_ERROR / SYNC_PUSH_FAILED）
     → 有文件差异：add -A → commit（删除会出现在 numstat，如 `path +0 -3 行`）
     → 有未推提交但无文件差异：不造空提交，直接进入 push（补推）
     → push 被拒（非快进）→ fetch + rebase + 重试一次
     再失败 → SYNC_PUSH_FAILED warn
3. 写 memx-sync-state.json（含 unsyncedCommits / lastRemoteSha）；成功路径 resolve("SYNC_ERROR") / resolve("SYNC_PUSH_FAILED")
```

**为什么 push 成功也写 `lastRemoteSha`**（#21）：push 后远端 tip 就是本次镜像结果。不写的话，下一次 pull 的删除基线还停在 push 之前，可能把"push 之后本地又重建"的文件误判成远端删除。写过之后，pull 只认"push 之后别的机器删掉的"。

## pull 流程

```
锁内 ensureRepo
  → 前置短路（仅当 pullOpts.force≠true + 有 lastRemoteSha + consecutiveFailures=0 + lastError=""）
       git ls-remote origin refs/heads/<branch> → sha 与 lastRemoteSha 相同
         → 只刷 lastPullAt（不销账、不动 lastError/consecutiveFailures）→ kind="no-change" 收工
         ⚠️ ls-remote 失败 / 远端变了 / 解析不出 → fail-open，继续下面的完整流程
  → fetch → rebase
  → 远端删除（issue #21，先于回拷）
       git diff --name-only --diff-filter=D <lastRemoteSha>..origin/<branch>
       → 命中且在同步范围 → 本地副本先存 .bak.<ts> 再 unlink
       → lastRemoteSha 为 null（首次 / 旧状态）→ 一律不删（保守 fail-safe）
  → 逐文件比对（远端优先）
       → 本地内容与将写入的不同 → 先存 <file>.bak.<ts>（每文件留最新 5 份）
       → 覆盖
       → rebase 冲突 → rebase --abort + SYNC_CONFLICT critical（留人工）
  → 成功：git rev-parse origin/<branch> 写入 lastRemoteSha（取不到 → null = 未知，下次真拉）
```

**为什么要短路**：定时拉每 `intervalMinutes` 跑一次，夜里没人用也照跑——每次都是 `fetch` + rebase + 逐文件比对（即使无变化也要一次网络往返 + git 目录 churn）。远端 sha 没变时一次 `ls-remote` 就能收工。

**判定为什么这么保守**：短路只在"上次 pull 确实成功过 + 记得那次拉到哪个 sha"时才敢开；`force:true`（启动 / 人工通道）一律绕过它。

## 镜像范围（`walkMirror` / `listToSync`）

包含：`USER.md`、`MEMORY.md`、`projects/<slug>/.mem/**/*.md`（递归）。

排除：`.trash/`（文件名带时间戳，跨机互推必冲突）、`*.bak.*`（备份不进镜像）。

## 删除传播（issue #21）

`forget` 是软删（索引删行 + 文件进 `.trash/`），镜像里对应文件必须**真的从远端消失**，否则下一轮 pull 会把它整条拉回（现场实测连续两天复活 7 条）。规则：

| 方向 | 判据 | 动作 |
|---|---|---|
| push | 文件在**基线树**里、且本地已不存在 | 从 workdir 删除 → `git add -A` 把它写进提交 |
| pull | 文件在 `<lastRemoteSha>` 里、且不在 `origin/<branch>` 里（`git diff --diff-filter=D`） | 本地副本先 `.bak.<ts>` 再 unlink |

**基线（怎么区分"远端删除"与"本地新增未推"）**——这是整条删除传播最关键的一点：

1. push 的基线 = `lastRemoteSha`（上次成功同步的远端 tree）；旧状态文件没有 sha 但 `lastPushAt`/`lastPullAt` 非空 → 用 workdir `HEAD`（= 上次镜像内容）。
2. **从未同步过（首推 / 新机器）→ 基线为 null，绝不传播删除**：新机器本地镜像可能不完整，拿它当"真相"会把远端记忆整体清空。代价只是"第一次 push 不传删除"，下一次 pull 写入 sha 后即生效。
3. 只删**基线里存在**的路径：另一台机器新写、本机还没拉过的文件不在基线里 → 永远不会被当成本地删除（这正是"单看文件存在性无法区分"的解法）。
4. pull 的基线 = `lastRemoteSha`；为 null（首次 pull / 旧状态）→ 一轮不删（保守 fail-safe）。基线已知后只认 **git 明确记录的删除**（`--diff-filter=D`），本地新增未推的文件不出现在 diff 里。
5. push 成功也会刷新 `lastRemoteSha`（见上），避免"刚推出去的删除"在下一轮 pull 被自己重放。

**范围安全**（`isSyncRepoPath`，删除专用，比 `walkMirror` 更严）：只认 `USER.md` / `MEMORY.md` / `projects/<slug>/.mem/**/*.md`；**`.trash/`、任意点开头的文件或目录、`*.bak.*`、范围外路径一律不动**。删本地副本前先写 `.bak.<ts>`（本地可能改过而远端已删）。

## 状态与锁

| 路径 | 内容 |
|------|------|
| `~/.opencode/memx-sync-repo/` | Git workdir（不存在则 clone，存在则 fetch） |
| `~/.opencode/memx-sync-state.json` | `lastPushAt` / `lastPullAt` / `consecutiveFailures` / `lastError` / `lastPiiScan{hits,files,at}` / `lastRemoteSha`（上次成功 pull **或 push** 后的远端 sha；删除传播的基线 + 前置短路都用它；**旧文件无此字段 = null = 未知 → 走真实 pull、本轮不传播删除**，issue #21） / `unsyncedCommits`（最近一次观测到的未推提交数；**旧文件无此字段 = 0**，issue #12） |
| `~/.opencode/.memx-sync.lock` | 串行闸门（`withFileLock`，ttl 10 分钟 / 等锁上限 5 分钟） |

## PII 脱敏闸门（`scanSensitive`）

8 类规则：`openai-key` / `aws-access-key` / `github-token` / `github-pat` / `slack-token` / `jwt` / `private-key` / `env-assignment`。

`openai-key` **必须带词边界**（issue #10 教训）：旧写法 `/sk-[A-Za-z0-9_-]{10,}/` 会把
`task-spec-branch-name-verify`、`risk-management-foo` 这类普通词的**中段** `sk-…` 判成 key，
一次词形误报就把整机同步 fail-closed 锁死一整天。现行规则 =
`(^|[^A-Za-z0-9_-])sk-` 词边界 + 真实前缀（`proj-` / `ant-`）放行 + 裸 `sk-` 要求 ≥20 位 base62 且含大写或数字。
**改这条规则必须同时补正反例**（`tests/sync.test.ts` 的 `issue #10` 两条用例）。

命中即**拒推** + `SYNC_PII_BLOCKED` critical alert，报告只含**行号 + 规则名**，绝不回显命中内容。
用户/运维自查走 `pnpm sync:op pii`（同一份 `scanSensitive`，列出 file / 行号 / 规则名，同样不回显内容）。

## 关键设计

1. **GitRunner 可注入**：编排逻辑与真实 git 解耦——默认 `createNodeGitRunner()`（`spawnSync`，超时 120s，失败原因把 ENOENT/信号/退出码拼成可读串）；测试注入脚本化假 runner，另有一条**真实 git 端到端**（本地 bare 仓当远端，覆盖 clone/commit/push/fetch/rebase/copy 全序列）。
2. **串行闸门用文件锁而非内存互斥**：插件每进程一实例，同一实例里两次快速写盘也会并发 `void sync.push()`——进程内与跨进程都得挡。
3. **身份兜底**：commit 前探 `git config user.email`，没有就用 `-c user.name=memx-sync -c user.email=memx@localhost` 现造（prod 没配过 git 身份）；有真身份不覆盖。**rebase（pull 路径 + push 被拒后的重试路径）无条件带同一身份**——否则无身份环境下重放提交缺 committer 会直接失败，被误判成内容冲突（`SYNC_CONFLICT` 误报，见 issue #7）。
4. **报警去重**：同 code+message 与上一条完全相同的记录跳过（离线机器定时拉每 30 分钟失败一次，不去重会刷满 200 条账本）。
5. **远端地址**（`remoteUrl`）：`owner/name` → `git@github.com:<owner>/<name>.git`；写成完整 URL / 绝对路径（`git@…` / `ssh://` / `https://` / `file:` / `/path`）则原样使用——后者供本机自测。
6. **删除传播宁可少删，不可误删**（issue #21）：push 只删"基线里有 + 本地没有"；pull 只删"git 明确记录远端已删"；两者都过 `isSyncRepoPath` 白名单（`.trash/`、点开头、`.bak.`、范围外一律不动）。基线未知时**一律不传播删除**——这是防止新机器/旧状态误清空远端的关键。

## 手工通道（`pnpm sync:op`）

```
pnpm sync:op status                       只读：config + 待同步清单 + PII + 近况（连 fetch 都不做）
pnpm sync:op pii                          只读：PII 自查明细（file / 行号 / 规则名，绝不回显内容）
pnpm sync:op -- pull  [--machine=prod]    拉取（远端优先，本地差异自动 .bak.<ts>）
pnpm sync:op -- push  [--machine=prod]    推送（PII 命中即拒推）
pnpm sync:op -- both  [--machine=prod]    先拉后推
```

- **与插件同一条代码路径**（`createSync` 的 push/pull + `scanSensitive`），不是第二套实现。
- `pii`（issue #10 DoD ③）= 用户不必读源码的自查入口：闸门只存/只报行号+规则名，此命令用同一份
  `scanSensitive` 把命中明细列成 `file:line  规则名`，**绝不回显命中内容**（不打印那一行文字）。
- `pull` / `both` **强制真实 pull**（`sync.pull({ force: true })`）——人工跑就是要把远端搬下来，不参与"远端无变化则跳过"。
- `--machine=<name>` = 显式覆盖 `{enabled:true, machineName:<name>}`，用于"配置还没开、但要人工跑一次首推/首拉"（prod 首次合并）；**它不改配置文件**，运行中的宿主不受影响。不传则完全按配置（未启用直接拒绝）。
- 存在的理由：`createSync` 对 `enabled=false` 是硬拒绝，而"先开配置再推"会让运行中的宿主开始自动同步——手工通道把这两件事解耦。

## dry-run（`pnpm sync:dry-run [-- --fetch]`）

只读预览：config / 待同步清单 + 双向行数 / PII 命中 / 远端 git log。**永不 push**，退出码恒 0。

加 `--fetch` 会先 clone/fetch 到缓存 workdir（**只动 workdir，不碰 `~/.opencode` 记忆文件**）——首合并预演（新机器第一次拉之前想看清远端有什么）必须用这个模式，否则 workdir 不存在、报告只会写「远端未取到」。

## 已知限制（v1 有意不做）

| 限制 | 说明 |
|------|------|
| 删除传播依赖基线 | 首次 push（从未同步过）与旧状态文件的首次 pull 各有一轮不传播删除（保守 fail-safe）；基线写入后收敛。见「删除传播」 |
| 不做逐行合并 | 同一文件两台机器都改 → 靠 git rebase，冲突即 abort 留人工 |
| pull 不持记忆文件锁 | 与提炼写盘并发时最后写者胜，靠覆盖前 `.bak.` 备份兜底（同步操作彼此之间由 `.memx-sync.lock` 串行） |

## 修改注意事项与红线

1. **`.ts` 扩展名**：`sync.ts` 会被 `scripts/*.ts` 用 `node --experimental-strip-types` 直载——相对 import 必须带 `.ts`，缺了 tsc/vitest 都发现不了（只有 `tests/scripts-smoke.test.ts` 真跑才炸）。
2. **push 必须保持"不 await"**：写盘路径上任何 await sync 都会把 git 网络延迟带进记忆写入。
3. **PII 扫描必须在锁外**：锁窗口只含 git 动作（持锁做全量扫描会拖长临界区）。
4. **`no-change` 必须同时满足"无文件差异 + 无未推提交"**（issue #12）：只看 `git status --porcelain` 会把断网期攒下的提交静默滞留；`rev-list` 取不到数时 fail-open（宁可多 push 一次，不可藏积压）。
5. 新增可自愈的失败码时，在成功分支补 `alerts.resolve(code)`，否则账本永远挂着旧账。
6. 镜像范围改动要同步 `walkMirror` 与测试（`.trash/`、`.bak.` 的排除是有原因的，别顺手放开）。
7. **删除传播的安全边界不许放宽**（issue #21）：`isSyncRepoPath` 的白名单、`listPendingDeletions` 的基线判据、pull 的 `--diff-filter=D` 三者缺一不可；任何"本地没有就删远端 / 远端没有就删本地"的朴素写法都会误删"本地新增未推"的记忆（现场教训：7 条 forget 被 pull 连续复活两天）。
8. 真实 git 端到端测试用本地 bare 仓，**不要**改成联网远端（CI 无凭据）。

## 测试

`tests/sync.test.ts`（假 runner 编排 + 真实 git 端到端 + PII/备份/锁/重试/前置短路 + issue #21 两条删除传播路径）+ `tests/scripts-smoke.test.ts`（CLI 真跑）。每文件独立 tmp home。
