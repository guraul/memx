# memx

**[English](README.md)** | [中文](README_zh.md)

OpenCode V2 dual-track memory plugin, with an in-repo DSH (DeepSeek Harness) host shell. Automatically extracts cross-session user preferences (Track 1) and project context (Track 2) from conversation history, persisting to `~/.opencode/USER.md` and `~/.opencode/projects/<slug>/.mem/*.md` respectively.

## Design Philosophy

`memx` is built on a core insight: **user style and project memory are fundamentally different types of memory**.

- **Track 1 (User Style)**: Cross-project slow-changing profile (communication style, toolchain preferences, technical taste). Single `USER.md` file, four categories, 200-line compression. Main AI marks signals via `STYLE_SIGNAL` HTML comments; sub-AI batches refinement.
- **Track 2 (Project Memory)**: Project-bound fast-changing log (ongoing work, external resources, collaboration guidance). `MEMORY.md` index + standalone `.mem/*.md` files (with frontmatter; feedback/project types require Why + How to apply). Main AI marks signals via `MEMORY_SIGNAL` HTML comments; sub-AI batches refinement.

Both tracks share the same host-agnostic pipeline (`src/core/pipeline/session.ts`) but have completely independent signal buffers, refinement prompts, and write targets. Two host shells consume that pipeline: `src/hosts/opencode/` (installed by `install.sh`) and `src/hosts/dsh/` (wired into DSH by the companion `dsh-plugin-memx` shell package — see [Hosts](#hosts)).

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
| **Plugin injects its own system prompt** | The OpenCode shell appends `memx-protocol.md` + `USER.md` + `MEMORY.md` to `event.system` in its `context` hook. Each is its own `SystemPart`, order: protocol → profile → index. The DSH shell registers one `systemPrompt.section` instead (protocol + profile + the **current project's** index section, computed once per session). Both cap each source at 200 lines / 25KB, and truncation appends a visible `[memx: truncated — ...]` line so nothing is dropped silently. The `instructions` entries in `opencode.json` are **inert on v2.0.26** (the host only assembles instructions from `AGENTS.md`) and are kept only for forward compatibility |
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

OpenCode shell (the DSH shell uses `turn/end` instead — see [Hosts](#hosts)):

- `session.execution.succeeded`: Fires after every turn (v2 does **not** emit `session.idle`). Captures signals incrementally and refines (throttled by `throttleMinutes`).
- `session.deleted`: Drops that session's capture cursor. Exit (`dispose`): force-flushes the buffers and persists diagnostics.
- `reflect` tool: Manually triggers full refinement (skips throttle). Runs both Track 1 and Track 2. Fallback when the event trigger is throttled or doesn't fire.
- Plugin auto-skips its own refinement sub-sessions; refinement is mutex-serialized (`SessionPipeline.inFlight`, shared by both hosts) to prevent concurrent storms and duplicate writes.

## Correctness guarantees (stage 3 P0 fixes)

- **Incremental capture**: every turn is scanned, not just the last one. A per-session cursor anchored on the **message id** lives in `ctx.storage` (`cursor:<sessionID>`); if the anchor is gone (context compaction/fork) it falls back to a full rescan, deduped by signal `evidence`, and records a warn alert.
- **Three-state refinement**: `proposals` / `adjudicated-empty` / `invalid-output`. "Nothing worth saving" clears the buffer; malformed LLM output keeps it for a retry, and 3 consecutive bad outputs drop it with an alert instead of looping forever.
- **Single-pass write + content anchors**: a batch is parsed once, applied in memory, serialized once (no intra-batch line drift). `update`/`deprecate` locate their target by copying the entry text (`target_text`: exact → normalized → unique containment → line number as last resort); every downgrade or miss is reported.
- **Cross-process lock**: `USER.md` / `MEMORY.md` read-modify-write runs under a lock file with mtime TTL (`~/.opencode/.*.lock`), and the file is re-read inside the lock. The LLM call is never inside the lock.
- **Health logs never enter `MEMORY.md`**: autofix results go to `ctx.storage` diagnostics / alerts; the index stays a pure index.

## Hosts

`src/core/` is host-agnostic; each host has a thin shell in `src/hosts/`. Both shells share the same data directory (`~/.opencode/`), the same file lock, and the same write path — a project slug means the same memory in either host.

| | OpenCode v2 | DSH (DeepSeek Harness) |
| :--- | :--- | :--- |
| Status | ✅ Installed by `install.sh` | ✅ Installed via the `dsh-plugin-memx` shell package (separate repo) |
| Injection | `context` hook **appends 3 `SystemPart`s every model step** (protocol → profile → full `MEMORY.md`) | One `systemPrompt.section` (`order: 12000`) **computed once per session** (protocol + profile + **current project's section only**) |
| Tools | `reflect` / `memory_write` / `forget` / `memx_status` | `memory_write` / `memory_search` / `forget` |
| Refinement LLM | Child session via `session.prompt` | One-shot `ctx.llm.stream` call (no child session) |
| Auto-capture | `session.execution.succeeded` + per-session cursor | `turn/end` event + per-session throttle (no cursor) |
| Diagnostics | `ctx.storage` kv + `pnpm run doctor` | In-memory `DshDiagnostics` + host log `[memx] …` (no diagnostics panel; Settings → 记忆 is config only) |
| Sync | ✅ Wired (3 push triggers) | ❌ Not wired yet |
| Config | `~/.opencode/memx.config.json` | Cordis config (Settings → 记忆, or profile patch) |

### DSH host (DeepSeek Harness)

The DSH adapter targets the Cordis plugin model: named exports (`name` / `inject` / `Config` / `apply`), `ctx.systemPrompt.section`, `ctx.tools.register`, and `ctx.llm.stream`. It imports **no `@deepseek-ai/*` package** — the minimal host types are hand-written in `src/hosts/dsh/types.ts`, so memx never pins a DSH version.

> **Status: supported and in use.** `src/hosts/dsh/` cannot be `dsh plugin add`-ed directly, so a companion shell package **`dsh-plugin-memx`** (separate repo, not vendored here) does the wiring: it registers the plugin into the DSH web profile, declares the four `.volatile()` config fields, and ships the Web settings page **Settings → 记忆**. It loads this repo's `src/hosts/dsh/index.ts` through a TypeScript transform hook, so memx changes only need a `dsh web` restart (no shell rebuild).

Install the shell package into a DSH profile, then restart `dsh web`:

```bash
dsh plugin --profile web add /path/to/dsh-plugin-memx   # pnpm link into the web profile
```

Configuration lives in **Settings → 记忆** (or the profile's `cordis.patch.yml`, under `id: memx`). The four fields are read at every turn end, so changes apply without a restart. ⚠️ The shell hardcodes the memx checkout path (`MEMX_ROOT` in `dsh-plugin-memx/lib/index.js`); if you move or re-clone the repo, update that constant or DSH keeps loading the old checkout.

What it does:

- **Injection**: protocol + profile + the **current project's** `MEMORY.md` section, injected as one system-prompt section. It is computed **once per session** (constant bytes keep the host's prompt cache warm) — a memory written in this session becomes visible in the **next** one.
- **Tools**: `memory_write` / `memory_search` / `forget`, all through the same core write path and file lock as OpenCode. `memory_search` is DSH-only (case-insensitive full-text search across `.mem/*.md`, returns `slug/file:line`).
- **Turn-end recall**: after `turn/end`, memx scans that turn's assistant text for `MEMORY_SIGNAL` and refines through `ctx.llm.stream`, throttled per session. Skipped when `autoRefine: false`, when the turn already wrote via a tool, when there are no signals, or when no model route can be resolved (it never guesses a provider). Track 1 style signals are not auto-captured on DSH — use `memory_write`.

Configuration (cordis fields, declared `.volatile()` by the shell package; edit in Settings → 记忆 or the profile patch; read at every turn end):

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `provider` | `""` | Refinement provider; empty = follow the current session's model |
| `model` | `""` | Refinement model; empty = follow the current session's model |
| `autoRefine` | `true` | Turn-end recall on/off (`false` does not affect explicit `memory_write`) |
| `throttleMinutes` | `10` | Per-session refinement throttle (1–1440) |

Known gaps (deliberate, not bugs): the `inject.*` gate is OpenCode-only; `turn/end` does not filter `reason` yet (aborted turns still enter the recall check, but only fire when signals exist); cloud sync is not wired; there is no `memx_status` / doctor panel — diagnostics live in memory and in the host log (`[memx] …`). `~/.opencode/memx.config.json`'s `refinementModel` does **not** apply to DSH; the route comes from the fields above or from the session model.

## Installation

### Quick Install

```bash
git clone https://github.com/guraul/memx.git
cd memx
bash install.sh
```

This clones the repo to `~/workspace/memx` (override with `bash install.sh <path>`), installs pnpm dependencies, creates the plugin entry, declares dependencies, writes the signal protocol file `~/.opencode/memx-protocol.md`, and adds the `instructions` entries in `opencode.json` (forward-compatibility only — see below). Then restart OpenCode and check `/status`. **`install.sh` only wires the OpenCode host** — for DSH, install the `dsh-plugin-memx` shell package instead (see [Hosts](#hosts)).

> **The signal protocol moved out of `USER.md` into a standalone file.** Its text now lives only in `src/core/protocol-template.ts`, is written by `scripts/sync-protocol.ts`, and is injected by the **plugin's own `context` hook**. Do **not** hand-write the protocol block into `~/.opencode/USER.md` — that file is memx's data file and gets rewritten on every refinement, which silently wipes the protocol (it did, once).

> **How content actually reaches the model.** The OpenCode shell registers a `session.hook("context", …)` and **appends** three `SystemPart`s to the system prompt the host already assembled (`agent.system` + the merged `AGENTS.md` body). Order: `memx-protocol.md` (how to emit signals) → `USER.md` (Track 1 profile) → `MEMORY.md` (Track 2 index). Missing files are skipped silently; if all three are missing the hook does nothing. A refinement **child session is never injected into** — that branch still replaces the whole system prompt and pins temperature 0.2. (The DSH shell registers one `systemPrompt.section` instead — see [Hosts](#hosts).)
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

Availability: `reflect` and `memx_status` exist **only on OpenCode**; `memory_search` exists **only on DSH**; `memory_write` and `forget` exist on **both** hosts.

### `reflect`
Manually triggers style + project memory refinement (fallback when the event trigger is throttled or didn't fire).

### `forget`
`forget(keyword)` moves matching `.mem/*.md` files to `.trash/` and removes their index entries. On DSH it also takes an optional `slug`; on OpenCode it always uses the current session's slug. A successful `forget` triggers a sync push (deletions are propagated).

### `memory_write`
Explicitly record one project-scoped memory (this is what a companion agent calls when the user says
"remember this"). Arguments: `text` (required, ≤500 chars), `type` (`user|feedback|project|reference`,
default `project`), `name`, `description`, `why`, `how_to_apply`, `evidence`. Same type + name with
**equivalent content** is treated as a revision (update), not a duplicate; same name with *different*
content forks a new card `<name>--<content hash>.md` and keeps the old one (`same_name_as` /
`**Superseded by:**`), so nothing is overwritten silently. It writes through the same single-pass +
file-lock path as the refinement pipeline, so the two can never disagree about the file format.

### `memory_search`
DSH only. `memory_search(keyword, slug?)` does a case-insensitive full-text search across `projects/<slug>/.mem/*.md` and returns up to 20 hits as `slug/file:line — <line>`. The slug defaults to the session's working directory; when it cannot be derived the search falls back to the whole library (read-only, at worst a few extra hits). It searches the union of indexed slugs and on-disk `.mem/` dirs, so orphan files are still findable.

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
(restart OpenCode after changing). Push fires after each successful memory write (refinement write, `memory_write`, `forget`); pull runs at startup + every `intervalMinutes`.
`pnpm sync:dry-run` previews what would sync (read-only, never pushes); add `-- --fetch` to align the cache
workdir with the remote first — use that mode before the *first* pull on a new machine, otherwise the report
can only say "remote not fetched". `pnpm sync:op -- status|pull|push` runs a single manual sync through the
same code path as the plugin; `--machine=<name>` forces `{enabled: true, machineName: <name>}` **without touching
the config file** — that's how a machine does its first push/pull before sync is switched on. Pull is remote-wins: before overwriting a local file whose content differs,
the local copy is saved as `<file>.bak.<ts>` (5 kept per file). `pnpm sync:op pii` is a read-only PII
self-check that lists the hits as file / line / rule name only. A PII gate (8 rule types) blocks any push
containing tokens/keys — hits are reported as file+line+rule only, never echoed. Push first counts
`git rev-list --count @{u}..HEAD`, so unpushed commits are pushed even when no file content changed
(commits accumulated while offline no longer get stranded); that count is stored and shown by `doctor` /
`sync:op status`. Delete propagation is implemented: a `forget` deletion is pushed (the push baseline is the last synced remote sha), and a deletion made on another machine is applied locally after saving the local copy as `<file>.bak.<ts>` — when the baseline is unknown (first sync / old state) memx conservatively deletes nothing for that round. Deliberately not in v1:
per-line merge (same file edited on both machines relies on git rebase, which aborts to
manual on conflict), pull-vs-write locking (the `.bak` copy is the safety net there; sync ops are serialized against each other by `.memx-sync.lock`). The DSH shell does not trigger sync yet.

## Troubleshooting

- **Trigger doesn't fire / refinement looks stuck**: opencode v2 does **not** emit `session.idle`; memx hooks `session.execution.succeeded` and throttles refinements (`throttleMinutes`, default 10). Use the `reflect` tool to force a run.
- **DSH: no `memx_status` / doctor panel**: that's expected — DSH diagnostics live in memory only and are lost on restart. Search the host log for `[memx]`; the `skipped.*` counters (`disabled` / `duplicate` / `written` / `empty` / `throttle` / `noModel`) explain why a turn-end recall did not run.
- **DSH: a memory written just now isn't visible**: injection is computed once per session by design; it shows up in the next session. This is not data loss — the file is already on disk.
- **Code changes not taking effect**: Plugins load once at startup; you must restart OpenCode (or `dsh web`) after modifying `src/`. Changes to `~/.opencode/memx.config.json` take effect immediately (read at each refinement; OpenCode's `sync` section is the exception — restart).
- **Refinement model**: Default `opencode/mimo-v2.6-flash-free` (the production target — production opencode has no `opencode-go` provider). Local dev overrides it to `opencode-go/longcat-2.5-preview-free` via `~/.opencode/memx.config.json`, because the local free tier is gated (403 fingerprint check / 429 rate limit). DeepSeek official keys are invalid in this environment; don't configure `deepseek/*` models.
- **Logs**: Located at `~/.local/share/opencode/log/opencode.log`. Plugin `app.log` messages don't show the `service` field; search `level=ERROR` for errors, `Updated USER.md` or `Updated MEMORY.md` for successful writes.
- **LLM output debugging**: Each refinement logs `llm raw(N): ...` (400-char truncation) to verify the LLM's raw return is valid JSON.

## Development

```bash
pnpm install       # Install dependencies
pnpm test          # Run tests (baseline: 26 files / 416 tests, all green — anything less is a regression)
pnpm run typecheck # Type check
```

## License

MIT
