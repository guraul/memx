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
| **OpenCode V2 Plugin API** | Hook system + `instructions` loading | `event` / `tool.reflect` / `dispose` + auto-injection via `instructions` field |
| **Zod** | Runtime Schema Validation | All LLM returns are runtime-validated to prevent JSON Mode drift |

### Key Design Decisions

| Decision | Rationale |
| :--- | :--- |
| **Main AI emits HTML comment markers** | Main AI has full conversation context, far better at identifying preferences than regex. Users don't see comments; plugin parses them. |
| **Sub-AI batch refinement** | Dedup, conflict detection, schema validation done by Stage 2 sub-session LLM; main AI only identifies signals |
| **Auto-write + backup** | No human confirmation; auto-backup before every write, keeping latest 5 versions |
| **`instructions` loading** | Host auto-injects `USER.md` + `MEMORY.md` + `memx-protocol.md` into main AI's system prompt at session start via `~/.config/opencode/opencode.json`. First two = accumulated data, third = the protocol that tells the AI how to emit signals |
| **Project isolation** | Track 2's `.mem/` dir is isolated by working directory slug (`/root/project/foo` -> `root-project-foo`); cross-project memories don't pollute |

## Dual-Track Pipeline

```
[Signal Capture]                  ->    [Batch Refinement + Persistence]
 session.idle / reflect                   session.idle / reflect
      │                                       │
 Track 1: STYLE_SIGNAL HTML comments      Track 1: LLM dialectical refinement
 Track 2: MEMORY_SIGNAL HTML comments    + USER.md diff + incremental patch
      │                                       │
 in-memory buffer (max 20, dedup by       Track 2: LLM dialectical refinement
  evidence)                               + MEMORY.md diff
      │                                       + .mem/*.md write
      ↓                                       ↓
 app.log diagnostics + clear buffer      USER.md + MEMORY.md auto-backup
```

## Trigger Mechanism

- `session.idle`: Fires when session is truly idle (after a turn fully ends). Auto-captures signals and refines (throttled by `throttleMinutes`).
- `session.deleted` / exit (`dispose`): Force-flushes buffer without fetching session history.
- `reflect` tool: Manually triggers full refinement (fetches last turn + skips throttle). Runs both Track 1 and Track 2. Fallback when `session.idle` doesn't fire.
- Plugin auto-skips its own refinement sub-sessions; refinement is mutex-serialized (`refinementInFlight`) to prevent concurrent storms and duplicate writes.

## Installation

### Quick Install

```bash
git clone https://github.com/guraul/memx.git
cd memx
bash install.sh
```

This clones the repo to `~/.config/memx`, installs npm dependencies, creates the plugin entry, declares dependencies, writes the signal protocol file `~/.opencode/memx-protocol.md`, and configures `instructions` in `opencode.json`. Then just restart OpenCode and `/status` to verify.

> **The signal protocol moved out of `USER.md` into a standalone file.** Its text now lives only in `src/core/protocol-template.ts`, is written by `scripts/sync-protocol.ts`, and is injected via `instructions`. Do **not** hand-write the protocol block into `~/.opencode/USER.md` — that file is memx's data file and gets rewritten on every refinement, which silently wipes the protocol (it did, once).

### Manual Install

If you prefer to do it step by step:

1. Clone the repo:
   ```bash
   git clone https://github.com/guraul/memx.git /path/to/memx
   cd /path/to/memx
   npm install
   ```

2. Create global plugin entry (pointing to src/index.ts):
   ```bash
   mkdir -p ~/.config/opencode/plugins
   echo 'export { MemxPlugin } from "/path/to/memx/src/index";' > ~/.config/opencode/plugins/memx.ts
   ```

3. Declare dependencies (if `~/.config/opencode/package.json` doesn't exist):
   ```json
   { "dependencies": { "zod": "^4.4.3", "@opencode-ai/plugin": "^1.18.11" } }
   ```

4. Write the signal protocol file (single source of truth is `src/core/protocol-template.ts`; never hand-edit the output):
   ```bash
   node scripts/sync-protocol.ts ~/.opencode/memx-protocol.md   # idempotent: no rewrite when identical
   ```

5. Add an `instructions` field to `~/.config/opencode/opencode.json` so both the accumulated data (USER.md + MEMORY.md) and the signal protocol are injected into the main AI's system prompt:
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
   If you already have other config, just merge the `instructions` field (`install.sh` adds any missing entries idempotently and leaves every other key alone).

6. Make sure your reply rendering strips HTML comments — otherwise users see raw `<!-- STYLE_SIGNAL: ... -->` text.

7. Restart OpenCode; `/status` should show `memx`.

### Configuration

Customize via `~/.opencode/memx.config.json`:

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `refinementModel` | `string` | `opencode/mimo-v2.6-flash-free` | Refinement model (`provider/model` format) |
| `maxSignalsPerSession` | `number` | `20` | Signal buffer max size |
| `autoBackupCount` | `number` | `5` | Backup retention count |
| `throttleMinutes` | `number` | `10` | Refinement throttle interval (minutes) |

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
Manually triggers style + project memory refinement (use when `session.idle` doesn't fire).

## Troubleshooting

- **`session.idle` doesn't fire**: This event only fires when the session is truly idle (after a turn fully ends). Continuous tool calls / active turns delay it indefinitely. Use the `reflect` tool to trigger manually.
- **Code changes not taking effect**: Plugins load once at startup; you must restart OpenCode after modifying `src/`. Changes to `~/.opencode/memx.config.json` take effect immediately (read at each refinement).
- **Refinement model**: Default `opencode/mimo-v2.6-flash-free` (built-in free model, no API key needed). DeepSeek official keys are invalid in this environment; don't configure `deepseek/*` models.
- **Logs**: Located at `~/.local/share/opencode/log/opencode.log`. Plugin `app.log` messages don't show the `service` field; search `level=ERROR` for errors, `Updated USER.md` or `Updated MEMORY.md` for successful writes.
- **LLM output debugging**: Each refinement logs `llm raw(N): ...` (400-char truncation) to verify the LLM's raw return is valid JSON.

## Development

```bash
npm install       # Install dependencies
npm test          # Run tests
npm run typecheck # Type check
```

## License

MIT
