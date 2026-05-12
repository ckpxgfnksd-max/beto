
# beto

**Your most expensive resource is attention. Stuck agents waste it.**

You launch a Claude Code session, switch to another window, come back twenty minutes later and find the agent stalled five minutes in — silently waiting on a question you'd have answered in seconds. Multiply by ten parallel sessions across Claude, Codex, OpenCode, and the rest. Most of your "agent productivity" is actually you context-switching to discover blocked agents.

**beto is the inbox that surfaces stuck agents before you go looking.** Live in the macOS menubar or a terminal pane; one glance shows you which sessions need you right now, color-coded by how long they've been waiting.

```
beto · 8 sessions · 3 need you

▌ Need (3)
  [1] ◉ Quasar   C · abandoned 8m        ← red, 5m+
  [2] ◉ Nebula   X · escalated 3m        ← bright yellow, 1–5m
  [3] ◉ Pulsar   H · awaiting 25s        ← gold, <60s

▌ Active (2)
  [4] ● Vega     C · working · 38 tps
  [5] ● Rigel    X · working · 27 tps

▌ Recent (2)
  [6] ✓ Cygnus   C · PR ready
  [7] ✗ Orion    H · failed
```

The three-tier escalation ramp is **universal across every harness** beto supports. A blocked Codex session counts the same as a blocked Claude session.

## How beto compares

| | beto | [abtop](https://github.com/graykode/abtop) |
|--|------|------|
| **Surface** | Inbox metaphor + 3-tier escalation · TUI + macOS menubar + OS notification | htop-style dashboard · TUI only |
| **Harness model** | [Plugin-manifest spec](manifest-spec.md) — any harness via one JSON file | Hardcoded — Claude / Codex / OpenCode only |
| **Verification** | Manifests checked against real installs; fixture-snapshot CI; [zero-write proof](../test/zero-write.test.ts) | Read-only by stated posture |

Both projects are zero-install on the agent host. The choice is between the **stuck-agent inbox** (beto) and the **everything-dashboard** (abtop). They're not mutually exclusive — many users run both.

## Install

```sh
curl -fsSL https://github.com/ckpxgfnksd-max/beto/raw/main/scripts/install.sh | sh
```

Detects your platform, downloads the matching binary from the latest GitHub Release, verifies SHA-256, installs to `/usr/local/bin/beto` (falls back to `~/.local/bin`). No Bun required. Supported: macOS arm64 / macOS x64 / Linux x64.

Already have a JS runtime? `npm i -g beto-tui` or `bun add -g beto-tui` work too — the binary still installs as `beto` (the npm name is suffixed because `beto` was already taken on the registry).

## Use

```sh
beto                       # TUI inbox in the current terminal
beto bar                   # one SwiftBar snapshot → stdout
beto doctor                # what harnesses are installed + detected?
```

| Key | Action |
|-----|--------|
| `1`–`9` | Peek the Nth session |
| `d` | Dispatch a new Claude session |
| `a` / `r` | Attach / reply (Claude only, macOS) |
| `f` | Cycle the harness filter |
| `q` | Quit |

## macOS menubar

`beto bar` is a [SwiftBar](https://swiftbar.app)-compatible plugin. One-time setup:

```sh
brew install --cask swiftbar
ln -s "$(which beto | xargs dirname)/../share/beto/bin/beto.30s.sh" \
      ~/Library/Application\ Support/SwiftBar/Plugins/beto.30s.sh
```

A live status item appears at the top of your screen, refreshing every 30s. Title color escalates: gray → orange (awaiting) → red (abandoned). Click any row to drop into the full beto inbox. Full setup notes: [docs/setup-swiftbar.md](setup-swiftbar.md).

## Harness support

| Harness | Status | How |
|---------|--------|-----|
| Claude Code | verified | built-in adapter, no manifest needed |
| Codex (OpenAI CLI) | verified | [`manifests/codex.json`](../manifests/codex.json) — `jsonl-index` |
| OpenCode (`opencode-ai`) | verified | [`manifests/opencode.json`](../manifests/opencode.json) — `sqlite-sessions-table` |
| Hermes · Goose · Aider · Open Interpreter | experimental | [`manifests/experimental/`](../manifests/experimental/), opt-in via `~/.beto/plugins/` |
| Your harness | one JSON file | [docs/manifest-spec.md](manifest-spec.md) |

Pick from five adapter kinds — `directory-of-state-json`, `sqlite-sessions-table`, `jsonl-tail`, `jsonl-index`, `process-watch-only` — point at your harness's data dir, map its field names. PRs to `manifests/experimental/*.json` welcomed.

## Read-only invariant

beto never writes inside any harness directory. **Verified in CI:** [`test/zero-write.test.ts`](../test/zero-write.test.ts) fingerprints every harness data dir, runs each adapter for 4.5s, and fails the build on a single byte of change. Covers all five adapter kinds.

No hooks. No `settings.json` mutation. No daemon inside the harness's process tree. The trade-off is named explicitly in [docs/strategy.md](strategy.md#the-no-list).

## More

- **Plugin manifest spec** — [docs/manifest-spec.md](manifest-spec.md).
- **Strategy & roadmap** — [docs/strategy.md](strategy.md). What's in scope and what isn't.
- **Sibling forks** — [aggro](https://github.com/ckpxgfnksd-max/aggro) (raid-HUD ancestor, private) · [cello](https://github.com/ckpxgfnksd-max/cello) (multi-harness director, frozen).

## License

MIT.
