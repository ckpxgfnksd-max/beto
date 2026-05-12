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

## What's wired today (v0.2)

- **Universal sidebar UI** — single TUI that adapts from ultra-compact (<50 cols) → sidebar (50–80 cols) → wide (≥80 cols) based on terminal width. Drop beto into any pane and it fits.
- **Harness-agnostic adapter pattern** — every provider plugs in behind a single `Adapter` interface; the store merges per-harness emissions into one flat list keyed by `<harness>:<sessionId>`.
- **Claude Code adapter** — reads `~/.claude/jobs/<id>/state.json` directly. Same source `claude agents` reads. Zero install.
- **MockAdapter** — synthetic adapter that wraps any directory of state-shaped JSON. Used by the seeder/preview to demo multi-harness rendering without any real harness installed.
- **Config + auto-detect** — `~/.beto/config.json` auto-detects which harnesses are installed (`~/.claude/`, `~/.codex/`, `~/.hermes/`, `~/.openclaw/`, ...) and enables their slot. Edit the JSON to override.
- **Harness filter** — press `f` to cycle (all → claude → codex → hermes → ...). The header shows the active filter; the buckets recount.
- **Commander layer (Claude only in v0.2)** — dispatch / attach / reply against Claude sessions. Other harnesses' adapter slots are reserved but read-only until v0.3.

## Roadmap

| Version | Adds                                                                       |
|---------|----------------------------------------------------------------------------|
| v0.2 *(now)* | Universal sidebar UI · adapter pattern · Claude adapter · mock multi-harness |
| v0.3    | First real second adapter (Codex CLI: `~/.codex/state_5.sqlite` + JSONL streams) |
| v0.4    | Hermes Agent adapter (`~/.hermes/state.db` SQLite, explicit approval-blocked state) |
| v0.5    | Goose adapter (Block / AAIF) · OpenHands adapter                          |
| v0.6+   | OpenClaw adapter (once on-disk schema is published)                       |
| later   | Kimi (cloud-backed, needs daemon) · Aider (per-repo workspace scan)       |

The order is driven by *what's disk-readable from a public schema*. Adapters whose underlying CLI doesn't write per-session state (Kimi is cloud-backed; Aider only logs per-repo) wait until they do or until the daemon design is in place.

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
| `a`      | (in peek) Attach: open Terminal — Claude only in v0.2 |
| `r`      | (in peek) Reply via clipboard — Claude only in v0.2   |
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
