# modules/sync.md — 多机云同步

> 最后更新: 2026-10-15 · commit `0685bed`

## 职责

把本机记忆（USER.md / MEMORY.md / `.mem/**/*.md`）镜像到一个 Git 仓，实现多机共享与备份。**默认关**，开启后自动拉取（启动 + 定时）与自动推送（写盘成功后），并带 PII 脱敏闸门。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/sync.ts`（651 行） | 全部编排：`GitRunner` / `scanSensitive` / `listToSync` / 状态读写 / `buildDryRunReport` / `createSync` |
| `src/core/config.ts` | `MemxSyncConfigSchema`（enabled / repo / branch / machineName / intervalMinutes） |
| `src/hosts/opencode/index.ts` | 接线：setup 建 sync、启动拉一次、定时拉、两个 push 触发点 |
| `scripts/sync-op.ts` | 手工通道（status / pull / push / both，`--machine=<name>` 覆盖） |
| `scripts/sync-dry-run.ts` | 只读预览（`-- --fetch` 先取远端） |
| `scripts/doctor.ts` | 面板 sync 段（config / pendingFiles / status / pii） |

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

两个 push 都是 `void` 异步——**绝不阻塞写盘**。

## push 流程

```
1. scanSensitive(全部待推文件)        ← 锁外做
   命中 → 拒推 + SYNC_PII_BLOCKED critical（只报行号+规则名，绝不回显内容）
2. withFileLock(~/.opencode/.memx-sync.lock, ttl 10min / 等锁 5min)
     fetch → copy 到 workdir → commit → push
     push 被拒（非快进）→ fetch + rebase + 重试一次
     再失败 → SYNC_PUSH_FAILED warn
3. 写 memx-sync-state.json；成功路径 resolve("SYNC_ERROR") / resolve("SYNC_PUSH_FAILED")
```

## pull 流程

```
锁内 ensureRepo
  → 前置短路（仅当 pullOpts.force≠true + 有 lastRemoteSha + consecutiveFailures=0 + lastError=""）
       git ls-remote origin refs/heads/<branch> → sha 与 lastRemoteSha 相同
         → 只刷 lastPullAt（不销账、不动 lastError/consecutiveFailures）→ kind="no-change" 收工
         ⚠️ ls-remote 失败 / 远端变了 / 解析不出 → fail-open，继续下面的完整流程
  → fetch → 逐文件比对（远端优先）
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

## 状态与锁

| 路径 | 内容 |
|------|------|
| `~/.opencode/memx-sync-repo/` | Git workdir（不存在则 clone，存在则 fetch） |
| `~/.opencode/memx-sync-state.json` | `lastPushAt` / `lastPullAt` / `consecutiveFailures` / `lastError` / `lastPiiScan{hits,files,at}` / `lastRemoteSha`（上次成功 pull 的远端 sha；**旧文件无此字段 = null = 未知 → 走真实 pull**） |
| `~/.opencode/.memx-sync.lock` | 串行闸门（`withFileLock`，ttl 10 分钟 / 等锁上限 5 分钟） |

## PII 脱敏闸门（`scanSensitive`）

8 类规则：`openai-key` / `aws-access-key` / `github-token` / `github-pat` / `slack-token` / `jwt` / `private-key` / `env-assignment`。

命中即**拒推** + `SYNC_PII_BLOCKED` critical alert，报告只含**行号 + 规则名**，绝不回显命中内容。

## 关键设计

1. **GitRunner 可注入**：编排逻辑与真实 git 解耦——默认 `createNodeGitRunner()`（`spawnSync`，超时 120s，失败原因把 ENOENT/信号/退出码拼成可读串）；测试注入脚本化假 runner，另有一条**真实 git 端到端**（本地 bare 仓当远端，覆盖 clone/commit/push/fetch/rebase/copy 全序列）。
2. **串行闸门用文件锁而非内存互斥**：插件每进程一实例，同一实例里两次快速写盘也会并发 `void sync.push()`——进程内与跨进程都得挡。
3. **身份兜底**：commit 前探 `git config user.email`，没有就用 `-c user.name=memx-sync -c user.email=memx@localhost` 现造（prod 没配过 git 身份）；有真身份不覆盖。
4. **报警去重**：同 code+message 与上一条完全相同的记录跳过（离线机器定时拉每 30 分钟失败一次，不去重会刷满 200 条账本）。
5. **远端地址**（`remoteUrl`）：`owner/name` → `git@github.com:<owner>/<name>.git`；写成完整 URL / 绝对路径（`git@…` / `ssh://` / `https://` / `file:` / `/path`）则原样使用——后者供本机自测。

## 手工通道（`pnpm sync:op`）

```
pnpm sync:op status                       只读：config + 待同步清单 + PII + 近况（连 fetch 都不做）
pnpm sync:op -- pull  [--machine=prod]    拉取（远端优先，本地差异自动 .bak.<ts>）
pnpm sync:op -- push  [--machine=prod]    推送（PII 命中即拒推）
pnpm sync:op -- both  [--machine=prod]    先拉后推
```

- **与插件同一条代码路径**（`createSync` 的 push/pull），不是第二套实现。
- `pull` / `both` **强制真实 pull**（`sync.pull({ force: true })`）——人工跑就是要把远端搬下来，不参与"远端无变化则跳过"。
- `--machine=<name>` = 显式覆盖 `{enabled:true, machineName:<name>}`，用于"配置还没开、但要人工跑一次首推/首拉"（prod 首次合并）；**它不改配置文件**，运行中的宿主不受影响。不传则完全按配置（未启用直接拒绝）。
- 存在的理由：`createSync` 对 `enabled=false` 是硬拒绝，而"先开配置再推"会让运行中的宿主开始自动同步——手工通道把这两件事解耦。

## dry-run（`pnpm sync:dry-run [-- --fetch]`）

只读预览：config / 待同步清单 + 双向行数 / PII 命中 / 远端 git log。**永不 push**，退出码恒 0。

加 `--fetch` 会先 clone/fetch 到缓存 workdir（**只动 workdir，不碰 `~/.opencode` 记忆文件**）——首合并预演（新机器第一次拉之前想看清远端有什么）必须用这个模式，否则 workdir 不存在、报告只会写「远端未取到」。

## 已知限制（v1 有意不做）

| 限制 | 说明 |
|------|------|
| 删除不传播 | 本地删掉的文件会留在仓里；远端删掉的会在下次 pull 时被本地版本推回 |
| 不做逐行合并 | 同一文件两台机器都改 → 靠 git rebase，冲突即 abort 留人工 |
| pull 不持记忆文件锁 | 与提炼写盘并发时最后写者胜，靠覆盖前 `.bak.` 备份兜底（同步操作彼此之间由 `.memx-sync.lock` 串行） |

## 修改注意事项与红线

1. **`.ts` 扩展名**：`sync.ts` 会被 `scripts/*.ts` 用 `node --experimental-strip-types` 直载——相对 import 必须带 `.ts`，缺了 tsc/vitest 都发现不了（只有 `tests/scripts-smoke.test.ts` 真跑才炸）。
2. **push 必须保持"不 await"**：写盘路径上任何 await sync 都会把 git 网络延迟带进记忆写入。
3. **PII 扫描必须在锁外**：锁窗口只含 git 动作（持锁做全量扫描会拖长临界区）。
4. 新增可自愈的失败码时，在成功分支补 `alerts.resolve(code)`，否则账本永远挂着旧账。
5. 镜像范围改动要同步 `walkMirror` 与测试（`.trash/`、`.bak.` 的排除是有原因的，别顺手放开）。
6. 真实 git 端到端测试用本地 bare 仓，**不要**改成联网远端（CI 无凭据）。

## 测试

`tests/sync.test.ts`（假 runner 编排 + 真实 git 端到端 + PII/备份/锁/重试/前置短路）+ `tests/scripts-smoke.test.ts`（CLI 真跑）。每文件独立 tmp home。
