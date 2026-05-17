
# beto

[![CI](https://github.com/ckpxgfnksd-max/beto/actions/workflows/ci.yml/badge.svg)](https://github.com/ckpxgfnksd-max/beto/actions/workflows/ci.yml)
[![zero-write CI](https://github.com/ckpxgfnksd-max/beto/actions/workflows/zero-write.yml/badge.svg)](https://github.com/ckpxgfnksd-max/beto/actions/workflows/zero-write.yml)

**Your most expensive resource is attention. Stuck agents waste it.**

You launch a Claude Code session, switch to another window, come back twenty minutes later and find the agent stalled five minutes in — silently waiting on a question you'd have answered in seconds. Multiply by ten parallel sessions across Claude, Codex, OpenCode, and the rest. Most of your "agent productivity" is actually you context-switching to discover blocked agents.

**beto is the inbox that surfaces stuck agents before you go looking.** Live in the macOS menubar or a terminal pane; one glance shows you which sessions need you right now, color-coded by how long they've been waiting — **gold under 60 seconds, orange at 1–5 minutes, red past 5 minutes**.

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

beto's design space sits at the intersection of four properties no other project in the top tier occupies simultaneously: **multi-harness coverage**, **time-based escalation**, **zero outbound HTTP**, and a **CI-enforced zero-write proof**. The table below names each direct comparator the [2026-05-17 competitive survey](../../../.claude/contexts/survey_sessions/beto_competitors_2026_05_17.md) verified at the code level.

| | beto | [Anthropic Agent View](https://code.claude.com/docs/en/agent-view) | [hoangsonww](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | [claudecodeui](https://github.com/siteboon/claudecodeui) | [abtop](https://github.com/graykode/abtop) |
|--|------|------|------|------|------|
| **Surface** | TUI + macOS menubar + OS notification | In-CC TUI subcommand | Web Kanban + PWA | Web + Mobile UI | Rust TUI dashboard |
| **Harnesses** | Claude · Codex · OpenCode (+ any via [manifest spec](manifest-spec.md)) | Claude Code only | Claude Code only | Claude · Cursor · Codex · Gemini | Claude · Codex · OpenCode (hardcoded) |
| **Time-tier escalation** | **3-tier: gold `<60s` / orange `1–5m` / red `5m+`** | Single "Needs input" group, no time bands | Single yellow `awaiting_input_since` badge | Active-session list, no stuck concept | htop-style metrics, no stuck concept |
| **Cross-repo / cross-cwd grouping** | v0.9 target | ❌ ([HN cadl11](https://news.ycombinator.com/item?id=48124057): "messy session lists across multiple repos") | ❌ | ❌ | ❌ |
| **Dispatch permission granularity** | v0.9 target | ❌ ("cannot specify permissions when dispatching") | Inherits CC | Inherits CC | n/a (read-only) |
| **Persists after CC sleeps** | ✅ (mtime-driven, re-aggregates on wake) | ❌ ("sessions are local and stop if the machine sleeps") | localhost server | self-hosted server | ✅ |
| **Writes `~/.claude/settings.json`** | **❌ CI-enforced** (`test/zero-write.test.ts`) | n/a (Anthropic's own) | **✅ every server start** ([SETUP.md](https://github.com/hoangsonww/Claude-Code-Agent-Monitor/blob/master/SETUP.md)) | ❌ | **✅ `--setup` writes statusline hook** |
| **Outbound HTTP** | **0** | Claude API only | localhost-only, default bind `0.0.0.0` | Self-hosted: 0; cloud variant ships data off-box | None claimed (not CI-verified) |
| **Read-only invariant** | **Byte-level CI proof** | n/a | ❌ | Read-only on `~/.claude/`; writes own SQLite user DB | Stated posture, no CI gate |

Both [ccusage](https://github.com/ryoppippi/ccusage) (14.2k★ cost analyzer) and [claude-code-trace](https://github.com/delexw/claude-code-trace) (Rust JSONL viewer, Docker mounts `~/.claude` read-only) share beto's posture and operate in adjacent design space — beto adopts them rather than rebuilds (`ccusage` becomes a v1.1 token-source plugin). [opcode](https://github.com/winfunc/opcode) (21.9k★, last commit 2025-10-16, [#468](https://github.com/winfunc/opcode/issues/468) "still maintained?") is no longer maintained and isn't optimized against.

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
| Hermes · Goose · Aider · Open Interpreter · Kimi | experimental | [`manifests/experimental/`](../manifests/experimental/), opt-in via `~/.beto/plugins/` |
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
