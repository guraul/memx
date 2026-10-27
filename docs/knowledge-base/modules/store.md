# modules/store.md — 写盘层（USER.md / MEMORY.md / .mem）

> 最后更新: 2026-10-25 · commit `c232168`

## 职责

提案数组 → 本机 Markdown 落盘。两条轨道各一套文件族，共享空行边界工具与文件锁。**格式契约与保留语义是本模块的第一生命线**（曾因破坏保留语义导致插件第二轮起静默失效，见 §红线 1）。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/store/user-md.ts` | USER.md：parse / serialize / `applyProposals`（单遍）/ 内容锚点 / **去重自愈（`normalizeAnchor` + `dedupeUserMd`）** / 备份轮转 / `isOverLimit` |
| `src/core/store/memory-md.ts` | MEMORY.md 索引 + `.mem/*.md` 写卡 + `.trash/` 软删 + `forgetMemory` / `applyMemoryProposals` |
| `src/core/store/memory-search.ts` | 全文检索（`searchMemories(keyword, slug?)`）：索引 slug ∪ 磁盘 slug（兜孤儿）、大小写不敏感、返回 `file:line`；**只读、不加锁** |
| `src/core/store/markdown-lines.ts` | 两序列化器共用的空行边界工具（保 parse↔serialize 幂等） |
| `src/core/store/lock.ts` | `withFileLock`（wx 独占创建 + mtime TTL 30s + 等锁超时 5s 抛 `FileLockTimeoutError`） |
| `src/core/memory-write.ts` | `memory_write` 工具的 core 写路（与提炼同一条 `applyMemoryProposals` + 同一把锁）+ **`applyBreadcrumbLine`（MEMORY.md 面包屑的共享实现，两条写路共用）** |

## 文件族与路径（硬编码，全部在 `~/.opencode/`；core 里 **18 处** `join(homedir(), ".opencode", …)`，未参数化）

```
~/.opencode/
├── USER.md                          # Track 1 全局画像（四固定分类）
├── USER.md.bak.<ts>                 # 备份轮转，留 5 版
├── MEMORY.md                        # Track 2 索引（按 ## <slug> 分节）
├── MEMORY.md.bak.<ts>
├── projects/<slug>/.mem/*.md        # 记忆卡片（frontmatter: name/description/type/created/updated）
├── projects/<slug>/.mem/.trash/<file>.<ts>   # 软删，可人工找回
├── memx-protocol.md                 # 协议（产物；真源 protocol-template.ts）
├── memx.config.json                 # 配置
├── .USER.md.lock / .MEMORY.md.lock  # 锁文件（正常路径不长期存在）
```

格式示例与 slug 规则详见 [DATA.md](../DATA.md)。

**空节头归位（#36 存量兼容）**：`parseMemoryIndex` 把 `## ` / `##`（slug 为空的节头，空 slug 时代的产物）**认领到 `root` 节**，而不是当非受管行降级成 `extras`——降级会把其下的指针挂到"上一个无关项目节"，让本该读不到的记忆被错误注入别的项目。同一 slug 的第二个节头**合并进已有小节**（否则序列化出两个 `## root`，注入只读第一个）。`projects/.mem/` 遗留目录与索引里的重复指针只在 `doctor` 里**提示**，不自动搬迁/清洗。

## 单遍应用 + 内容锚点（P0-3）

`applyProposals(doc, proposals)`：**parse 一次 → 内存里应用整批 → serialize 一次**。旧实现逐条全文件重写，同批前面的改动让后面行号漂移 → 改错行/丢改动。

update/deprecate 定位顺序（逐步降级，每次降级/未命中都写 `diag.lastWarnings`，**绝不静默改错条目**）：

1. `target_text` 精确匹配
2. 归一化匹配（去空白/markdown 装饰）
3. 唯一包含匹配
4. `target_line` 行号兜底

## Track 1 去重自愈（阶段 4）

USER.md 是"慢变量画像"，同一条偏好被反复 append 会让它膨胀。两道闸：

1. **append 守卫**：`append` 前用 `normalizeAnchor(text)` 归一（去空白 / 去 markdown 装饰）后查**全 doc** 有无同文 active 条目 → 有则不再追加（去重与锚点定位**共用同一套归一**，同批顺序应用 → 批内重复自动被挡）。
2. **落盘自愈 `dedupeUserMd(doc)`**：两遍扫描——
   - 删掉与**同小节有效条目同文**的 deprecated 行（旧条目已被取代，留着只是噪声）；
   - 合并归一后同文的 active（留**位置最早**那条，`date` 取组内最新并重写 `raw`）；
   - 命中写入 `diag.lastWarnings`（前缀 `自愈：…`），不静默。
3. `deprecate` 分支不改语义；自愈在**同一次写盘**里收口（不额外多写一次盘）。

> 设计意图：LLM 偶尔会重复提炼同一条偏好；靠 prompt 约束不可靠，所以在写盘层做确定性兜底，并把"做了什么"记进诊断。

## 锁（P0-4）

- `withFileLock(path, fn)`：**只包 read-modify-write**；锁内**重读文件**再应用（消掉"快照读→写盘"窗口的丢更新）。
- **LLM 调用绝不进锁**——持锁几十秒会把别的实例全卡死。
- 持锁者崩溃靠 mtime TTL 30s 夺锁；等锁超 5s → 上层落 `diag.lastError`、缓冲保留、下轮重试。
- 锁文件：`~/.opencode/.USER.md.lock` / `.MEMORY.md.lock`。

## 备份与原子写

- 每次写前备份 `*.bak.<timestamp>`，留 5 版（按文件名排序取最新；⚠️ `autoBackupCount` 配置项暂无消费方，5 是硬编码）。备份只覆盖 `USER.md` / `MEMORY.md` 索引；记忆卡的"旧版本"落在 `.mem/.trash/`。
- `MEMORY.md` 索引：tmp 写完整 → rename 到位（`*.tmp.<ts>` 不留残骸）。
- **记忆卡：三件套顺序写**（`writeMemoryFile`）——① tmp 写完整 → ② 旧卡 rename 进 `.trash/<file>.<ts>` → ③ tmp rename 到位。任一崩溃点都至少留一份完整卡片；写失败清 tmp 并原样抛出。tmp 名不以 `.md` 结尾，所以 sync / `memory_search` / 健康检查（都按 `endsWith(".md")` 收文件）天然排除它。
- **frontmatter 的 `created` / `updated` 由写盘层生成**（UTC 日期 `YYYY-MM-DD`，不进 `MemoryProposalSchema`）：新增取当天；更新时在移走旧卡**之前**读旧 frontmatter，`created` 原样保留、`updated` 刷新；老卡缺 `created` 就保持缺失（不拿 mtime 伪造，doctor 显示「未知龄期」）。`deprecate` 不做写卡，只把原卡按字节原样移入 `.trash/`。
- **`.trash` 的统计口径**（#30）：`doctor` 的 `trashCount()` 只数 `projects/<slug>/.mem/.trash/` 下的**普通文件**（含空 slug 遗留的 `projects/.mem/`，子目录不计），只展示不报警、不清洗——它是软删可恢复的历史，不是故障信号；数字变小通常意味着有人手工清过。

## 健康检查（与写盘同锁）

Track 2 写盘的同一把锁内跑 `runHealthMaintenance()`：死链（索引指向不存在文件）删指针、孤儿（`.mem/*.md` 不在索引）补指针，单轮 auto-fix 上限 3；索引 ≥200 条 escalate 人工。返回 `{index, logs, report}`，**logs 只落 `diag.health`，绝不追加进 MEMORY.md**（P0-5：HTML 注释会被下一次序列化吃掉，历史 bug）。

## 检索（只读，DSH `memory_search` 用）

`searchMemories(keyword, slug?)`：关键词 trim + 小写；空串返回 `[]`（不把"空串匹配一切"当命中）。slug 集合 = 索引里的 slug **∪** 磁盘上有 `.mem/` 的 slug（后者兜"文件在盘但索引没登记"的孤儿）。逐文件按行匹配、行号从 1 起、命中行 trim。**不写盘、不加锁**——最多看到写者锁内的"上一个版本"。

## 依赖关系

- 依赖：`core/types.ts` / `core/memory-types.ts`、`markdown-lines.ts`、`lock.ts`。
- 被依赖：`pipeline/session.ts`（写盘）、`memory-write.ts`、`health/memory-health.ts`、`store/memory-search.ts`、两个宿主壳、`scripts/*`。

## 修改注意事项与红线

1. **写盘必须保留非受管内容**：parse 只投影受管集合（分类小节 + `- [日期]` 条目），其余（协议块、用户自写标题、散文、未知 `##` 小节）由 `preamble` / `section.extras` 原样带回。曾经直接丢弃，首次成功提炼就把 USER.md 的协议块冲掉 → AI 不再发信号 → memx 第二轮起静默失效。
2. **锁绝不包 LLM**；改锁参数（TTL/timeout）先读 `lock.ts` 头注释。
3. 记忆文件同名同类型 = 修订（update）；**纯中文名走确定性哈希文件名**（否则每次写都新建文件，更新语义失效）。
4. text >500 字的 memory_write 直接拒绝不截断。
5. deprecate/forget 是软删（挪 `.trash/`），不物理删除。
6. `exactOptionalPropertyTypes`：`target_line?: number` 不能显式赋 `undefined`，用 `!= null` 判断。
7. **记忆卡三件套顺序不可交换**：tmp 写完整 → 旧卡进 `.trash` → rename 到位。换序（先移旧卡再写、或直接覆盖）会在崩溃窗口丢旧卡或留半个新卡；也不要把 tmp 命名成 `*.md`，否则会被 sync / 检索 / 健康检查当成正式卡片收走。

## 测试

`tests/user-md.test.ts` / `user-md-anchors.test.ts` / `user-md-dedupe.test.ts` / `memory-md.test.ts` / `memory-search.test.ts` / `lock.test.ts` / `memory-write.test.ts`——覆盖保留语义、单遍应用、锚点四级降级、去重自愈、检索、锁竞争。测试 mock homedir 到独立 tmp home（路径带 `process.pid`，并发跑安全），**绝不碰真实 `~/.opencode`**。

## `created` 的来源与回填（#34）

`created` 由写卡层在**新建**时生成（`YYYY-MM-DD`），`update` 时原样保留；老卡缺失就显示「未知」，**不用 mtime 兜底**（update 会重置 mtime、sync pull 的 copyFileSync 也会重置）。

一次性回填：`pnpm run backfill:created --dry-run` 先看「将回填 N / 已有 M / 保留未知 K / 跳过 S（无 frontmatter X，写失败 Y，空 slug 遗留 Z）」，确认后改跑 `pnpm run backfill:created --push` 真跑并推送。数据源是 `~/.opencode/memx-sync-repo` 的 git 首次新增时间，另有四条硬规则（#34 / #34 follow-up / #34 收尾）：

- **引导提交不算创建**：`git rev-list --max-parents=0 HEAD` 的根提交 = 镜像首次导入（2026-10-13）。随导入进仓的卡，其「首次新增」就是该根提交 → 判 `unknown`，**不写导入日**（否则几十张卡盖同一根假柱子，龄期分布失真）。dry-run 把这部分单列：`保留未知 K 中 X 张随镜像首导（引导提交 N 个）进仓，创建时间不可知`。
- **`projects/.mem/` 空 slug 遗留卡**（如 `project_e2e_e4_memory.md`）也会被扫到并计数，但 slug `""` 是「宿主取不到 cwd」的哨兵（`deriveSlug` 语义），不是合法项目 → 记 `skippedLegacy`，**不写盘**，由人工归入某个项目或 `projects/root/.mem/`。
- **没有 frontmatter 的卡一律跳过、一个字节都不动**（2026-10-27 生产实测：`project_homebase_revoke_assignment.md` 首字符 `#`、全文无 `---`、CRLF，`patchCreatedDate()` 返回 false 却被算进 filled，报 61 实际 60）。`created` 只能插进 frontmatter 块，硬补等于重写整篇格式（连带 CRLF 归一）→ 记 `skippedNoFrontmatter`，明细里打印原因，交人工加 frontmatter。**只有 `patchCreatedDate()` 真返回 true 才计入 `filled`**，其余写失败记 `skippedWriteFailed`。
- **回填后必须 push，否则下一次 pull 会覆盖本地 `created`（硬规则）**：脚本直接写盘，**不经过 `memory_write`**，所以不会触发自动推送；此时本地有 `created`、镜像 `memx-sync-repo` 里没有，而 **sync pull 是「远端优先」，会按镜像覆写本地**——2026-10-27 生产实测就是这样把 62 张卡的 `created` 全抹掉的。所以：
  - 真跑一律加 `--push`（`BackfillOptions.push`）：写完且有实际写入时走**与 `pnpm sync:op -- push` 完全相同**的路径 —— `loadMemxConfig()` 取 `machineName` / `repo` → `createSync().push()`；成功打印 `kind` / `message` / 未推提交数。
  - 不传 `--push` 而确有写入 → 打印多行 ⚠️ 警告（说明"不推送会被下一次 sync pull 覆盖"）。
  - 推送失败（抛错 / `ok=false`）→ 明确打 **「写入已完成但推送失败」+ 手动 `pnpm sync:op -- push --machine=<name>` 指引 + 后果说明**，CLI 退出码 1。**不得把"推送失败"伪装成"整体失败"**，也不得静默——写入已经落盘，用户必须知道补推。
  - `filled = 0`（无可回填）或 `--dry-run` 不推、不警告。
  - sync 未启用（`enabled=false` / `machineName` 空）不算故障：给配置指引、退出码 0（本机没有定时 pull，不会被覆盖）。
  - 推送实现可注入（`BackfillOptions.pusher`），测试用假 pusher，**绝不真 push**。

首推（2026-10-14）之前就存在、又查不到首次提交的卡同样保持「未知」，**不猜**。实现走 `patchCreatedDate()`（只插一行、原子写、与写盘共用一把锁）。
