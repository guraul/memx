# CONVENTIONS.md — 约定、陷阱与修改红线

> 最后更新: 2026-10-15 · commit `fe26fa1`
> 本文件承接旧版 AGENTS.md 的全部 Quirks（§1-§3），红线独立成 §4。**都是实机打出来的，不要凭生成的 .d.ts 想当然。**

## 1. 宿主契约陷阱（OpenCode v2.0.26 实测）

| # | 陷阱 | 后果 / 对策 |
|---|------|-------------|
| 1 | **`session.idle` 在 v2 回合结束后根本不发**（v1 时代才有） | 触发器已改用 `session.execution.succeeded`（负载取 `event.data.sessionID`）。手工验证走 `reflect`（force=true） |
| 2 | **`ctx.session.context({sessionID})` 返回消息数组本身**，不是 `{messages}` 信封（SDK `.then(v => v.data)` 已拆包） | 按信封解包 → 恒 `[]` → 捕获永远静默早退。统一过 `toMessages()`（数组为准、信封兜底） |
| 3 | **取消息只有 `session.context` 一条路** | `message.list` rpc 宿主未注册（抛 `Object.entries(null)`）；`session.inbox.delivered` 的 `event.data` 是空对象。别再试 |
| 4 | **`session.create` 的 `model` 要 `Model.Ref` 对象**（`{providerID, id, variant?}`） | 传 `"provider/model"` 字符串 → `SchemaError`。用 `toModelRef()`；串里无 `/` 就整个省略 model，别臆造 providerID |
| 5 | **`session.prompt` 的 `text` 在 2.0.26 二进制上是裸字符串** | 生成的 `SessionPromptInput` 类型写的是对象，**类型与载荷校验不一致**。实机 A/B：对象 → `400 Expected string`；裸串 → 200。**别按 .d.ts 改回对象** |
| 6 | **⚠️ 禁止在 context hook 里 `event.tools = {}`** | 子会话模型请求被免费档网关拒：`finish:"error"` + `provider.auth` 403 `FreeTierError` → content 空 → JSON 解析失败 → **永不写盘且 failures 不涨、lastError 为空**（症状极具误导性）。二分法证明唯一变量就是这行。要约束输出用 `event.system` 替换 |
| 7 | **子会话空回复先看 `finish` / `error` / `rawFinish`** | 故障全藏在那三个字段里，别只看 content parts |
| 8 | **子会话自激循环**（实测 10 秒生成 106 个子会话） | `session-llm` 的 finally 先 remove 再 onRemoved，`childSessions` 在 `session.deleted` 事件到达前就空了；只看它会把"删自己的子会话"误判成用户删会话（那支 force=true）→ 无限循环且绕过节流。`childSessionIds` 集合专防此环，活到 deleted 事件被消费 |
| 9 | **`ctx.storage` 的键是全局的** | 所有实例写同一行互相覆盖（lastError/failures 被抹）。已按 `"diag:" + deriveSlug(directory)` 隔离（旧全局值一次性种子迁移）；**同目录多实例仍打架**（`opencode run --server` 也会实例化插件），排查优先看 serve 日志 |
| 10 | **`ctx.storage.set` 参数类型是 `Schema.Json`** | 用 `type` 别名（非 interface）声明结构体才有隐式索引签名，否则 TS 报 not assignable |
| 11 | **v2 工具结果在 `state.content: [{type:"text",text}]`** | 不是 `state.output`（state 只有 status/input/content/metadata）。消费工具输出别只读 `output` |
| 12 | **capture 全量重扫不是错误** | `planCapture` 锚点丢失（压缩/分叉）退全量扫，缓冲 evidence 去重兜底；预期降级，`diag.alerts` 留 `CAPTURE_CURSOR_LOST` warn，别当崩溃 |
| 13 | **`styleHit:true` 但 `signalCount:0` 是正常的** | `styleHit` 只是子串正则；AI 提到词却没按注释格式输出。`captureSignals` 只解析 AI 消息（user 参数故意未用） |

## 2. 数据安全陷阱

| # | 陷阱 | 对策 |
|---|------|------|
| 14 | **写盘必须保留非受管内容** | parse 只投影受管集合，其余由 `preamble` / `section.extras` 原样带回。曾因直接丢弃，首次成功提炼把 USER.md 协议块冲掉 → AI 不再发信号 → **memx 从第二轮起静默失效**。协议因此独立成 `memx-protocol.md` |
| 15 | **文件锁只包 read-modify-write，绝不包 LLM** | 持锁几十秒会卡死别的实例。崩溃靠 mtime TTL 30s 夺锁；等锁超 5s 抛 `FileLockTimeoutError` → 落 `diag.lastError`、缓冲保留重试 |
| 16 | **单遍应用不可回退** | 旧实现逐条全文件重写，同批前面的改动让后面行号失效 → 改错行/丢改动。`applyProposals` parse→改→serialize 各一次 |
| 17 | **健康日志不再写进 MEMORY.md** | HTML 注释会被下一次序列化吃掉（历史 bug）。`runHealthMaintenance` 只回传 logs → `diag.health` / alerts。**唯一例外**：阶段 4 的**一行自替换报警面包屑**（`<!-- memx: … -->`，仅 warn/critical 时存在，每次写盘先删旧行再插）走 preamble——别把"日志流"和"面包屑"混为一谈 |
| 18 | **合法空数组 ≠ 坏输出** | 前者必须清缓冲结案（否则同批信号每轮重烧 LLM）；坏输出保留重试，连续 3 次丢弃 + 报警 |
| 19 | **context hook 两分支顺序固定** | 子会话先判（整体替换 + temperature 0.2，注入绝不参与——漏进去污染提炼输入且是 403 高危）；其余会话只 append 绝不替换（hook 触发时 `event.system` 已含 agent.system + AGENTS.md 合并正文）。hook 内不 await、异常退化为不注入。**写坏 `event.system` 的表现是"模型静默变笨"而非报错** |
| 20 | **⚠️ 所有权缺口（仍未硬防）** | 2026-10-12 实测：模型把测试对话里的偏好自行写进全局 `~/.config/opencode/AGENTS.md`（10→26 行，人工回滚）。协议 v1.2.0 规则 9（"Never write memory into any file yourself"）只是系统提示词软约束。硬防要等宿主只读/白名单能力。参照 Aider 把 conventions 文件标只读 |

## 3. 工程约定

| # | 约定 |
|---|------|
| 21 | tsconfig：`exactOptionalPropertyTypes`（可选字段不能显式赋 undefined，用 `!= null`）+ `noUncheckedIndexedAccess`（数组取值 `[0] ?? fallback`）+ strict |
| 22 | 测试禁 `bun:test`（环境是 Node + vitest）；测试绝不碰真实 `~/.opencode`，每文件独立 tmp home（共享 home 并行下假失败） |
| 23 | 基线：`pnpm test` **24 文件 / 338 用例** + `pnpm run typecheck` 0 错误，低于即回归；不要 install、不要动 lockfile |
| 24 | `.opencodeignore` 是仓库约定文件（gitignore 风格），无宿主支持但 agent 应遵守 |
| 25 | 信号捕获是 HTML 注释解析（<5ms）：Stage 1（事件路径）**绝不调 LLM** |
| 26 | 所有 hook try-catch：插件错误绝不抛回宿主 |
| 27 | 改 src 必须重启 OpenCode；改 `memx.config.json` 即时生效（注入闸门 30s TTL 后台重读） |
| 28 | Slug 派生：`/root/project/foo` → `root-project-foo`。**工作目录路径避免空格/中文/特殊字符** |
| 29 | `prd.md` 是历史设计稿仅参考，不当代码事实源；README 与代码冲突时**以代码 / install.sh 为准** |
| 30 | **判断插件真实状态永远查 kv 表**：`memx_status` 只打固定字段，看不到 `evtCounts` / `lastCapture` / `rawContext`（`alerts` 例外——以账本文件为准） |
| 31 | **相对 import 一律带 `.ts` 扩展名**——CLI 走 `node --experimental-strip-types` 直载源码，缺扩展名 tsc/vitest 都发现不了，运行时才 `ERR_MODULE_NOT_FOUND` |
| 32 | 状态面板用 **`pnpm run doctor`**，别用 `pnpm doctor`（pnpm 内建同名命令会静默接管，跑成 pnpm 自检） |
| 33 | **`sync` 段配置只在 setup 读一次**：改完必须重启宿主（与 `refinementModel` / `inject.*` 的即时生效不同） |
| 34 | **报警只走 `recordAlert` / `AlertStore`**（`~/.opencode/memx-alerts.json` 是事实源，`diag.alerts` 只是只写镜像）；瞬时故障恢复后要 `resolve(code)` 销账 |
| 35 | 新增 CLI 命令必须同时进 `package.json` scripts 与 `tests/scripts-smoke.test.ts`（真跑才算过） |

## 4. 修改红线（不能动 / 动了会破坏什么）

| 红线 | 后果 |
|------|------|
| `src/core/**` import `@opencode-*` | 多宿主预留尽失（DSH 适配成本翻倍，见 DSH-ADAPT.md） |
| `session-llm.ts` import `index.ts` | 依赖成环，插件加载崩溃 |
| `hosts/opencode/index.ts` 增加命名导出 | 宿主把命名函数当插件调用 → `plugin config hook failed` crash；入口 re-export 同理只导 default |
| context hook 的分支顺序 / 替换语义 | 见 §2-19；写坏的表现是静默劣化 |
| `event.tools = {}` 进 context hook | 见 §1-6；永不写盘且诊断全空 |
| USER.md / MEMORY.md parse 丢弃非受管内容 | 见 §2-14；memx 第二轮起静默失效 |
| LLM 调用放进 `withFileLock` | 全局实例卡死 |
| 单遍应用退回逐条重写 | 行号漂移改错条目 |
| 健康日志写回 MEMORY.md | 见 §2-17；注释被序列化吃掉 |
| 把协议块写进 USER.md | 提炼重写 USER.md 时冲掉协议 → 信号断供（install.sh / sync-protocol 是唯一落盘路径） |
| 提炼子会话被注入或触发 | 见 §2-19 / §1-8 |
| 缓冲/失败处理混淆空数组与坏输出 | 见 §2-18 |
| memory_write 去掉 `codemode:false` | 回执 chip 渲染不出（App 按工具名认） |
| 内存节流改共享/持久化而不改 `markRun` 时机 | 子会话风暴（markRun 必须在 LLM 调用前置位） |
| 测试共享 tmp home / 碰真实 `~/.opencode` | 并行假失败 / 污染本机数据 |
| 锁参数（TTL 30s / timeout 5s）随意调大 | 崩溃恢复变慢 / 实例互相饿死 |
| 纯中文名的记忆文件不走确定性哈希 | 每次写都新建文件，更新语义失效 |
| 协议文本改动不递增 `PROTOCOL_VERSION` | 注入缓存与旧协议产物行为纠缠，排查困难 |
| 同步的 `push` / `pull` 改成 `await` | 把 git 网络延迟带进写盘路径（必须 `void`，见 §3-33 与 modules/sync.md） |
| PII 扫描放进 `.memx-sync.lock` 锁内 | 锁窗口只应含 git 动作；全量扫描进锁会拖长临界区 |
| 放开 `.trash/` 或 `.bak.` 进同步镜像 | 文件名带时间戳，跨机互推必冲突 |
| 删掉可自愈报警的 `resolve` 调用 | 账本与 MEMORY.md 面包屑永远挂着旧账 |
| 把 `diag.alerts` 当业务出口直接写 | 事实源在 `memx-alerts.json`；doctor / 面包屑 / `memx_status` 全读账本 |
| pull 覆盖前去掉 `.bak.` 备份 | 静默吞掉本地未推的改动（首合并、推送失败后尤其危险） |

## 5. 已知未接线 / 文档漂移（改配置或引用前先知道）

| 项 | 现状 |
|----|------|
| `maxSignalsPerSession` / `autoBackupCount` | config schema 已解析，**无消费方**（缓冲 20 / 备份 5 硬编码在 capture 与 store） |
| `COMPRESSION_PROMPT`（refine/prompts.ts） | 定义后无调用方，死代码 |
| "200 行压缩机制" | `isOverLimit` 触发的实际只是 `serializeUserMd(parseUserMd(content))` 重序列化（丢空小节），**无条目合并/压缩逻辑** |
| `core/types.ts` 的 `PluginConfigSchema` | 无使用方；实际配置 schema 是 `core/config.ts` 的 `MemxConfigSchema` |
| `src/cli/`（历史计划名） | **从未落地**；阶段 4 CLI 实际在 **`scripts/`**（doctor / sync-dry-run / sync-op / alerts / sync-protocol）——旧文档把它画在 `src/` 下是错的 |
| `@opencode/client` | package.json 声明依赖，src/ 内零 import（宿主加载环境需要） |
| README 双语 | 手动安装节曾为 v1 残留（2026-10-13 修复，已随阶段 4 提交入库）；其余段落若再与代码冲突，以代码为准 |
| 同步 v1 已知限制 | 删除不传播；不做逐行合并（rebase 冲突即 abort 留人工）；pull 不持记忆文件锁（最后写者胜，靠 `.bak.` 兜底）——**有意不做**，不是 bug |
