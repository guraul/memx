# memx

**[English](README.md)** | [中文](README_zh.md)

OpenCode V2 dual-track memory plugin. Automatically extracts cross-session user preferences (Track 1) and project context (Track 2) from conversation history, persisting to `~/.opencode/USER.md` and `~/.opencode/projects/<slug>/.mem/*.md` respectively.

## Design Philosophy

`memx` is built on a core insight: **user style and project memory are fundamentally different types of memory**.

- **Track 1 (User Style)**: Cross-project slow-changing profile (communication style, toolchain preferences, technical taste). Single `USER.md` file, four categories, 200-line compression. Main AI marks signals via `STYLE_SIGNAL` HTML comments; sub-AI batches refinement.
- **Track 2 (Project Memory)**: Project-bound fast-changing log (ongoing work, external resources, collaboration guidance). `MEMORY.md` index + standalone `.mem/*.md` files (with frontmatter; feedback/project types require Why + How to apply). Main AI marks signals via `MEMORY_SIGNAL` HTML comments; sub-AI batches refinement.

Both tracks share the same trigger pipeline (`session.idle` / `reflect`) but have completely independent signal buffers, refinement, and write targets.

### Open-Source References

| Reference | Borrowed | In This Plugin |
| :--- | :--- | :--- |
| **CodeBuddy** | Index+content separation, frontmatter, mandatory Why/How to apply, What NOT to save | Track 2's `MEMORY.md` + `.mem/*.md` structure + `MEMORY_REFINEMENT_SYSTEM_PROMPT` |
| **Honcho** | Dialectical reasoning prompt | Prompts LLM to ask "does this apply across projects?", distinguishing temporary instructions from long-term preferences |
| **Mem0** | Dedup and incremental update | `StyleProposal.action` / `MemoryProposal.action` (append/update/deprecate) + dedup rules |
| **OpenClaw** | Time decay and lifecycle management | 200-line compression + strikethrough deprecation (no physical deletion) |
| **OpenCode V2 Plugin API** | Hook system + session assembly hook | `event` / `tool.reflect` / `dispose` + system-prompt injection via the plugin's own `context` hook |
| **Zod** | Runtime Schema Validation | All LLM returns are runtime-validated to prevent JSON Mode drift |

### Key Design Decisions

| Decision | Rationale |
| :--- | :--- |
| **Main AI emits HTML comment markers** | Main AI has full conversation context, far better at identifying preferences than regex. Users don't see comments; plugin parses them. |
| **Sub-AI batch refinement** | Dedup, conflict detection, schema validation done by Stage 2 sub-session LLM; main AI only identifies signals |
| **Auto-write + backup** | No human confirmation; auto-backup before every write, keeping latest 5 versions |
| **Plugin injects its own system prompt** | The plugin appends `memx-protocol.md` + `USER.md` + `MEMORY.md` to `event.system` in its `context` hook. Each is its own `SystemPart`, order: protocol → profile → index. Content is capped at 200 lines / 25KB per source, and truncation appends a visible `[memx: truncated — ...]` line so nothing is dropped silently. The `instructions` entries in `opencode.json` are **inert on v2.0.26** (the host only assembles instructions from `AGENTS.md`) and are kept only for forward compatibility |
| **Project isolation** | Track 2's `.mem/` dir is isolated by working directory slug (`/root/project/foo` -> `root-project-foo`); cross-project memories don't pollute |

## Dual-Track Pipeline

```
[Signal Capture]                  ->    [Batch Refinement + Persistence]
 session.execution.succeeded / reflect    session.execution.succeeded / reflect
      │                                       │
 Track 1: STYLE_SIGNAL HTML comments      Track 1: LLM dialectical refinement
 Track 2: MEMORY_SIGNAL HTML comments    + USER.md diff + incremental patch
      │                                       │
 in-memory buffer (max 20, dedup by       Track 2: LLM dialectical refinement
  evidence)                               + MEMORY.md diff
      │                                       + .mem/*.md write
      ↓                                       ↓
 ctx.storage diagnostics + clear buffer   USER.md + MEMORY.md auto-backup
```

## Trigger Mechanism

- `session.execution.succeeded`: Fires after every turn (v2 does **not** emit `session.idle`). Captures signals incrementally and refines (throttled by `throttleMinutes`).
- `session.deleted` / exit (`dispose`): Force-flushes the buffer and drops that session's capture cursor.
- `reflect` tool: Manually triggers full refinement (skips throttle). Runs both Track 1 and Track 2. Fallback when the event trigger is throttled or doesn't fire.
- Plugin auto-skips its own refinement sub-sessions; refinement is mutex-serialized (`refinementInFlight`) to prevent concurrent storms and duplicate writes.

## Correctness guarantees (stage 3 P0 fixes)

- **Incremental capture**: every turn is scanned, not just the last one. A per-session cursor anchored on the **message id** lives in `ctx.storage` (`cursor:<sessionID>`); if the anchor is gone (context compaction/fork) it falls back to a full rescan, deduped by signal `evidence`, and records a warn alert.
- **Three-state refinement**: `proposals` / `adjudicated-empty` / `invalid-output`. "Nothing worth saving" clears the buffer; malformed LLM output keeps it for a retry, and 3 consecutive bad outputs drop it with an alert instead of looping forever.
- **Single-pass write + content anchors**: a batch is parsed once, applied in memory, serialized once (no intra-batch line drift). `update`/`deprecate` locate their target by copying the entry text (`target_text`: exact → normalized → unique containment → line number as last resort); every downgrade or miss is reported.
- **Cross-process lock**: `USER.md` / `MEMORY.md` read-modify-write runs under a lock file with mtime TTL (`~/.opencode/.*.lock`), and the file is re-read inside the lock. The LLM call is never inside the lock.
- **Health logs never enter `MEMORY.md`**: autofix results go to `ctx.storage` diagnostics / alerts; the index stays a pure index.

## Installation

### Quick Install

```bash
git clone https://github.com/guraul/memx.git
cd memx
bash install.sh
```

This clones the repo to `~/workspace/memx` (override with `bash install.sh <path>`), installs pnpm dependencies, creates the plugin entry, declares dependencies, writes the signal protocol file `~/.opencode/memx-protocol.md`, and adds the `instructions` entries in `opencode.json` (forward-compatibility only — see below). Then restart OpenCode and check `/status`.

> **The signal protocol moved out of `USER.md` into a standalone file.** Its text now lives only in `src/core/protocol-template.ts`, is written by `scripts/sync-protocol.ts`, and is injected by the **plugin's own `context` hook**. Do **not** hand-write the protocol block into `~/.opencode/USER.md` — that file is memx's data file and gets rewritten on every refinement, which silently wipes the protocol (it did, once).

> **How content actually reaches the model.** The plugin registers a `session.hook("context", …)` and **appends** three `SystemPart`s to the system prompt the host already assembled (`agent.system` + the merged `AGENTS.md` body). Order: `memx-protocol.md` (how to emit signals) → `USER.md` (Track 1 profile) → `MEMORY.md` (Track 2 index). Missing files are skipped silently; if all three are missing the hook does nothing. A refinement **child session is never injected into** — that branch still replaces the whole system prompt and pins temperature 0.2.
>
> The `instructions` array in `opencode.json` is **dead on opencode v2.0.26**: the host's only instruction-assembly plugin (`packages/core/src/config/plugin/instruction.ts`) loads `AGENTS.md` files and nothing consumes the normalized `config.instructions`. The entries `install.sh` writes are therefore a no-op today, kept only in case a future version honors them.

### Manual Install

If you prefer to do it step by step:

1. Clone the repo and install dependencies (this repo uses pnpm only — no npm/yarn/bun):
   ```bash
   git clone https://github.com/guraul/memx.git /path/to/memx
   cd /path/to/memx
   pnpm install        # no pnpm? run `corepack enable pnpm` first
   ```

2. Create the global plugin entry (pointing to `src/hosts/opencode/index.ts`):
   ```bash
   mkdir -p ~/.config/opencode/plugins
   echo 'export { default } from "/path/to/memx/src/hosts/opencode/index";' > ~/.config/opencode/plugins/memx.ts
   ```
   > ⚠️ **Default export only.** The host treats every named export of the entry file as a plugin and invokes it — one extra named export crashes OpenCode with `plugin config hook failed`.

3. Declare dependencies (if `~/.config/opencode/package.json` doesn't exist) — note v1's `@opencode-ai/plugin` was renamed to v2's `@opencode/plugin`:
   ```json
   {
     "dependencies": {
       "zod": "^4.4.3",
       "@opencode/plugin": "^2.0.26",
       "@opencode/client": "^2.0.26"
     }
   }
   ```

4. Write the signal protocol file (single source of truth is `src/core/protocol-template.ts`; never hand-edit the output). The script imports with an explicit `.ts` extension, so it needs **Node ≥ 22.6** (native strip types):
   ```bash
   node scripts/sync-protocol.ts ~/.opencode/memx-protocol.md   # idempotent: no rewrite when identical
   ```

5. *(optional, forward-compat)* Add an `instructions` field to `~/.config/opencode/opencode.json`:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "instructions": [
       "~/.opencode/USER.md",
       "~/.opencode/MEMORY.md",
       "~/.opencode/memx-protocol.md"
     ]
   }
   ```
   On opencode v2.0.26 this array is **not read by the host** — injection already works without it (step 1–4 are sufficient, because the plugin appends the same three files itself). `install.sh` adds any missing entries idempotently and leaves every other key alone.

6. Make sure your reply rendering strips HTML comments — otherwise users see raw `<!-- STYLE_SIGNAL: ... -->` text. (The host does *not* strip them from the system prompt; that is a UI-layer concern.)

7. Restart OpenCode; `/status` should show `memx`. Then run the `memx_status` tool and confirm the `inject.*` lines: `hookFires` counts every hook call, `injections` counts the ones that actually appended content. If `hookFires > 0` but `injections == 0`, check `inject.gate` and `inject.empty`.

### Configuration

Customize via `~/.opencode/memx.config.json`:

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `refinementModel` | `string` | `opencode/mimo-v2.6-flash-free` | Refinement model (`provider/model` format). **Production keeps this free model**; local dev overrides it to `opencode-go/longcat-2.5-preview-free` in `~/.opencode/memx.config.json` (the local free tier is gated 403/429) |
| `maxSignalsPerSession` | `number` | `20` | Signal buffer max size |
| `autoBackupCount` | `number` | `5` | Backup retention count |
| `throttleMinutes` | `number` | `10` | Refinement throttle interval (minutes) |
| `inject.enabled` | `boolean` | `true` | Whether the `context` hook injects memx content into the system prompt at all |
| `inject.includeAgents` | `string[] \| "all"` | `"all"` | `"all"` = every agent; an array = only those agents |
| `inject.excludeAgents` | `string[]` | `[]` | Always wins over `includeAgents` |

Injection gate: `enabled=false` injects nothing. Otherwise the effective set is `includeAgents` minus `excludeAgents`. memx hardcodes no agent name anywhere — which agents to exclude is the consumer's decision (for example, an agent that echoes its system prompt verbatim would leak the protocol to the user). The effective gate is shown as `inject.gate` in diagnostics. Config changes take effect within 30s without restarting the host.

### Injection Caps

Each of the three injected sources is capped independently at **200 lines or 25KB**, whichever comes first. When a source is truncated, a visible line is appended to the injected text —

```
[memx: truncated — showing first 200 of 512 lines (18400 of 30000 bytes); 200-line cap]
```

— so both the model and the `inject.truncations` diagnostic record that content was dropped. Silent truncation is the failure mode being avoided here. The constants are `INJECT_MAX_LINES` / `INJECT_MAX_BYTES` in `src/core/injection.ts`; they are deliberately **not** config keys (the profile is already kept under 200 lines by the writer-side `isOverLimit`, so the cap is a backstop rather than an everyday knob — make them configurable only if a real workload needs it).

## USER.md Format

The plugin-managed user style file is at `~/.opencode/USER.md`:

```markdown
# User Profile & Style

> Auto-generated by memx. Last updated: 2026-07-29

## Communication Style
- [2026-07-29] Prefers complete refactored code over step-by-step explanations

## Toolchain Preferences
- [2026-07-25] Uses pnpm instead of npm/yarn

## Architecture & Technical Decisions
- [2026-07-22] New projects default to SvelteKit + Drizzle ORM

## Pitfalls & Taboos
- [2026-07-27] No emojis in code comments
- ~~[2026-07-15] Prefers Vue 3 Composition API~~ (Deprecated: migrated to Svelte)
```

**Format Rules:**
- Each entry starts with `- [YYYY-MM-DD]`
- Deprecated entries marked with `~~strikethrough~~`, not physically deleted
- Four fixed category headers, no additions
- Hard limit 200 lines, auto-compress when exceeded

## MEMORY.md Format (Track 2 - Project Memory)

The plugin also manages project-level memory. The index file is at `~/.opencode/MEMORY.md`, and individual memory files are at `~/.opencode/projects/<slug>/.mem/*.md`.

```
~/.opencode/
├── USER.md                    # Track 1: Global user style
├── MEMORY.md                  # Track 2: Project memory index (grouped by project)
└── projects/
    └── <slug>/
        └── .mem/
            ├── project_auth_rewrite.md
            ├── reference_grafana.md
            └── feedback_testing.md
```

**MEMORY.md Index Format**:
```markdown
## root-project-foo
- [auth rewrite](~/.opencode/projects/root-project-foo/.mem/project_auth_rewrite.md) - auth middleware rewrite driven by compliance
- [grafana dashboard](~/.opencode/projects/root-project-foo/.mem/reference_grafana.md) - grafana.internal/d/api-latency is oncall dashboard

## root-project-bar
- [loop scheduler](~/.opencode/projects/root-project-bar/.mem/project_loop_scheduler.md) - scheduler refactor in progress
```

**Memory File Format** (with frontmatter; feedback/project types require Why + How to apply):
```markdown
---
name: auth rewrite
description: auth middleware rewrite driven by compliance
type: project
---
Rewriting auth middleware for compliance.

**Why:** Legal flagged session token storage.
**How to apply:** Scope decisions favor compliance over ergonomics.
```

**Four Memory Types**:
- `project`: Ongoing work, goals, incidents (not derivable from code)
- `reference`: External resource pointers (Linear, grafana, etc.)
- `feedback`: Collaboration guidance (corrections + confirmations)
- `user`: User role, knowledge background

## Commands

### `reflect`
Manually triggers style + project memory refinement (fallback when the event trigger is throttled or didn't fire).

### `forget`
`forget(keyword)` moves matching `.mem/*.md` files to `.trash/` and removes their index entries.

### `memory_write`
Explicitly record one project-scoped memory (this is what a companion agent calls when the user says
"remember this"). Arguments: `text` (required, ≤500 chars), `type` (`user|feedback|project|reference`,
default `project`), `name`, `description`, `why`, `how_to_apply`, `evidence`. Same type + name is treated
as a revision (update), not a duplicate. It writes through the same single-pass + file-lock path as the
refinement pipeline, so the two can never disagree about the file format.

### `memx_status`
Prints structured diagnostics (capture/refinement/written counters, cursor state, invalid-output streak,
location warnings, health, alerts, explicit writes). The stored kv row is the real truth — see AGENTS.md.

### `memx doctor`
Read-only status panel: alerts / memory files / opencode diag / sync. Run it as `pnpm run doctor` — **not**
`pnpm doctor`, which is a pnpm built-in of the same name. Use when you want to see memx's health without
triggering a refinement.

## Multi-machine sync

Syncs USER.md / MEMORY.md / `.mem/*.md` across machines via a GitHub repo (`guraul/memx-sync` by default).
**Off by default** — enable in `~/.opencode/memx.config.json`: `{"sync": {"enabled": true, "machineName": "mbp"}}`
(restart OpenCode after changing). Push fires after each memory write; pull runs at startup + every `intervalMinutes`.
`pnpm sync:dry-run` previews what would sync (read-only, never pushes); add `-- --fetch` to align the cache
workdir with the remote first — use that mode before the *first* pull on a new machine, otherwise the report
can only say "remote not fetched". Pull is remote-wins: before overwriting a local file whose content differs,
the local copy is saved as `<file>.bak.<ts>` (5 kept per file). A PII gate (8 rule types) blocks any push
containing tokens/keys — hits are reported as file+line+rule only, never echoed. Deliberately not in v1:
delete propagation, per-line merge (same file edited on both machines relies on git rebase, which aborts to
manual on conflict), pull-vs-write locking (the `.bak` copy is the safety net there; sync ops are serialized against each other by `.memx-sync.lock`).

## Troubleshooting

- **`session.idle` doesn't fire**: This event only fires when the session is truly idle (after a turn fully ends). Continuous tool calls / active turns delay it indefinitely. Use the `reflect` tool to trigger manually.
- **Code changes not taking effect**: Plugins load once at startup; you must restart OpenCode after modifying `src/`. Changes to `~/.opencode/memx.config.json` take effect immediately (read at each refinement).
- **Refinement model**: Default `opencode/mimo-v2.6-flash-free` (the production target — production opencode has no `opencode-go` provider). Local dev overrides it to `opencode-go/longcat-2.5-preview-free` via `~/.opencode/memx.config.json`, because the local free tier is gated (403 fingerprint check / 429 rate limit). DeepSeek official keys are invalid in this environment; don't configure `deepseek/*` models.
- **Logs**: Located at `~/.local/share/opencode/log/opencode.log`. Plugin `app.log` messages don't show the `service` field; search `level=ERROR` for errors, `Updated USER.md` or `Updated MEMORY.md` for successful writes.
- **LLM output debugging**: Each refinement logs `llm raw(N): ...` (400-char truncation) to verify the LLM's raw return is valid JSON.

## Development

```bash
pnpm install       # Install dependencies
pnpm test          # Run tests (baseline: 21 files / 319 tests, all green — anything less is a regression)
pnpm run typecheck # Type check
```

## License

MIT
