# modules/injection.md — system prompt 注入

> 最后更新: 2026-10-13 · commit `1bb53cc` · 2026-10-15 复核：内容未变（`77ccc97`，仅 import 扩展名统一）

## 职责

每个 model step 把三块内容（协议 / USER.md / MEMORY.md 索引）**追加**进宿主已组装好的 system prompt，并管理 agent 闸门与截断。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/core/injection.ts` | 装配纯函数：来源顺序、200 行/25KB 上限、截断提示行、`shouldInjectAgent` 闸门真值表、`describeGate` |
| `src/core/injection-source.ts` | 三块来源读取 + `stat(mtimeMs+size)` 缓存（缺失也缓存，mtimeMs=-1）+ `InjectionSourceCache` |
| `src/hosts/opencode/context-hook.ts` | hook 判定与装配（子会话整体替换 vs 其余 append）——机制见 ARCHITECTURE.md §5 |
| `src/core/protocol-template.ts` | 协议文本常量（注入内容之一） |

## 注入内容与顺序

`INJECTION_SOURCE_ORDER`：**协议（memx-protocol.md）→ 画像（USER.md）→ 索引（MEMORY.md）**。每块独立一个 SystemPart。

- 上限各 **200 行或 25KB（先到先算，UTF-8 字节安全截断）**；常量 `INJECT_MAX_LINES` / `INJECT_MAX_BYTES` 在 injection.ts，**刻意不做成配置项**（写盘侧已把画像压在 200 行内，这是兜底而非日常旋钮）。
- 截断时追加可见提示行：`[memx: truncated — showing first 200 of 512 lines ...]`——要避免的失败模式是静默截断。
- Track 2 注入的是 **MEMORY.md 索引**，不是 `.mem` 全文（模型按 description 判断是否需要再读文件）。
- 三块都缺 → hook 整个什么都不做（`kind: "empty"`）。

## agent 闸门

配置 `memx.config.json` 的 `inject.{enabled, includeAgents, excludeAgents}`：

- `enabled=false`：一个字节都不注入（协议 hook 照常工作）。
- 生效集合 = `includeAgents`（`"all"` 或数组）减去 `excludeAgents`（永远压过 include）。
- **仓库里不硬编码任何 agent 名**（memx 必须宿主无关）——该排除谁由消费方填（例如会把 system prompt 原样回显的 agent 会把协议泄给用户）。
- 生效中的闸门显示在诊断 `inject.gate`；配置 30 秒 TTL 后台重读（hook 每 step 同步触发，不能在里面 await），改配置无需重启宿主。

## 性能与缓存

- 文件读走 stat(mtimeMs+size) 缓存；诊断写盘节流 5s。
- 注入追加在尾部 → 落在宿主 `cache:"auto"` 断点（最后一个 distinct system part）之内，**注入不伤缓存**；失效只在 USER.md/MEMORY.md 被改写时发生。
- 诊断计数：`hookFires`（hook 触发总数）vs `injections`（真正追加次数）。`hookFires > 0` 但 `injections == 0` → 先看 `inject.gate` 与 `inject.empty`。

## 修改注意事项与红线

1. **非子会话分支只 append 绝不替换**——hook 触发时 `event.system` 已含 agent.system + AGENTS.md 合并正文。
2. **子会话分支先判**（整体替换 + temperature 0.2，注入绝不参与），顺序不能换。
3. hook 内不 await、任何异常退化为"不注入"，绝不半途写坏 `event.system`。
4. 上限常量不是配置项——真出现需要调的负载再暴露成配置（改动需同步 README 注入上限一节）。

## 测试

`tests/injection.test.ts`（顺序/上限/截断提示/闸门真值表）/ `injection-source.test.ts`（stat 缓存）/ `context-hook.test.ts`（两分支互斥与退化）。
