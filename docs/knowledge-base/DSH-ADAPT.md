# DSH-ADAPT.md — DSH 宿主适配（已落地并安装）

> 最后更新: 2026-10-25 · commit `c232168`
> 性质：**两步都已落地，且已真机安装运行**。适配器在本仓 `src/hosts/dsh/`；接线薄壳包 `dsh-plugin-memx` 在**独立仓** `~/workspace/self-dsh-plugins/dsh-plugin-memx`，已 link 进 `~/.dsh/profiles/web`。能力矩阵来自本机 DSH 0.2.1-rc.2 实测。

## 0. 结论

**可行，且已上线使用。** `src/core/` **零改动**（多宿主分层红利兑现）；DSH 适配器只做接线：注入段、3 个工具、轮末补记、`ctx.llm.stream` 适配。唯一真缺口（设计上）仍是 **DSH 没有"删除会话"**——因此 DSH 侧不维护增量游标。

**2026-10-24 实测证据**（不是从文档推断的）：

| 证据 | 位置 / 结果 |
|------|------------|
| 薄壳包已装进 profile | `~/.dsh/profiles/web/package.json` → `dependencies["dsh-plugin-memx"] = "link:/Users/gubin/workspace/self-dsh-plugins/dsh-plugin-memx"`，且 `dsh.profile.bundles` 含 `dsh-plugin-memx` |
| 插件行已注册 | `~/.dsh/profiles/web/cordis.patch.yml` → `- id: memx / name: dsh-plugin-memx / config: {provider: opencode-go, model: mimo-v2.6-flash}` |
| 加载的是本仓源码 | `dsh-plugin-memx/lib/index.js` → `MEMX_ROOT = "/Users/gubin/workspace/memx/"`，`MEMX_ENTRY = .../src/hosts/dsh/index.ts`，用 `registerHooks` + `stripTypeScriptTypes` 加载 |
| 宿主在跑 | `dsh web` 监听 `127.0.0.1:3080`（node PID 2554） |
| 注入生效 | 本会话 system prompt 里已有 memx 协议 + USER.md 画像 + 当前项目 `MEMORY.md` 小节 |
| 工具生效 | 本会话 `memory_write` 回执 `[memx] 已记住：…`；`memory_search` 能查回刚写的条目（`~/.opencode/projects/Users-gubin-workspace-memx/.mem/…`） |
| 写盘生效 | `~/.opencode/MEMORY.md` 已含当前 slug 小节，`.mem/*.md` 与 `.bak` 均有更新 |

## 1. 能力矩阵（计划 vs 实际）

| memx 需要的能力 | DSH 对应物 | 实际落地 |
|---|---|---|
| 插件模块契约 | ESM 具名导出 `name` / `inject` / `apply`（可选 `Config`） | ✅ `src/hosts/dsh/index.ts` |
| system prompt 注入 | `ctx.systemPrompt.section({name, order, interpolate, text})` | ✅ `name: "memx:memory"`，`order: 12000`，`interpolate: false` |
| 工具注册 | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))` | ✅ 3 个（memory_write / memory_search / forget），无 codemode 包装 |
| 回合结束触发 | `ctx.on("session/event")` 过滤 `turn/end` | ✅ 还消费 `turn/start` / `assistant/message` 收集本轮文本 |
| 子会话调 LLM | `ctx.llm.stream({provider, model, system, messages})` | ✅ `dsh/llm.ts` → core `LLMClient`（不造子会话） |
| 会话删除清理 | ❌ 无等价物 | ⚪ 不做（本层无游标，无需清理） |
| 诊断存储 | 无 kv（插件跑宿主进程内） | ⚪ 只在内存 + `ctx.logger.warn("[memx] …")` |
| dispose | `ctx.effect(() => () => cleanup)` | ⚪ 未注册（无定时器/无全局资源需要清理） |
| 工作目录（slug） | `ctx.workingDirectory.get(session)` / `defaultDirectory` | ✅ `slugFor()` → `deriveSlug` |
| 报警账本 | 同一份 `~/.opencode/memx-alerts.json` | ✅ `createFileAlertStore()` |
| 配置 | 薄壳包 schemastery `.volatile()` 引用 cell | ✅ 薄壳包已声明四个 volatile 字段；Web 设置页「记忆」可改；memx 侧每次轮末现读 |

## 2. 实际架构

```
memx/                                   # 本仓
├── src/core/…                          # 原样复用，零改动
│   └── pipeline/
│       ├── session.ts                  # SessionPipeline（两宿主共用流水线）
│       └── injection-source.ts         # readInjectionSourcesForSlug（当前节 + related）
├── src/hosts/opencode/…                # OpenCode 壳（695 行，只做接线）
├── src/hosts/dsh/                      # DSH 适配器（被薄壳包加载）
│   ├── index.ts                        # name/inject/Config/apply：注入段 + 3 工具 + 轮末补记（743 行）
│   ├── llm.ts                          # ctx.llm.stream → LLMClient + resolveRoute
│   ├── types.ts                        # 官方 d.ts 的最小子集（零 @deepseek-ai import）
│   └── README.md                       # DSH 侧详细说明
└── tests/hosts-dsh.test.ts             # 假 ctx 覆盖注入/工具/补记/节流/跳过原因

~/workspace/self-dsh-plugins/dsh-plugin-memx/   # 独立仓（薄壳包，不在本仓）
├── package.json                        # name: dsh-plugin-memx；dsh.bundle.patch + dsh.client.inject
├── cordis.patch.yml                    # - insert: [{ id: memx, name: dsh-plugin-memx, config: {} }]
├── src/config.ts                       # 四个 volatile 字段（schemastery）
├── src/client/MemorySettings.tsx       # Web 设置页「记忆」
├── lib/index.js                        # 手写转发：registerHooks + stripTypeScriptTypes → 本仓 src/hosts/dsh/index.ts
└── lib/config.js / lib/client.js       # esbuild 产物

~/.dsh/profiles/web/                    # 实际安装位置
├── package.json                        # dependencies link:…dsh-plugin-memx；bundles 含它
├── cordis.patch.yml                    # - id: memx / name: dsh-plugin-memx / config: {provider, model}
└── node_modules/dsh-plugin-memx -> …   # pnpm link
```

与 2026-10-13 计划的差异（都是实测后改的）：

| 计划 | 实际 | 原因 |
|------|------|------|
| `index.js` / `llm.js`（JS） | `index.ts` / `llm.ts`（TS） | Node 24 的 type stripping + 薄壳包的 load hook（transform 模式） |
| 4 工具（reflect / forget / memx_status / memory_write） | 3 工具（memory_write / memory_search / forget） | `reflect` 由 `turn/end` 自动补记替代；`memx_status` 在 DSH 没有 kv 可读 |
| `order ≈ 9500` | `order: 12000` | 官方 `SECTION_ORDERS` 里 12000 落在工具说明与 MCP 之间，不与内建段冲突 |
| 薄壳包放本仓根 | 独立仓 `dsh-plugin-memx` | 本仓保持"零 `@deepseek-ai/*` 依赖"；薄壳包单独管 schemastery 与 Web 设置页 |
| core 数据根参数化（11 处） | **未做** | 两宿主同机同 homedir，硬编码 `~/.opencode` 已天然共享；现为 **18 处** |
| 游标清理（`session/disposed` + 对账） | 不做 | DSH 壳不维护游标；`turn/end` 只看本轮文本 |
| 用 `ctx.effect` 做 dispose | 未注册 | 无定时器/无全局资源 |

## 3. 薄壳包 `dsh-plugin-memx`（第二步，已落地）

版本 0.2.0，位于独立仓 `~/workspace/self-dsh-plugins/dsh-plugin-memx`。它**不复制任何记忆逻辑**，只做四件事：

1. **接线**：`lib/index.js` 用 `registerHooks` + `stripTypeScriptTypes`（transform 模式）加载本仓 `src/hosts/dsh/index.ts`，再把 `name` / `inject` / `apply` 原样转发给 Cordis。为什么不用直接 `export … from "…/index.ts"`：Node 24 默认只有 strip-only 剥离，memx 源码里的 parameter property 会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（2026-10-22 实测）。
2. **配置声明**：`src/config.ts` 用 schemastery 声明四个 `.volatile()` 字段（provider / model / autoRefine / throttleMinutes），默认值与 memx `DshMemxConfig` 一致。**不转发 memx 的 `Config`**——memx 那份是手写 standard-schema，宿主 `volatileForm()` 投影不出字段，设置页会整页消失。
3. **Web 设置页**：`src/client/MemorySettings.tsx` 提供「设置 → 记忆」：提炼模型下拉（首项"跟随当前会话"）、自动提炼开关、提炼间隔。模型选项来自 llm-pi-ai 配置 + 运行时目录合并。
4. **Bundle patch**：自带 `cordis.patch.yml` 插入 `{ id: memx, name: dsh-plugin-memx, config: {} }`。

安装（已实际执行过）：

```bash
dsh plugin --profile web add /Users/gubin/workspace/self-dsh-plugins/dsh-plugin-memx
# 效果：profile package.json 出现 link 依赖 + bundles 追加 dsh-plugin-memx；
#       profile cordis.patch.yml 出现 id: memx 的插件行；重启 dsh web 生效
```

当前 profile 里的配置（用户层 patch）：

```yaml
- id: memx
  name: dsh-plugin-memx
  config:
    provider: opencode-go
    model: mimo-v2.6-flash
```

⚠️ **路径硬编码**：`lib/index.js` 的 `MEMX_ROOT` 固定为 `/Users/gubin/workspace/memx/`。搬仓、换 clone、或同时保留多份 checkout 时必须同步改这个常量（或重新生成薄壳包），否则 DSH 会静默加载旧目录的代码。

## 4. 运行时行为（实测）

1. **注入**：每个会话第一次装配时求值一次 `buildInjectionParts(readInjectionSourcesForSlug(cache, slug, cwd))`（当前节 + related，#32），之后同一 `agent` 对象拿到同一串字节（WeakMap）。注入正文**不含时间/计数/随机**。
2. **工具**：`memory_write` 参数与 OpenCode 版逐字段对齐；`memory_search` / `forget` 走 core（`searchMemories` / `forgetMemory` + 索引写盘）。`slug` 缺省按会话 cwd 推导；`memory_search` 推导不出 → 全库（只读），`forget` 推导不出 → 直接失败。
3. **轮末补记**：`turn/end` → `autoRefine === false` 跳过 → 同 turn 幂等 → 本轮有工具写入则跳过 → 无信号跳过 → 会话级节流 → 解析路由（配置优先，回落会话模型；取不到 → 跳过）→ `pipeline.refineMemory(true)`。`queueMicrotask` 起步，**不 await 阻塞事件分发**。
4. **提示**：写入成功且拿得到 `createUserMessage` 时，`agent.inject` 排一条 `[memx] 已记住 N 条`（≤120 字）。
5. **跳过原因**：`diag.skipped` 六类（`disabled` / `duplicate` / `written` / `empty` / `throttle` / `noModel`），只在内存。

## 5. 开发与热更语义

| 改动 | 生效方式 |
|------|----------|
| `~/.dsh/profiles/web/cordis.patch.yml` / profile bundles | ✅ 即时热生效（web profile `patchReload: live`） |
| 本仓 `src/hosts/dsh/**`（薄壳包直接加载源码） | ❌ **必须重启 dsh web**（launchd：`com.deepseek.dsh-web.*`）；不用重编薄壳包 |
| 薄壳包 `src/config.ts` / `src/client/**` | ❌ `pnpm build` 后重启 dsh web |
| DSH 的四个 volatile 字段（设置页 / profile patch） | ✅ 每次轮末现读，改完即时生效 |
| `~/.opencode/memx.config.json` | ✅ 每次提炼重读（与 OpenCode 同语义）；但 `refinementModel` 对 DSH **不生效** |

## 6. 剩余缺口与风险（诚实清单）

1. **`inject.*` 闸门未接**：DSH 直接注册 section，不读 `enabled` / `includeAgents` / `excludeAgents`。
2. **`turn/end` 不过滤 `reason`**：aborted / cancelled 轮次也进补记判定（有信号才提炼）。
3. **云同步未接**：`sync.push/pull` 只在 OpenCode 壳接线；DSH 写盘不触发同步。
4. **无诊断面板**：没有 `memx_status` / doctor 等价物；设置页只改配置，不显示计数。诊断只在内存 + 宿主日志 `[memx] …`，重启清零。
5. **薄壳包路径硬编码**（见 §3）：多 checkout / 搬仓会加载错代码。
6. **注入每会话一次**：本会话新写的记忆不可见（拍板语义，不是 bug）。
7. **不要照搬 OpenCode 侧防御性代码**（`codemode:false`、`childSessionIds`、`event.tools={}`、`toModelRef` 字符串省略分支）——DSH 无对应坑。
8. **peer 版本闸门未声明**：memx 不依赖任何 `@deepseek-ai/*` 包（刻意），DSH 升级不会因版本判定拒绝加载；代价是宿主 API 变动只能靠 `types.ts` 手写核对。
