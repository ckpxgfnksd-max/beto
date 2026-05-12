# beto

The universal sidebar for AI agent sessions. Tells you which of your agents — across **Claude Code, Codex, Hermes, Goose, Kimi, OpenClaw, OpenHands, Aider** — actually needs you right now.

```
beto · 9 sessions (4C 2X 2H 1G) · 3 need you

▌Need · 3
 [1] ◉ Quasar        C · abandoned 8m
     asking whether to keep both auth migrations or squash
 [2] ◉ Nebula        X · escalated 2m
     confirming the dependency upgrade scope before continuing
 [3] ◉ Pulsar        H · awaiting 25s
     awaiting approval to delete the legacy /v1 endpoints

▌Active · 4
▶ [4] ● Rigel         X · working
     iterating on the failing integration test in payments-svc
 [5] ● Altair        G · working
     running MCP tool: file-search across the monorepo
 [6] ● Vega          C · working
     refactoring useAuth into a useSession context provider
 [7] ○ Lyra          C · idle
     finished planning; waiting for approval on PR description

▌Recent · 2
 [8] ✓ Cygnus        C · PR ready
     opened PR for the analytics-event schema migration
 [9] ✗ Orion         H · failed
     crashed: missing OPENAI_API_KEY in the test environment
```

## What this is

beto is a terminal sidebar that sits in a tmux/zellij/iTerm/Warp pane alongside your actual work and answers one question, repeatedly: **which of my running agents need me right now?** Across all of them, not just Claude.

Most observability tools answer "what did the agent do?" beto answers "should I interrupt what I'm doing?" — the only question that matters when you're orchestrating five or ten different agent sessions across different providers and trying to ship your own code at the same time.

Each row carries a **harness sigil** so you can see at a glance whether the blocked session is Claude (`C`), Codex (`X`), Hermes (`H`), Goose (`G`), or any other. The three-tier escalation ramp (awaiting → escalated → abandoned) is universal — it doesn't care which provider the agent comes from.

## What's wired today (v0.3)

- **Universal sidebar UI** — single TUI that adapts from ultra-compact (<50 cols) → sidebar (50–80 cols) → wide (≥80 cols) based on terminal width.
- **Harness-agnostic adapter pattern** — every provider plugs in behind a single `Adapter` interface; the store merges per-harness emissions into one flat list keyed by `<harness>:<sessionId>`.
- **Layered auto-detection** — PATH probe + version exec + XDG-aware state-dir probe + process scan, fused into a status spectrum. Cached at `~/.beto/cache/detection.json` with a 1h TTL + mtime invalidation. Run `beto doctor` for the full matrix.
- **Startup banner** — every launch prints one line: `beto detected: ○ Claude Code 2.1.x · ○ Codex · backends: ollama`.
- **Plugin manifest schema** — drop a `*.json` into `~/.beto/plugins/` and beto auto-registers an adapter on next launch. Five reference manifests ship in `manifests/` (Codex, Hermes, Goose, Aider, Open Interpreter).
- **Four built-in adapter kinds:** `directory-of-state-json` · `sqlite-sessions-table` (shells out to `sqlite3` CLI) · `jsonl-tail` · `process-watch-only`.
- **Built-in Claude adapter** — the canonical first-party harness with a working commander layer (dispatch / attach / reply via clipboard). Other harnesses are read-only via plugins for now.
- **Harness filter** — press `f` to cycle.

## Plugin manifests

Most harnesses load via JSON manifests, not hand-written TypeScript. Each manifest declares its identity, binary, and which of the four adapter kinds reads its state.

Example (`manifests/codex.json`):

```json
{
  "id": "codex",
  "displayName": "Codex",
  "sigil": "X",
  "color": "green",
  "binary": "codex",
  "pollMs": 2000,
  "readBudgetMs": 1500,
  "adapter": {
    "kind": "directory-of-state-json",
    "config": {
      "stateDirs": ["~/.codex/sessions", "~/.local/share/codex/sessions"],
      "fieldMap": {
        "sessionId": "id",
        "state": "status",
        "summary": "current_summary",
        "lastTransitionAt": "updated_at_ms"
      }
    }
  }
}
```

Drop your own into `~/.beto/plugins/`. User manifests override bundled ones with the same `id`.

### Adapter kinds

| Kind                       | When to use                                              | Required config              |
|----------------------------|----------------------------------------------------------|------------------------------|
| `directory-of-state-json`  | One `state.json` per session under one or more dirs     | `stateDirs[]`                |
| `sqlite-sessions-table`    | SQLite db with a sessions table (shells out to sqlite3) | `dbPath`, `table`, `fieldMap` |
| `jsonl-tail`               | One JSONL file per session; latest record = current state | `fileGlob`, `fieldMap`     |
| `process-watch-only`       | No state on disk; synthesize one row per running process | (none)                       |

Every kind supports an optional `readBudgetMs` (default 1500). If a single poll exceeds it, the adapter gives up and reuses the previous emission — the *open-with-timeouts* guarantee: a misbehaving plugin can't block the rest of the inbox.

### Reference manifests bundled

| Manifest               | Kind                       | Status              |
|------------------------|----------------------------|---------------------|
| `codex.json`           | `directory-of-state-json` | Best-effort fieldMap, needs verification on a real Codex install |
| `hermes.json`          | `sqlite-sessions-table`   | Best-effort schema, needs verification |
| `goose.json`           | `sqlite-sessions-table`   | Best-effort schema, needs verification |
| `aider.json`           | `process-watch-only`      | Works as-is (no schema to map)         |
| `open-interpreter.json`| `jsonl-tail`              | Best-effort fieldMap, needs verification |

Field maps may not match the real on-disk schemas exactly — see `manifests/README.md`. If you run one of these tools, a one-line `fieldMap` PR makes the adapter work for everyone.

## Roadmap

| Version | Status | Adds                                                                       |
|---------|--------|----------------------------------------------------------------------------|
| v0.2    | ✓      | Universal sidebar UI · adapter pattern · multi-harness mock              |
| v0.2.1  | ✓      | Layered auto-detection (PATH + state-dir + process scan) · `beto doctor` |
| v0.3 *(now)* | ✓ | Plugin manifest schema · 4 adapter kinds · 5 reference manifests          |
| v0.4    |        | Verified field-maps via real-install testing                              |
| v0.5    |        | Desktop notifications on `needs-input` transitions                        |
| v0.6+   |        | Per-harness commander layer (dispatch/attach/reply beyond Claude)         |
| v1.0    |        | macOS menubar UI · published to npm                                       |

After v0.3, growth is mostly community manifests — anyone can extend beto without forking.

## Install

```sh
# from source (today)
git clone https://github.com/ckpxgfnksd-max/beto
cd beto
bun install
bun link        # makes `beto` available globally
beto
```

```sh
# once published (soon)
bun add -g beto
beto
```

Requires Bun 1.0+ or Node 18+. macOS or Linux. Windows works for read-only inbox; the Claude commander layer (attach + reply) is macOS-only because it drives Terminal.app via osascript.

## Use

Launch `beto` in any terminal pane. It refreshes every two seconds from each enabled harness's state directory.

| Key      | What it does                                          |
|----------|-------------------------------------------------------|
| `1`–`9`  | Peek the Nth session in the list                      |
| `d`      | Dispatch a new Claude session (`claude --bg "<task>"`) |
| `a`      | (in peek) Attach: open Terminal — Claude only             |
| `r`      | (in peek) Reply via clipboard — Claude only               |
| `f`      | Cycle the harness filter (all → claude → codex → ...) |
| `Esc`    | Back / close overlay                                  |
| `q`      | Quit                                                  |

The `Need` band at the top of the inbox uses three escalation tiers, ramping color over time:

- **awaiting** (< 60s) — gold; fresh ask, you'll notice it naturally
- **escalated** (1–5m) — bright yellow; actively waiting on you
- **abandoned** (5m+) — red; demands intervention

These tiers are harness-agnostic. A blocked Codex session counts the same as a blocked Claude session.

## Three layout modes

beto reads `process.stdout.columns` and picks the densest layout that fits:

| Width   | Mode             | What changes                                                   |
|---------|------------------|----------------------------------------------------------------|
| < 50    | ultra-compact    | Single-line rows; summary dropped; harness tally hidden        |
| 50–80   | sidebar          | 2-line rows with summary truncated to width                    |
| ≥ 80    | wide             | Full row chrome: role glyph, cwd tail, PR badge, harness sigil |

This is automatic. Open beto in a 100-column pane and you get the wide view; resize it down to 55 and you get sidebar mode without restarting. Put it in a 45-column zellij sidepane and it becomes the dense ultra-compact form.

## Try it without real sessions

beto ships with a multi-harness mock seeder and a preview script that renders all three widths in one command:

```sh
bun scripts/seed-mock-jobs.ts        # writes .tmp/jobs-<harness>/ for 4 harnesses
bun scripts/preview-frame.tsx        # renders at 45, 65, and 100 cols
```

You'll see Claude, Codex, Hermes, and Goose sessions intermixed across all three escalation tiers, with the harness tally (`4C 2X 2H 1G`) in the header.

To run beto interactively against the mock data:

```sh
bun src/cli.tsx --mock-dir "$(pwd)/.tmp"
```

## Configuration

`~/.beto/config.json` is written on first run via auto-detect. Schema:

```json
{
  "version": 1,
  "harnesses": {
    "claude":    { "enabled": true,  "path": "~/.claude/jobs" },
    "codex":     { "enabled": true },
    "hermes":    { "enabled": false },
    "goose":     { "enabled": false },
    "kimi":      { "enabled": false },
    "openclaw":  { "enabled": false },
    "openhands": { "enabled": false },
    "aider":     { "enabled": false }
  }
}
```

`enabled: true` for a non-Claude harness in v0.2 is a *reservation* — the slot is acknowledged but no adapter reads it yet. v0.3+ wires the real implementations.

## Lineage

beto is the inbox half of the original [aggro](https://github.com/ckpxgfnksd-max/aggro) raid HUD split, focused on observation. Sibling fork [cello](https://github.com/ckpxgfnksd-max/cello) (private, frozen) reserves the multi-harness *director* surface — dispatch-and-orchestrate.

The data plumbing (state.json parser, escalation tiers, three-source precedence rules) ports from aggro's Rust/TypeScript stack into beto's pure TypeScript surface. The adapter pattern in v0.2 generalizes that plumbing across providers.

## Contributing

beto is small and tightly scoped. v0.2 is ~1.5k lines. Issues and PRs welcome at [github.com/ckpxgfnksd-max/beto](https://github.com/ckpxgfnksd-max/beto). High-leverage v0.3 contributions:

- **Codex adapter** — `~/.codex/state_5.sqlite` reader + JSONL event stream tail. Requires zstd handling.
- **Hermes adapter** — `~/.hermes/state.db` SQLite read with the explicit approval-blocked state mapping.
- **Goose adapter** — `<data_dir>/sessions/sessions.db` SQLite.
- **Notification surface** — macOS `osascript display notification` on `needs-input` transitions, dismissable.

## License

MIT.
