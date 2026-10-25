# modules/alerts.md — 报警账本

> 最后更新: 2026-10-25 · commit `c232168`

## 职责

全插件报警的**单一事实源**：把散落在提炼、捕获、健康检查、同步各处的异常收敛成一个可查、可销账、可清理的账本文件，并向读侧（MEMORY.md 面包屑 / doctor 面板 / `memx_status` / DSH 写盘）供数。**两宿主共用同一份账本**。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/alerts.ts` | `createFileAlertStore`（账本读写）+ `formatBreadcrumb` / `formatAlertsPanel`（两个纯格式化器） |
| `src/core/health/memory-stats.ts` | 只读统计（顶距 / 龄期 / `.trash`）+ `headroomAlert()` 判定（#30） |
| `src/core/pipeline/session.ts` | 流水线内的 `recordAlert` 调用（三态连击 `REFINEMENT_FAILURE_STREAK`、健康 `HEALTH_ESCALATED`） |
| `src/hosts/opencode/index.ts` | `recordAlert()`（写账本 + kv 镜像）、`applyAlertBreadcrumb()`（写 MEMORY.md 前套面包屑）、`CAPTURE_CURSOR_LOST` |
| `src/hosts/dsh/index.ts` | `createFileAlertStore()` + `recordAlert`（只写账本，无 kv 镜像）+ 面包屑 |
| `scripts/alerts.ts` | 手工清理 CLI（`pnpm alerts:clear [--code=X] [--dry-run]`） |
| `scripts/doctor.ts` | 面板第一段（`formatAlertsPanel`） |

## 数据契约

- **文件**：`~/.opencode/memx-alerts.json`（JSON 数组，`JSON.stringify(events, null, 2)`）
- **条目**：`{ level: "info"|"warn"|"critical", code, message, ts, context? }`
- **封顶**：200 条（超出丢最旧）；**剪龄**：7 天（`maxAgeDays`，load 时按 `ts` 过滤，有变化才写盘）
- **容错**：坏 JSON → 从空开始；目录不存在 → 自动 `mkdir -p`；任何 IO 失败**吞掉不抛**（插件不能崩）；`ts` 不可解析的事件**保留**（宁可多留，不可误删）

## API（`AlertStore`）

| 方法 | 语义 |
|------|------|
| `append(event)` | 追加 + 截断到 max + 立即持久化 |
| `list()` | 返回副本（调用方改不动内部数组） |
| `counts()` | `{info, warn, critical}` 计数 |
| `clear()` | 清空全部并持久化 |
| `resolve(code)` | **删掉该 code 的全部事件**并持久化，返回删除条数（瞬时故障恢复后销账用） |

## 读侧

| 读侧 | 实现 | 说明 |
|------|------|------|
| MEMORY.md 首行面包屑 | `formatBreadcrumb(store)` | 仅 warn/critical 时返回 `<!-- memx: ⚠️ N warn / M critical — run \`pnpm run doctor\` -->`；无问题时返回空串。两宿主写索引时都会套 |
| doctor 面板 | `formatAlertsPanel(store)` | counts 一行 + 最近 10 条（`ts code message`）；**仅 OpenCode**（DSH 无 doctor） |
| `memx_status` 的 alerts 段 | 读 store | **以 store 为准**，不是 kv 的 `diag.alerts` 镜像；**仅 OpenCode** |
| DSH 侧 | 无面板 | 账本仍写同一份文件，只能直接读 JSON 或看面包屑 |

## 面包屑的写入方式（`applyBreadcrumbLine`）

共享实现是 `src/core/memory-write.ts` 的 **`applyBreadcrumbLine(content, breadcrumb)`**（纯字符串变换）；宿主侧 `index.ts` 的 `applyAlertBreadcrumb()` 只是 `applyBreadcrumbLine(content, formatBreadcrumb(alertStore))` 的薄包装——**面包屑字符串由 host 算好传入**，core 不反向依赖宿主持有的 store 实例。

写 MEMORY.md 前调用，纯文本处理：

1. 跳过文件头空行，若第一行以 `<!-- memx:` 开头 → **删掉旧行**（自替换）；
2. `breadcrumb` 非空 → `unshift` 新面包屑 + 一个空行；
3. 空串则只清旧行（不写新行）。

两条写路都会刷新：提炼写索引（index.ts）与 `memory_write` 工具写盘（`writeProjectMemory(slug, input, breadcrumb?)` 的第三个参数）。

要点：面包屑**只有这一行**，不含健康日志、不含报警列表；它落在 preamble（非受管内容区），因此不违反"写盘保留非受管内容"契约，也不与 P0-5（健康日志不进 MEMORY.md）冲突——P0-5 反对的是会被序列化吃掉的**日志流**。

## 报警码清单（`code` 约定）

| code | 来源 | 级别 |
|------|------|------|
| `CAPTURE_CURSOR_LOST` | 捕获游标锚点丢失（预期降级，仅 OpenCode） | warn |
| `REFINEMENT_FAILURE_STREAK` | 某轨连续 3 次坏输出后丢弃缓冲（`core/pipeline/session.ts`，两宿主共用） | critical |
| `HEALTH_ESCALATED` | 健康检查升级人工（`MEMORY.md 有 N 项需要人工处理`） | warn |
| `SYNC_ERROR` / `SYNC_PUSH_FAILED` | 同步失败（成功路径 `resolve` 销账） | warn |
| `SYNC_CONFLICT` | pull rebase 冲突，留人工 | critical |
| `SYNC_PII_BLOCKED` | PII 扫描命中，拒推 | critical |
| `HEADROOM_LOW` | `MEMORY.md` 注入顶距 <20%（`core/health/memory-stats.ts` 的 `headroomAlert`，由 `doctor` 每次运行时检查） | critical |

## 顶距预警 `HEADROOM_LOW`（#30）

- **阈值**：注入单块上限 25KB（`INJECT_MAX_BYTES`）的**剩余**不足 20%（即已用 >80%，约 20KB）。判定用未取整的百分比，恰好 20% **不报**（阈值语义是"低于"）。
- **为什么是 20%**：20% × 25KB = 5KB ≈ 18 条（283B/条），够跑一轮清理/改造而不至于下一秒就撞顶；再高会变成噪声，再低就只剩一两轮余量。
- **message 里不放测得的数字**：数字每条记忆都会变，而账本按 `code + message` 去重（见下），带数字会让同一事实反复刷屏。具体百分比看 `pnpm run doctor` 面板。
- **去重语义**：与 `core/sync.ts` 的 `alert()` 一致——只比较**最后一条**，同 `code + message` 就跳过。所以"顶距一直低"只会留一条；中间插入了别的报警才会再记一条（这是既有语义，不是本码特例）。
- **销账**：`pnpm alerts:clear --code=HEADROOM_LOW`（清理/改造后顶距回到 20% 以上，再跑 doctor 也不会重新写）。
- **只展示不报警**的两项：卡片龄期分布、`.trash` 文件计数——前者是信息，后者是可恢复历史，都不是故障。

## 依赖关系

- 依赖：无内部依赖（core 叶子，只碰 fs）。
- 被依赖：`core/pipeline/session.ts`（经 `PipelineHost.recordAlert`）、两个宿主壳、`scripts/doctor.ts` / `scripts/alerts.ts`；`core/memory-write.ts` 只接收格式化好的面包屑字符串，不 import 本模块。

## 修改注意事项与红线

1. **账本是唯一事实源**：新增报警走 `recordAlert`（宿主壳 / `PipelineHost` 实现）或 `AlertStore.append`（core/CLI），不要再往 `diag.alerts` 直接写业务码（那是只写镜像，且只有 OpenCode 有 kv）。
2. **`resolve` 是唯一销账手段**：瞬时故障（网络、锁竞争）恢复后必须销账，否则面包屑永远挂着旧账；新增可自愈的报警码时，记得在成功分支补 `resolve`。
3. **剪龄逻辑在 `load()` 里**（构造时执行一次）——账本文件被外部改小/改坏都在这一步兜住；不要在 `append` 里加剪龄（每次写盘全量过滤是浪费）。
4. 面板/面包屑文案改动会同时影响 doctor 输出与用户可见的 MEMORY.md 首行——改前想清楚（面包屑是**注入给模型看的**）。
5. `context` 字段目前只存不读（留给以后扩展），别假设 doctor 会展示它。

## 测试

`tests/alerts.test.ts`——覆盖封顶、剪龄、坏 JSON 容错、`resolve` 计数、面包屑/面板格式化、自替换行为。每文件独立 tmp home。
