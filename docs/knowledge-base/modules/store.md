# modules/store.md — 写盘层（USER.md / MEMORY.md / .mem）

> 最后更新: 2026-10-15 · commit `77ccc97`

## 职责

提案数组 → 本机 Markdown 落盘。两条轨道各一套文件族，共享空行边界工具与文件锁。**格式契约与保留语义是本模块的第一生命线**（曾因破坏保留语义导致插件第二轮起静默失效，见 §红线 1）。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/store/user-md.ts` | USER.md：parse / serialize / `applyProposals`（单遍）/ 内容锚点 / **去重自愈（`normalizeAnchor` + `dedupeUserMd`）** / 备份轮转 / `isOverLimit` |
| `src/core/store/memory-md.ts` | MEMORY.md 索引 + `.mem/*.md` 写卡 + `.trash/` 软删 + `forgetMemory` / `applyMemoryProposals` |
| `src/core/store/markdown-lines.ts` | 两序列化器共用的空行边界工具（保 parse↔serialize 幂等） |
| `src/core/store/lock.ts` | `withFileLock`（wx 独占创建 + mtime TTL 30s + 等锁超时 5s 抛 `FileLockTimeoutError`） |
| `src/core/memory-write.ts` | `memory_write` 工具的 core 写路（与提炼同一条 `applyMemoryProposals` + 同一把锁）+ **`applyBreadcrumbLine`（MEMORY.md 面包屑的共享实现，两条写路共用）** |

## 文件族与路径（硬编码，全部在 `~/.opencode/`，共 11 处——见 CONVENTIONS.md 红线）

```
~/.opencode/
├── USER.md                          # Track 1 全局画像（四固定分类）
├── USER.md.bak.<ts>                 # 备份轮转，留 5 版
├── MEMORY.md                        # Track 2 索引（按 ## <slug> 分节）
├── MEMORY.md.bak.<ts>
├── projects/<slug>/.mem/*.md        # 记忆卡片（frontmatter: name/description/type）
├── projects/<slug>/.mem/.trash/<file>.<ts>   # 软删，可人工找回
├── memx-protocol.md                 # 协议（产物；真源 protocol-template.ts）
├── memx.config.json                 # 配置
├── .USER.md.lock / .MEMORY.md.lock  # 锁文件（正常路径不长期存在）
```

格式示例与 slug 规则详见 [DATA.md](../DATA.md)。

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

- 每次写前备份 `*.bak.<timestamp>`，留 5 版（按文件名排序取最新；⚠️ `autoBackupCount` 配置项暂无消费方，5 是硬编码）。
- 写盘走 tmp 文件 + rename 原子替换（`*.tmp.<ts>` 不留残骸）。

## 健康检查（与写盘同锁）

Track 2 写盘的同一把锁内跑 `runHealthMaintenance()`：死链（索引指向不存在文件）删指针、孤儿（`.mem/*.md` 不在索引）补指针，单轮 auto-fix 上限 3；索引 ≥200 条 escalate 人工。返回 `{index, logs, report}`，**logs 只落 `diag.health`，绝不追加进 MEMORY.md**（P0-5：HTML 注释会被下一次序列化吃掉，历史 bug）。

## 修改注意事项与红线

1. **写盘必须保留非受管内容**：parse 只投影受管集合（分类小节 + `- [日期]` 条目），其余（协议块、用户自写标题、散文、未知 `##` 小节）由 `preamble` / `section.extras` 原样带回。曾经直接丢弃，首次成功提炼就把 USER.md 的协议块冲掉 → AI 不再发信号 → memx 第二轮起静默失效。
2. **锁绝不包 LLM**；改锁参数（TTL/timeout）先读 `lock.ts` 头注释。
3. 记忆文件同名同类型 = 修订（update）；**纯中文名走确定性哈希文件名**（否则每次写都新建文件，更新语义失效）。
4. text >500 字的 memory_write 直接拒绝不截断。
5. deprecate/forget 是软删（挪 `.trash/`），不物理删除。
6. `exactOptionalPropertyTypes`：`target_line?: number` 不能显式赋 `undefined`，用 `!= null` 判断。

## 测试

`tests/user-md.test.ts` / `memory-md.test.ts` / `lock.test.ts` / `memory-write.test.ts` / `markdown-lines.test.ts`——覆盖保留语义、单遍应用、锚点四级降级、锁竞争。测试 mock homedir 到独立 tmp home，**绝不碰真实 `~/.opencode`**。
