# opencode-memx - Agent Guide

## Project

OpenCode V2 dual-track memory plugin. Track 1: captures user style preferences (cross-project, slow-changing) via `STYLE_SIGNAL` HTML comments -> refines to `~/.opencode/USER.md`. Track 2: captures project-scoped memory (ongoing work, external resources, feedback) via `MEMORY_SIGNAL` HTML comments -> refines to `~/.opencode/MEMORY.md` index + `~/.opencode/projects/<slug>/.mem/*.md` files. Both tracks share the same trigger pipeline (`session.idle` / `reflect` / `dispose`) but have separate signal buffers, refinement prompts, and write targets.

## Commands

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Always run `typecheck` before committing - TypeScript strict mode catches easy-to-miss errors.

## Key facts

- **Entry point**: `src/index.ts` exports `MemxPlugin` (V2 `Plugin` 函数). Entry must export ONLY the plugin - extra exported functions get invoked as plugins and crash OpenCode (`plugin config hook failed`)
- **Hooks**: `event` (订阅 `session.idle` + `session.deleted`) + `tool.reflect` (手动触发双轨提炼) + `dispose`
- **Install**: `~/.config/opencode/plugins/opencode-memx.ts` re-exports `MemxPlugin` from `src/index`
- **Model override**: `~/.opencode/memx.config.json` 的 `refinementModel` (`provider/model` 格式), 运行时每次读取 - 改配置**无需重启**. Default: `opencode/mimo-v2.6-flash-free` (内置免费模型, 无需 key; deepseek 官方 key 无效, 不要用)
- **LLM calls**: 子会话 `client.session.create` -> `session.prompt` (body 带 `system` + `model`) -> `session.delete` (finally), 见 `src/session-llm.ts`
- **Track 1 paths**: `~/.opencode/USER.md` (hardcoded in `src/user-md.ts`)
- **Track 2 paths**: `~/.opencode/MEMORY.md` (index) + `~/.opencode/projects/<slug>/.mem/*.md` (content), hardcoded in `src/memory-md.ts`. Slug derived from plugin's `directory` context via `deriveSlug()` in `src/memory-types.ts`
- **Backup rotation**: `writeUserMd` / `writeMemoryIndex` auto-backups before every write, keeps 5 versions
- **All hooks try-catched**: never let plugin errors reach the host
- **LLM returns Zod-validated**: `StyleProposalArraySchema` in `src/types.ts` (Track 1) + `MemoryProposalArraySchema` in `src/memory-types.ts` (Track 2); `extractJson` strips markdown fences before parse
- **Conflict handling**: when a new memory contradicts an existing one, LLM returns `deprecate` (old) + `append` (new, with `supersedes` field). Code writes `**Supersedes:**` audit line in new file, moves old file to `.mem/.trash/` (not physically deleted)
- **Health check**: `runHealthCheck` runs after each memory refinement in `reflect` / `session.idle`. Detects dead links (index points to non-existent files) and orphan files (`.mem/*.md` not in index). Auto-fixes with guardrail: max 3 per run, logs as HTML comments in MEMORY.md, escalates bloat/conflicts to manual
- **Concurrency guard**: `runRefinement` + `runMemoryRefinement` share mutex (`refinementInFlight`), `markRun()` fires BEFORE the LLM call - both prevent child-session storms / duplicate writes when idle events overlap
- **Child-session guard**: `childSessionIDs` set; guard id is removed ONLY on `session.deleted` (not on idle - idle events can arrive after the deleted event)
- **Diagnostics**: each refinement logs `llm raw(N): ...` (400-char truncation) via `client.app.log`
- **Loading mechanism**: `~/.config/opencode/opencode.json` 的 `instructions` 数组让宿主在会话启动时自动把 `USER.md` + `MEMORY.md` 注入主 AI 的 system prompt
- **AGENTS.md prompts**: `~/.config/opencode/AGENTS.md` 含主 AI 提示词（User Style Signal Marking + Project Memory Signal Marking + Project Memory Loading）

## Architecture

```
src/
  types.ts             - StyleSignal, StyleProposal, Zod schemas (Track 1)
  prompts.ts           - Track 1 system prompt constants
  user-md.ts           - read/write/parse/backup USER.md
  signal-capture.ts    - STYLE_SIGNAL HTML comment parser + SignalBuffer (max 20, dedup by evidence)
  refinement.ts        - Track 1 LLM batch refinement + Zod validation + extractJson
  memory-types.ts      - MemorySignal, MemoryProposal, Zod schemas + deriveSlug() (Track 2)
  memory-prompts.ts    - Track 2 system prompt constants
  memory-md.ts         - read/write/parse MEMORY.md index + .mem/*.md files + backup
  memory-capture.ts    - MEMORY_SIGNAL HTML comment parser + MemorySignalBuffer (max 20, dedup by evidence)
  memory-refinement.ts - Track 2 LLM batch refinement + Zod validation
  memory-health.ts     - Index health check (dead links, orphan files) + auto-fix with guardrails
  config.ts            - `~/.opencode/memx.config.json` load + Zod validation (shared)
  session-llm.ts       - LLMClient adapter via child session.prompt (shared)
  throttle.ts          - session.idle 节流（throttleMinutes, shared)
  index.ts             - V2 Plugin entry: event + tool.reflect + dispose, dual-track
tests/
  fixtures/            - mock conversations + sample USER.md
```

## Quirks & gotchas

- **`session.idle` fires only when the session is truly idle** (after a turn fully ends). Continuous tool calls / active turns delay it indefinitely. Debug via the `reflect` tool instead.
- **Src changes require an OpenCode restart** - plugins load once at startup; touching the entry file does NOT hot-reload. Config file changes apply immediately.
- **`exactOptionalPropertyTypes`** in tsconfig: optional fields like `target_line?: number` cannot be explicitly set to `undefined`. Use `target_line != null` checks instead of loose equality. Use `.nullish()` in Zod for nullable optional fields.
- **`noUncheckedIndexedAccess`**: array access returns `T | undefined`. Always use `[0] ?? fallback`.
- **No `bun:test`**: environment has Node.js + vitest, not Bun. Don't import from `bun:test`.
- **Design docs**: `prd.md` is reference only - don't treat it as code.
- **`.opencodeignore`**: repo convention file (gitignore style) listing paths agents should not read or modify (`prd.md`, `docs/`, `.superpowers/`, etc.). Honor it even though opencode has no built-in support.
- **Signal capture is HTML comment parsing** (<5ms): never call LLM in Stage 1 (runs inside the `session.idle` event handler). Main AI emits `<!-- STYLE_SIGNAL: ... -->` / `<!-- MEMORY_SIGNAL: ... -->` comments; plugin parses them.
- **The `reflect` tool** manually triggers BOTH tracks' refinement (fallback if `session.idle` doesn't fire).
- **Grep errors, not `memx`**: `client.app.log` messages don't show the `service` field in opencode.log - search `level=ERROR` when debugging.
- **Slug derivation**: `/root/project/foo` -> `root-project-foo` (path `/` -> `-`, strip leading/trailing). Avoid spaces/Chinese/special chars in working directory path.

## Test patterns

- Tests use `vitest` API (`describe`, `it`, `expect`)
- LLM calls are mocked in refinement tests (`refine` / `refineMemory`)
- Tests mock `homedir` to `/tmp/opencode-memx-test-home` - they must NEVER touch real `~/.opencode` files
