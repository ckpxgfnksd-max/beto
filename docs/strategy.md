# beto strategy

Last reviewed: 2026-05-17. Revisit when abtop ships a meaningful change or beto reaches 100 stars.

## Primary goal

Clearly and easily observe how AI agents are working — their status, harnesses, and
when they need the operator's attention. Multi-harness coverage is essential; the
inbox-of-stuck-agents framing is the differentiator.

## Strategic posture: leverage abtop's coverage ceiling

[`graykode/abtop`](https://github.com/graykode/abtop) (Rust, ratatui, 2.1k★,
last push 2026-05-10) is the direct twin: zero-install, TUI form, overlapping
coverage. Hardcoded support for Claude Code / Codex / OpenCode; no manifest
spec, no inbox metaphor, no menubar.

The architectural asymmetry matters more than the star count. abtop's
hardcoded adapters make coverage breadth O(team velocity). beto's manifest
spec makes it O(community velocity × spec leverage). That gap is the only
durable wedge a 0★ entrant has against a 2.1k★ incumbent — and it only
matters if beto ships harnesses abtop's approach can't generalize over.

### The forcing function: asymmetric harness coverage

What turns a spec into a standard isn't politeness, neutral governance, or
shared authorship. It's that the spec becomes the only viable path to
something users want. The wedge is the first harness whose storage shape
defeats the hardcoded approach.

Cursor is that harness — sessions live in a key-value SQLite under arbitrary
JSON paths, and the next four targets (Windsurf, Cline, Kimi, Roo Code) each
have a different shape. Once users start asking abtop "where's Cursor
support?", abtop has two choices: hardcode each one indefinitely, or adopt a
manifest spec. The hardcoded path doesn't scale; the manifest path does.
Whoever ships the manifest first becomes the standard by default.

The causal chain is **users demand coverage → only the spec scales →
incumbent adopts or loses**. Not **we ask politely → incumbent agrees**.

### What this means for v0.8.0 and v0.8.1

- **v0.8.0** launches on the existing plan. Launch gates and success metrics
  (100 stars / 250 installs / 5 issues / 1 third-party manifest PR @ 30 days)
  stay intact.
- **v0.8.1** is the strategic release: Cursor + Cline manifests as the
  coverage proof. The narrative is "beto covers what abtop can't, via a spec
  anyone can extend." This is the launch the asymmetric-coverage thesis is
  actually testing.

### abtop touchpoint, reframed

After v0.8.1 ships, file one low-key FYI issue on `graykode/abtop`: links to
the Cursor manifest and the spec, no ask, no "let's standardize." Three
outcomes, all workable:

- **abtop adopts the spec** → it becomes load-bearing, we win.
- **abtop fork-extends** → we hold the canonical version; JSON Schema
  versioning plus the fixture corpus in `tests/fixtures/` make divergence
  detectable.
- **abtop ignores** → base case. We keep shipping coverage they can't match.

None of these depend on abtop's goodwill.

### Why this isn't the MCP playbook

An earlier draft proposed upstreaming the manifest spec to a neutral org
(`agent-manifest-spec`) so beto and abtop become co-equal reference
implementations — modeled implicitly on MCP. The analogy is wrong. MCP was
coercive because Anthropic owned both the donor of the protocol AND the LLM
endpoint; if you didn't speak MCP, you didn't talk to Claude. beto owns no
equivalent funnel. A 0★ project inviting a 2.1k★ project to share authority
over a spec defaults to **ignore** or **fork-extend-control** — genuine
co-adoption is the exception, and waiting for it isn't a strategy. Recording
this so the frame doesn't drift back next time someone asks "should we open
a neutral org?"

### Failure modes worth naming

Leverage-failure modes, not collaboration-failure modes.

- **Users don't actually want broad coverage.** Mitigation: v0.8.1's Cursor
  ship is the test. If npm downloads don't move on a "now covers Cursor"
  announcement, the asymmetric-coverage thesis is wrong and we revisit
  before adding Cline / Kimi / Windsurf.
- **abtop quietly adopts the spec without attribution.** Acceptable. Credit
  isn't load-bearing; the spec being load-bearing is.
- **abtop forks the spec into an incompatible variant.** Mitigation: JSON
  Schema with explicit version field, semver, fixture corpus in
  `tests/fixtures/`. The first project with a working test suite for a given
  harness wins the "real" spec.
- **A third entrant (Mission Control, Claudia) ships a richer adapter system
  in TypeScript before v0.8.1.** Mitigation: weekly competitive scan stays.
  The fight then shifts from "beat abtop on coverage" to "beat the new
  entrant on spec ergonomics" — different fight, same playbook.
- **abtop ships an inbox / menubar UX before v0.8.0.** Mitigation: weekly
  competitive scan. If they do, revisit this doc and the surface mix.

## The "no" list

Things beto explicitly does NOT do, ever:

- **No hooks.** No `claude --bg` hook installation, no `~/.claude/settings.json`
  mutation, no plugin into the harness process tree. Read-only file observation
  only. CI proves this (Obj 3 in v0.8).
- **No cloud sync.** Sessions stay on the operator's machine. No telemetry, no
  account, no API key required by beto itself.
- **No team features.** Single-operator tool. No multi-tenant inbox, no shared
  agent dashboards.
- **No AI-powered triage.** beto surfaces what the harness wrote; it doesn't
  ask another LLM whether a session is "really stuck." That's the harness's job.
- **No web UI.** macOS menubar + TUI are the only surfaces. Web introduces
  auth, hosting, and security questions that violate the zero-install posture.
- **No write-side commander layer for non-Claude harnesses in MVP.** Claude has
  dispatch/attach/reply because we built it. Other harnesses are read-only via
  manifests until v1.x.

## Surfaces

Three from one read-only data layer:

1. **TUI inbox.** Long-form, full-width sidebar. Power-user surface.
2. **macOS menubar (via SwiftBar in v0.7, native Swift in v1.0).** Ambient
   surface. The default daily-driver for casual users.
3. **OS notifications on `needs-input` transitions.** Throttled. Tap-to-act.

Linux gets surfaces 1 and 3. Windows gets surface 1 only. macOS gets all three.
That's not a flaw — macOS is where the primary user-base lives.

## Open strategic questions (parked, not answered)

- **Is the macOS menubar a wedge or a distraction?** Three surfaces from one
  codebase is the bet. v0.8 launch will tell us whether the menubar drives any
  adoption or whether TUI users ignore it.
- **TypeScript+Bun vs Rust.** Rust would give us abtop-parity install (static
  binary). TS+Bun is what we have. v0.8 ships Bun-compiled static binaries; if
  install friction remains a complaint, revisit.

## Roadmap → v0.8.1 (asymmetric-coverage anchor)

v0.8.1 ships 2–3 weeks after v0.8.0 and tests the asymmetric-coverage thesis
directly. Promoted from the v0.9 backlog because it's the lever the strategic
posture rests on, not a nice-to-have.

1. **`sqlite-kv-json` adapter kind.** Cursor stores chat sessions in a
   key-value SQLite (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
   table `ItemTable`, JSON blobs under keys like `interactive.sessions`)
   that the existing `sqlite-sessions-table` kind cannot model. Design the
   new kind to let manifests declare `(db, table, key, jsonPathToSessions)`.
   Real fixture under `test/fixtures/cursor/`.
2. **Cursor manifest, verified.** Ship the actual Cursor manifest using the
   new `sqlite-kv-json` kind, verified against a real Cursor install on macOS.
   Lives in `manifests/cursor.json` (not `experimental/`).
3. **Cline manifest, verified.** Second harness abtop doesn't cover. One is
   anecdote; two is pattern. The spec's credibility comes from the second
   adapter, not the first.
4. **v0.8.1 release narrative.** Short release note that names the
   asymmetric-coverage proof point explicitly: "beto now covers Cursor and
   Cline via the manifest spec. abtop covers neither (and won't easily,
   given hardcoded adapters)." Don't bury this — it's the proof the spec is
   load-bearing.
5. **abtop FYI issue.** One paragraph, no ask, links to the Cursor manifest
   and the spec. Filed only after v0.8.1 has shipped and the Cursor manifest
   is verified. Replaces the held interop-proposal issue from the previous
   strategy draft.

## Roadmap → v0.9

Captured at v0.8.0 cut (2026-05-13). The items below are *not* commitments —
they are the candidates that surfaced during the v0.8 push and earned a
"yes, post-launch" rather than a "no, never." All slot behind v0.8.1.

1. **Kimi graduation.** v0.8 ships Kimi as `process-watch-only` (detection
   only — see [`manifests/experimental/kimi.json`](../manifests/experimental/kimi.json)).
   The per-session state is at `~/.kimi/sessions/<md5(cwd)>/<session_id>/`
   (`state.json`, `context.jsonl`, `wire.jsonl`). Either extend
   `directory-of-state-json` to support N-level discovery, or add a
   `glob-of-state-json` kind. Then capture a real-session fixture and
   move Kimi from `experimental/` to `manifests/`.
2. **Community-PR invitations.** Open `good first issue` tickets requesting
   manifests for: Roo Code (`RooCodeInc/Roo-Code`), Jan, Continue.dev. Each
   ticket links the manifest spec and explains the fixture requirement.
   Goal: hit the success-metric target of "1 third-party manifest PR in the
   first 30 days" without prompting. (Cline is no longer on this list — it
   ships in v0.8.1.)
3. **HuggingFace explicit non-goal.** smolagents, HuggingChat, Inference
   Endpoints, and Spaces are all cloud-first or have no canonical local
   session storage. beto cannot monitor what isn't on disk. Document this
   in the manifest spec FAQ so the question stops recurring.
4. **OpenClaw clarification.** OpenClaw is a Claude Code skill distribution
   layer, not a separate harness — its users' sessions already land in
   `~/.claude/jobs/` and are covered by the built-in Claude adapter. Add a
   one-paragraph note to the README so the question stops recurring.
5. **Native Swift menubar (conditional on adoption).** Per the strategy
   posture, accelerate this only above 250 npm installs in 30 days.
   SwiftBar is fine for the launch; native is a quality upgrade, not a
   blocker.

## Roadmap → v1.0 (lockdown)

After v0.9 ships, v1.0 freezes both the manifest API and the data surface.
The hero job is shifting the inbox from pull to push — once users trust the
3-tier escalation surface, the next bottleneck is "I'm not looking at beto
right now." Push channels close that gap without forcing a daemon or web UI.

1. **Manifest spec v1.0 + deprecation policy.** Lands in
   [`manifest-spec.md`](./manifest-spec.md). Pre-1.0 minor versions could
   break the manifest API with a note; 1.0 cannot. Schema becomes JSON
   Schema with explicit `version` field per the failure-mode mitigation.
2. **Webhook / Slack notification for `abandoned`.** Five minutes idle posts
   to a configured URL. Users opt in by setting `~/.beto/config.json`'s
   `webhook` field — no outbound network unless they ask. Directly addresses
   the [HN context-switching pain](https://news.ycombinator.com/item?id=47223142)
   ("I was constantly jumping between terminals to see which session needed
   input"); inbox push without daemonizing.
3. **Native Swift menubar (conditional).** Per strategy posture, accelerate
   only above 250 npm installs in 30 days post v0.8. If we're below, this
   slips to v1.1; v1.0 still ships on the spec freeze and webhook.

## Roadmap → v1.1 (ecosystem co-existence)

The 2026-05-17 competitive snapshot (below) confirmed `ryoppippi/ccusage`
shares beto's posture (read-only, prefetched pricing, `--offline` capable).
Rather than rebuilding cost analytics, v1.1 adopts ccusage as a token-source
plugin — competing only where the design space is unfilled.

1. **`ccusage-cli` token-source kind.** Runtime invokes `bunx ccusage --json`
   and pipes the result into the peek view's token line. Optional
   (manifest-controlled); no cost code in beto itself. Makes the "adopt
   rather than rebuild" stance concrete.
2. **Linux system tray + Windows tray icon.** v0.8 only commits to TUI on
   non-macOS. v1.1 fills the menubar surface gap so the "ambient inbox"
   pitch holds cross-platform.
3. **Community manifest corpus expansion.** Roll up the v0.9 community PRs;
   target 6 verified harnesses (Cursor, Cline, Roo, Continue, Jan, Kimi) so
   the spec has concrete adoption evidence beyond beto itself.

## Competitive snapshot — 2026-05-17

Top 10 GitHub competitors verified against four axes — multi-harness, time-
based escalation, zero outbound HTTP, zero-write CI proof. **No project in
the Top 10 occupies all four simultaneously.** Full report:
[`beto_competitors_2026_05_17.md`](../../../.claude/contexts/survey_sessions/beto_competitors_2026_05_17.md).

Key actionable findings beyond what's already in this doc:

- **Anthropic Agent View** (Claude Code v2.1.139, shipped 2026-05-11) is the
  head-line threat for single-harness Claude users — but
  [HN cadl11](https://news.ycombinator.com/item?id=48124057) listed four
  concrete gaps within 6 days of launch: no cross-repo filter, no permission
  granularity on dispatch, no branch status, single harness. v0.9's
  cross-cwd grouping + dispatch permission flags target those gaps
  directly. **Do not frame beto as "better Claude Code monitor"** —
  Anthropic owns that lane; frame around what Agent View structurally can't
  cover.
- **[hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor)**
  (369★) is the only project that names `awaiting_input_since` as a
  field — but its test suite confirms a single yellow badge, no time-tier
  escalation. The 3-tier UX with concrete time bands (`<60s` / `1-5m` /
  `5m+`) must be the pinned phrasing in README and Show HN, not the
  ambient "inbox" or "awaiting input" wording (those are taken).
- **[winfunc/opcode](https://github.com/winfunc/opcode)** (21,859★ but
  [issue #468](https://github.com/winfunc/opcode/issues/468) "Is this
  project still maintained?" sat open 4 days at survey time; last commit
  2025-10-16) is no longer a live threat — its star count reflects the
  Claudia migration spike, not current velocity. Don't optimize against it.

## Versioning

- **Beto:** SemVer. v0.x is pre-1.0; minor versions can break the manifest API
  with a deprecation note. v1.0 freezes both the manifest API and the data
  surface.
- **Manifest spec:** SemVer, separate from beto. Spec v1.0 lands with beto v1.0.
  Spec changes are tracked in [`manifest-spec.md`](./manifest-spec.md).

## Success metrics for v0.8.0 launch

Defined ahead of launch (per critique's Obj 7):

| Metric | Target @ 30 days | Why |
|--------|------------------|-----|
| GitHub stars | 100 | Validation that the inbox metaphor resonates |
| `npm i -g beto` downloads | 250 | Real install friction is acceptable |
| GitHub Issues opened by non-author | 5 | The tool reached users who care enough to file feedback |
| Third-party manifest PRs | 1 | The spec serves anyone besides me |
| Demand signals for unsupported harnesses | ≥3 distinct asks (Cursor, Cline, Windsurf, etc.) | Validates the asymmetric-coverage thesis before v0.8.1 ships |

100 stars in 30 days is the headline. Below 25, we revisit positioning before
v0.9 work. Above 250, we accelerate the native Swift menubar.

Distribution channel: one Show HN post titled around the inbox metaphor, NOT
"another agent monitor." Posted no earlier than Obj 1, 3, 4, 6 are green.
