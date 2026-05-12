# beto

A terminal inbox for the moments when one of your Claude Code sessions actually needs you.

```
beto · 6 sessions · 3 need you

▌ Needs you (3)
▶ [1] ◉ Quasar  (⚔ EXE) · blocked 8m 4s · abandoned
     asking whether to keep both auth migrations or squash
     ~/checkout-redo
  [2] ◉ Nebula  (◈ PLN) · blocked 2m 11s · escalated
     confirming the dependency upgrade scope before continuing
     ~/api-gateway
  [3] ◉ Pulsar  (◇ VAL) · blocked 25s · awaiting
     awaiting approval to delete the legacy /v1 endpoints
     ~/api-gateway

▌ Active (2)
  [4] ● Vega    (✦ RSR) · working
     refactoring useAuth into a useSession context provider
     ~/web
  [5] ● Rigel   (⚔ EXE) · working
     iterating on the failing integration test in payments-svc
     ~/payments-svc

▌ Recent (1)
  [6] ✓ Cygnus  (◇ VAL) · PR ready  ✓ CI
     opened PR for the analytics-event schema migration
     ~/analytics · https://github.com/.../pull/142

[1-9] peek  [d] dispatch  [q] quit
```

## What this is

beto answers one question, repeatedly, at a glance: **which of my running Claude Code sessions need me right now?**

Most observability tools answer "what did the agent do?" beto answers "should I interrupt what I'm doing?" — the only question you have when you're running 1–10 agents in parallel and trying to get your own work done at the same time.

When something is blocked, it surfaces. When it's been blocked for a while, it surfaces louder (gold → bright → red). When nothing needs you, beto is quiet.

## What it's not

- **Not a replacement for `claude agents`.** `claude agents` is the canonical Anthropic TUI; if you want a full session table inside `claude` itself, that's the answer. beto is a separate window you keep open while doing other work, and it lifts one thing — the *needs-you* channel — above the noise.
- **Not a trace tool.** It doesn't replay token-by-token, doesn't chart prompt costs, doesn't graph time-to-completion. Use LangSmith / Langfuse / Phoenix for that.
- **Not a HUD.** beto's older sibling [aggro](https://github.com/ckpxgfnksd-max/aggro) is the full WoW-raid HUD; that's preserved over there. beto is the calm version: a terminal you glance at, never a window competing for your screen.

## How it works

beto reads `~/.claude/jobs/<id>/state.json` files. Those are the same files Anthropic's own `claude agents` reads — the supervisor's per-session ground truth. Every session you've ever dispatched with `claude --bg "<prompt>"` (or that another tool dispatched on your behalf) shows up here.

Because beto only reads what's already on disk, **there is no installation step**. No hooks to patch into `~/.claude/settings.json`, no background daemon, no permission prompts. Run `beto` and it sees your sessions; quit `beto` and your sessions don't notice.

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

Requires Bun 1.0+ or Node 18+. macOS or Linux. Windows works for read-only inbox; attach + reply are macOS-only (they drive Terminal.app via osascript).

## Use

Launch `beto` in any terminal window. It refreshes every two seconds from `~/.claude/jobs/`.

| Key      | What it does                                          |
|----------|-------------------------------------------------------|
| `1`–`9`  | Peek the Nth session in the list                      |
| `d`      | Dispatch a new session (`claude --bg "<task>"`)       |
| `a`      | (in peek) Attach: open Terminal at `claude attach <id>` |
| `r`      | (in peek) Reply: pbcopy + paste into a fresh attach   |
| `Esc`    | Back / close overlay                                  |
| `q`      | Quit                                                  |

The `needs-you` band at the top of the inbox uses three escalation tiers, ramping color over time:

- **awaiting** (< 60s) — gold; fresh ask, you'll notice it naturally
- **escalated** (1–5m) — bright yellow; actively waiting on you
- **abandoned** (5m+) — red; demands intervention

Everything else (working, completed, failed) is below in calmer colors.

## Try it without real sessions

beto ships with a mock-data seeder so you can see every UI state without dispatching a single `claude --bg`:

```sh
bun scripts/seed-mock-jobs.ts                  # writes 8 fake state.json files to ./.tmp/jobs
bun src/cli.tsx --jobs-dir "$(pwd)/.tmp/jobs"  # run beto against the seed
```

You'll see all three escalation tiers, an active session, an idle one, a PR-ready one, and a failed one.

## Roadmap

v0.1 (today) — what you're reading. Inbox + peek + dispatch + attach + reply against the state.json source.

v0.2 — desktop notification on `needs-input` transitions (macOS first via `osascript display notification`, then Linux). One alert per real event, dismissable.

v0.3 — hooks-layer enrichment. Optional install of Claude Code hooks (`PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`) to add per-tool cast bars and tool-call counts to the peek view. Three-source precedence (state.json + hooks + transcript) ported from [aggro](https://github.com/ckpxgfnksd-max/aggro)'s engine.

v0.4 — searchable history. The "what did session X actually do?" question. Replay last N tool calls per session from the transcript JSONL.

## Lineage

beto is the inbox half of [aggro](https://github.com/ckpxgfnksd-max/aggro)'s split. aggro answers "show me everything in a graphical raid frame"; beto answers "tell me what needs me." Sibling fork [cello](https://github.com/ckpxgfnksd-max/cello) explores the multi-harness director angle.

The data plumbing — state.json schema parser, three-source precedence rules, needs-input escalation tiers — ports directly from aggro's Rust/TypeScript stack into beto's pure TypeScript surface.

## Contributing

beto is intentionally small. v0.1 is ~1k lines of TypeScript. Issues and PRs welcome at [github.com/ckpxgfnksd-max/beto](https://github.com/ckpxgfnksd-max/beto). The first three contribution-friendly issues:

- `beto --watch-notify` flag (chokidar/notify upgrade from the 2s poll)
- Desktop notification on `needs-input` transition (macOS via osascript)
- Reply over real IPC once Anthropic exposes one, dropping the pbcopy hack

## License

MIT.
