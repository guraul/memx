# modules/injection.md — system prompt 注入

> 最后更新: 2026-10-28 · issue #32（注入改为当前节 + related）

## 职责

把三块内容（协议 / USER.md / MEMORY.md 索引）送进宿主已组装好的 system prompt，并管理 agent 闸门与截断。**两宿主的送法不同**：OpenCode 每 step **追加** SystemPart；DSH 每会话**注册一段** section。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/injection.ts` | 装配纯函数：来源顺序、200 行/25KB 上限、截断提示行、`shouldInjectAgent` 闸门真值表、`describeGate` |
| `src/core/pipeline/injection-source.ts` | 三块来源读取 + `stat(mtimeMs+size)` 缓存（缺失也缓存，mtimeMs=-1）+ `InjectionSourceCache` + `buildMemoryInjection`（**当前节 + related**）/ `readInjectionSourcesForSlug` |
| `src/hosts/opencode/context-hook.ts` | hook 判定与装配（子会话整体替换 vs 其余 append）——机制见 ARCHITECTURE.md §5 |
| `src/hosts/dsh/index.ts` | `ctx.systemPrompt.section({ order: 12000, interpolate: false })`；每会话一次求值 + WeakMap 缓存 |
| `src/core/protocol-template.ts` | 协议文本常量（注入内容之一） |

## 注入内容与顺序

`INJECTION_SOURCE_ORDER`：**协议（memx-protocol.md）→ 画像（USER.md）→ 索引（MEMORY.md）**。每块独立一个 SystemPart（OpenCode）；DSH 把三块 join 成一段 section 文本。

- 上限各 **200 行或 25KB（先到先算，UTF-8 字节安全截断）**；常量 `INJECT_MAX_LINES` / `INJECT_MAX_BYTES` 在 injection.ts，**刻意不做成配置项**（写盘侧已把画像压在 200 行内，这是兜底而非日常旋钮）。
- 截断时追加可见提示行：`[memx: truncated — showing first 200 of 512 lines ...]`——要避免的失败模式是静默截断。
- Track 2 注入的是 **MEMORY.md 索引**，不是 `.mem` 全文（模型按 description 判断是否需要再读文件）。
- **索引范围两宿主统一（#32）**：都注入 **当前节 + related**（`buildMemoryInjection`）。只取当前节会丢跨节记忆（实测 58% 的 hook 在讲别的项目），整份注入又会顶到 200 行上限。
- 三块都缺 → hook 整个什么都不做（`kind: "empty"`）。

## 当前节 + related（#32）

- **当前节**：`## <slug>`（slug = cwd 压平，如 `Users-gubin-workspace-memx`），条目原样、顺序不变。
- **related**：其它节里按「**项目目录末段 + 词边界**」命中的条目。键取 cwd 末段（`/Users/gubin/workspace/memx` → `memx`，不是 slug），大小写不敏感；`INJECTION_KEY_STOPWORDS`（`workspace` / `projects` / `Users` / `gubin` / `root-project` / `root` / `tmp` …）与单字符键一律不找 related。
- 匹配顺序：先 `hook`，不中再读卡片正文兜底（正文走同一个 `InjectionSourceCache`，每 step 只 stat）；hook 已命中就不读正文。
- **上限 10 条**（`RELATED_INJECT_LIMIT`），按索引顺序取，不排序、不看时间/计数/随机 → 同一份索引 + 同一 cwd 渲染字节恒定。
- **按文件名去重**：当前节已有的卡片不再从 related 重复注入；跨节重复登记只收索引顺序在前的那一条。
- 合并文本 = `## <slug>` 段 + `## related: <key>` 段，**整体再过 `capSourceText`**（200 行 / 25KB 仍生效）。
- 退化安全：拿不到键 / 匹配不到 → 只注入当前节；当前节与 related 都空 → `text: null`（一个 part 都不加）。短名会误报（`memx-worktrees` 命中 `memx`）——方向是"多注入一条"，不是"少注入"。

## DSH 侧注入语义（与 OpenCode 的差异）

| 维度 | OpenCode | DSH |
|------|----------|-----|
| 时机 | 每个 model step（context hook） | 每个会话第一次装配（section `text(context)` 求值一次） |
| 文本 | 三块各一个 SystemPart，追加 | 三块 join 成一段，`order: 12000`、`interpolate: false` |
| 稳定性 | 每 step 重算（能看到本会话新写） | 每会话恒定字节（WeakMap by agent） |
| 闸门 | 走 `inject.*` | **不读 `inject.*`**（已知缺口） |

DSH 的恒定字节是**缓存不失效的前提**：注入正文里不许出现时间/计数/随机。代价是本会话新写的记忆下个会话才可见（拍板语义）。

## agent 闸门（仅 OpenCode 生效）

配置 `memx.config.json` 的 `inject.{enabled, includeAgents, excludeAgents}`：

- `enabled=false`：一个字节都不注入（协议 hook 照常工作）。
- 生效集合 = `includeAgents`（`"all"` 或数组）减去 `excludeAgents`（永远压过 include）。
- **仓库里不硬编码任何 agent 名**（memx 必须宿主无关）——该排除谁由消费方填（例如会把 system prompt 原样回显的 agent 会把协议泄给用户）。
- 生效中的闸门显示在诊断 `inject.gate`；配置 30 秒 TTL 后台重读（hook 每 step 同步触发，不能在里面 await），改配置无需重启宿主。

## 性能与缓存

- 文件读走 stat(mtimeMs+size) 缓存；诊断写盘节流 5s。
- 注入追加在尾部 → 落在宿主 `cache:"auto"` 断点（最后一个 distinct system part）之内，**注入不伤缓存**；失效只在 USER.md/MEMORY.md 被改写时发生。
- 诊断计数：`hookFires`（hook 触发总数）vs `injections`（真正追加次数）。`hookFires > 0` 但 `injections == 0` → 先看 `inject.gate` 与 `inject.empty`。

## 依赖关系

- 依赖：`core/protocol-template.ts`、`store/user-md.ts` / `store/memory-md.ts` 的读取函数、`config.ts`（闸门配置）。
- 被依赖：`hosts/opencode/context-hook.ts`（append 三块）、`hosts/dsh/index.ts`（一段 section）、`core/pipeline/injection-source.ts`（来源读取）。

## 修改注意事项与红线

1. **非子会话分支只 append 绝不替换**——hook 触发时 `event.system` 已含 agent.system + AGENTS.md 合并正文。
2. **子会话分支先判**（整体替换 + temperature 0.2，注入绝不参与），顺序不能换。
3. hook 内不 await、任何异常退化为"不注入"，绝不半途写坏 `event.system`。
4. 上限常量不是配置项——真出现需要调的负载再暴露成配置（改动需同步 README 注入上限一节）。
5. **DSH 的 section 文本必须字节恒定**：别加时间戳、计数、"最后更新"；也别改成每轮重算（缓存全失效）。
6. 注入范围是「当前节 + related」，**不要退回整份 MEMORY.md**（顶距/噪声）也**不要退回单节**（丢跨节记忆）。related 的选条必须保持纯确定性：不许加时间、计数、随机或 `sort`。

## 测试

`tests/injection.test.ts`（顺序/上限/截断提示/闸门真值表）/ `injection-source.test.ts`（stat 缓存 + 三块读取）/ `injection-related.test.ts`（related 命中、停用词、同名去重、确定性、正文兜底、cap 联动）/ `context-hook.test.ts`（OpenCode 两分支互斥与退化）/ `hosts-dsh.test.ts`、`hosts-opencode-inject.test.ts`（两宿主接线 + 字节恒定）。
