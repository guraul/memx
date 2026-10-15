# DSH-ADAPT.md — DSH 宿主适配调查与施工图

> 最后更新: 2026-10-13 · commit `1bb53cc`
> 性质：**调查落档**（未写任何 DSH 侧代码）。证据来自对本机 DSH 安装（全局 `@deepseek-ai/dsh` + `~/.dsh/profiles/web` 运行时约 288 个包）与两个现成第三方插件（`~/workspace/dsh-plugin-product-subagents`、`~/workspace/self-dsh-plugins/dsh-auto-upgrade`）的只读通读，关键结论附文件行号。

## 0. 结论

**可行，且比 OpenCode 宿主更顺手。** memx 四个钩子在 DSH 全部有对应物；`src/core/` **零改动**（多宿主分层红利兑现），只需新写宿主壳 + 一个 ~20 行 LLM 适配。唯一真缺口：**DSH 没有"删除会话"操作**（无 `session.deleted` 等价物）。

## 1. 能力矩阵

| memx 在 OpenCode 靠什么 | DSH 对应物 | 证据 |
|---|---|---|
| 插件系统 | Cordis 4 插件；`dsh plugin --profile web add <包>`（底层转发 pnpm 装进 profile 目录 + 追加 `dsh.profile.bundles`） | `dsh/lib/plugin-BGnVfe_D.js`；两个现成插件先例 |
| 插件模块契约 | ESM：`export const name` / `export const inject = ['tools', …]` / `export function apply(ctx, config)`（可选 `export const Config` zod schema） | `dsh-plugin-product-subagents/lib/index.js`；`dsh-agent-instructions/lib/index.js:1312` |
| `session.hook("context")` 注入 | **`ctx.systemPrompt.section({name, order, text})`**——每个 model step 组装一次，order 升序拼接；`ctx.systemPrompt.variable()` 提供插值变量 | `dsh-system-prompt/lib/index.js:240/297/355`；第一方锚点 HARNESS_IDENTITY=-1000 … personaSuffix=10200，memx 取 9000–9900 |
| `tool.transform` 注册 4 工具 | **`ctx.tools.register(defineTool({name, description, parameters, output:{schema,render}, execute}))`**——原生 function calling，**无 OpenCode v2 的 codemode 包装坑**（`memory_write` 不需要 `codemode:false` 补丁） | `dsh-tools/lib/index.js:2878`；范例 `product-subagents/lib/tools/product-roles.js` |
| `session.execution.succeeded` | `ctx.on('session/event', (session, event) => …)`，**过滤 `event.type === 'turn/end' && event.data.reason.kind === 'completed'`**（reason 还有 blocked/aborted/interrupted/error/max-tokens/forked，须排除） | `dsh-session/lib/index.js:1441`；reason 取值 `dsh-agent/lib/index.js`；参考轮次折叠 `foldConsumedWork()` |
| `session.deleted`（游标清理） | ❌ **无等价物**——DSH 连"删除会话"这个用户操作都没有（api-session-controller 命令表无 delete）。替代：`session/disposed`（会话拆卸，含义更宽）+ 定期对账 `ctx.sessionQuery.listSessions()` 或游标 TTL 清扫 | `dsh-session/lib/index.js:1806`；`dsh-api-session-controller` 命令表 |
| 子会话调 LLM 提炼 | **`ctx.llm.stream({provider, model, system, messages, maxTokens, signal})` + `BlockAssembler`**——直调宿主已配 provider/凭据，**不再需要子会话五步法**；自激循环 / FreeTierError 403 / session.prompt 类型不一致三个历史坑整体消失 | `dsh-llm/README`；1:1 范例 `dsh-session-title-llm/lib/index.js:195-240`（回合后有界辅助生成）；失败是结构化 code（NO_ADAPTER/AUTH/RATE_LIMIT/QUOTA…） |
| `ctx.storage` 诊断 | 直接写自己的 JSON 文件（**DSH 插件跑在宿主进程内、不受工作区文件沙箱限制**），或 `ctx.storageDomain`（`defineDomain` zod 校验，需 patch 加 storage+storage-json+storage-domain 三行） | `dsh-storage-domain/lib/index.js:450`；`dsh-plugin-manager` README 原话"Host 代码不受工作区沙箱限制" |
| `dispose` | `ctx.effect(() => () => cleanup)` | 两插件先例 |
| 工作目录（slug） | **`agent.session.header.cwd ?? process.cwd()`**（官方同款兜底；`header.cwd` 是可选字段）；同一会话换 cwd 被 `ApiSessionCwdConflict` 拒绝 → **slug 稳定**；slug 推导复用 `core/memory-types.ts` 的 `deriveSlug()` | `dsh-agent-instructions/lib/index.js:912/1122`；`dsh-api-session-controller/lib/index.js:273` |

基础 bundle `dsh-base` 已自带 memx 需要的全部服务（dsh-llm / dsh-storage 三件套 / dsh-tools / dsh-session / dsh-agent-instructions / dsh-system-prompt），**用户无需额外装服务**。

## 2. 推荐架构

```
memx/
├── src/core/…              # 现有零宿主依赖层——原样复用，零改动
├── src/hosts/opencode/…    # 现有 OpenCode 壳——不动
├── src/hosts/dsh/          # 新增宿主壳（语言待实测，见 §5）
│   ├── index.js            # name / inject / apply：
│   │                       #   ctx.on('session/event') turn/end(completed) → 节流 → 两轨 refine
│   │                       #   ctx.on('session/disposed') + 对账 → 游标清理
│   │                       #   ctx.systemPrompt.section(order≈9500) → 注入协议+USER.md+MEMORY.md
│   │                       #   ctx.tools.register × 4（reflect/forget/memx_status/memory_write）
│   │                       #   ctx.effect → dispose 冲刷
│   │                       #   cwd → deriveSlug → 数据根（共享 ~/.opencode/）
│   └── llm.js              # ctx.llm.stream + BlockAssembler 适配 core 的 LLMClient（~20 行）
├── package.json            # name: "dsh-plugin-memx"?；dsh.bundle.patch: "./cordis.patch.yml"
└── cordis.patch.yml        # - insert: [{ id: memx, name: '<包名或绝对路径>' }]
```

安装：`dsh plugin --profile web add /Users/gubin/workspace/memx`；禁用：用户 patch 加 `- {id: memx, disabled: true}`。

### 已拍板决策（2026-10-13）

| 决策 | 结论 |
|------|------|
| **数据目录** | **共享 `~/.opencode/`**——两宿主看同一套记忆，画像真正跨宿主；并发已有文件锁（mtime TTL + 锁内重读）覆盖；同项目两宿主 slug 相同 → 项目记忆也共享。前提改造：core 层 11 处硬编码 `~/.opencode` 参数化为"数据根"（一次性小改，OpenCode 壳默认值不变） |
| **配置持久化** | **路线 A：自读 JSON**（`~/.opencode/memx.config.json` 现状原样复用，改完即生效免重启）——与 dsh-auto-upgrade 同款做法。不走 Cordis config（避免"schemastery 学习成本 + patch config 整块替换非深合并"的坑） |
| **浏览器半边（client inject）** | **不做**。memx 四件事全是宿主侧，工具回执由 `output.render` 在宿主渲染；形态最接近的 product-subagents 也没有 client 半边。将来要状态面板再照抄 `dsh-auto-upgrade/lib/client.js` 的 `slots.inject('settings.section', …)`，与宿主壳解耦 |

### 待实测 / 待拍板

| 项 | 说明 |
|----|------|
| **壳语言 TS vs JS** | OpenCode 直接加载 `.ts` 源码（零构建）；DSH 两个先例都是纯 ESM JS。本机 Node v24.21.0 对 `.ts` 有默认 type stripping（memx 源码无 enum，兼容面干净），但 **DSH 宿主进程能否直接 import .ts 插件未实测**——10 分钟可验证；不行则加 tsc 构建步骤（`dist/` 产出 JS） |
| **peer 版本闸门** | 声明 `@deepseek-ai/dsh*` peer（当前运行时 0.2.0-rc.2）→ DSH 升级会判不兼容拒绝加载（豁免走 `dsh plugin allow-version --accept-risk`）。两先例两策略：product-subagents 精确声明；dsh-auto-upgrade 完全不声明（刻意）。memx 倾向后者（core 无 dsh 依赖，壳 API 面小） |
| **提炼模型 provider** | DSH 本机 provider 是 `opencode-go`（`OPENCODE_GO_API_KEY`，models: deepseek-v4.1-flash / mimo-v2.6-flash），非 OpenCode 的 `opencode/*` 免费档。`refinementModel` 的 `provider/model` 格式可复用，但**不能照搬 OpenCode 的网关/key 假设**；`ctx.llm.stream` 直接复用宿主已配 provider，可省掉 memx 自己的 key 管理。另：宿主默认模型带 `reasoningEffort: high`，memx 提炼应显式传低/省略 |

## 3. 开发与热更语义

| 改动 | 生效方式 |
|------|----------|
| `cordis.patch.yml` 配置 / profile bundles | ✅ 即时热生效（web profile `patchReload: live`；base 的 hmr 行 `root: []` 只监听配置） |
| 插件 JS/TS 源码 | ❌ **必须重启 dsh web**（launchd：`com.deepseek.dsh-web.*`；`dsh-plugin-manager` README 原话）。开发期用绝对路径 `dsh plugin add` 装 link |
| memx 自己的 `memx.config.json` | ✅ 现有"每次提炼即时重读"语义不变 |

## 4. 缺口与风险（诚实清单）

1. **无 `session.deleted`**（唯一真缺口）：游标清理改 `session/disposed` + 对账/TTL。
2. **`turn/end` ≠ 全部成功**：必须按 `reason.kind === 'completed'` 过滤，否则取消/报错/空轮次也触发提炼。
3. **core 数据根参数化**：11 处硬编码（store/lock/config/injection-source/memory-health/protocol-template），动手前先做。
4. **DSH 无 `tool.transform` 参数改写**（只有 pre/post-execute 拦截）——memx 不需要，记录防以后误找。
5. **peer 闸门**：见 §2 待拍板。
6. DSH 无 OpenCode 的 FreeTierError / codemode / session.prompt 类型不一致等坑——**不要把 OpenCode 侧的防御性代码照搬过去**（如 `codemode:false`、`toModelRef` 的字符串省略分支）。

## 5. 施工顺序建议（未排期）

1. core 数据根参数化（11 处 + 测试跟随）——独立可测，先做。
2. `src/hosts/dsh/llm.js`：`ctx.llm.stream` → `LLMClient` 接口（纯函数级，可 mock 单测）。
3. `src/hosts/dsh/index.js` 壳 + `cordis.patch.yml` + package.json dsh 字段；实测 TS 直载（决定语言）。
4. 真机验收：`dsh plugin add` → 注入可见（system prompt 组装）→ turn/end 触发提炼 → 写盘 `~/.opencode/` → 4 工具回执 → disposed 游标清理。
