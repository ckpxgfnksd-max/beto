# beto strategy

Last reviewed: 2026-05-12. Revisit when abtop ships a meaningful change or beto reaches 100 stars.

## Primary goal

Clearly and easily observe how AI agents are working — their status, harnesses, and
when they need the operator's attention. Multi-harness coverage is essential; the
inbox-of-stuck-agents framing is the differentiator.

## Strategic posture: collaborate with abtop

[`graykode/abtop`](https://github.com/graykode/abtop) (Rust, ratatui, 2.1k★, last
push 2026-05-10) is the most-adopted tool in this space. It's a real twin: same
zero-install philosophy, same TUI form, overlapping harness coverage. Hardcoded
support for Claude Code / Codex / OpenCode; no manifest spec, no inbox metaphor,
no menubar.

The strategic question: do we **compete** (race them on coverage, win on UX) or
**collaborate** (upstream the manifest spec, both projects benefit from every new
harness adapter)?

### Decision: collaborate

Adopt collaborate because:

1. **Distribution mismatch.** abtop has 2.1k stars. beto has 0. Out-covering them
   on a feature axis where they have 8 months of head start is a long road.
2. **The manifest spec is a non-rival good.** If we keep it proprietary, beto wins
   only as fast as we add adapters. If we upstream it, every adapter anyone writes
   benefits both projects. The spec becomes the noun.
3. **UX differentiation survives.** Inbox metaphor + escalation tiers + macOS
   menubar are orthogonal to the harness adapter layer. The spec defines *what*
   data flows; we still own *how* it's presented.
4. **Worst-case is acceptable.** If abtop rejects or ignores the proposal, we
   publish the spec as ours, call it a community standard, and proceed. The work
   isn't wasted — beto still gets a public spec other tools can adopt.

### What collaboration looks like, concretely

- Extract the plugin-manifest schema into a versioned standalone doc:
  [`docs/manifest-spec.md`](./manifest-spec.md). This is the artifact. ✓ done.
- Open an issue on `graykode/abtop` proposing the spec as a shared adapter
  format. **HELD for v0.8.0 launch (2026-05-12)** — interop outreach
  happens *after* beto has shipped a verified MVP, so the proposal lands
  with a credible reference implementation (working on npm + GitHub
  Releases) rather than vapourware. Revisit within 14 days post-launch.
- If they engage: co-design the spec from v1.0 to v1.1 with their input;
  publish to a neutral home (`agent-manifest-spec` org or similar) at v1.0.
- If they reject/ignore: ship the spec under beto's repo, position the
  manifest format as "the community standard until proven otherwise."
- Either way, the spec is `MAJOR.MINOR.PATCH` versioned and never breaks
  consumers without a major bump.

### Failure modes worth naming

- **abtop ships an inbox/menubar UX before we launch.** Mitigation: weekly
  competitive scan. If they do, revisit this doc.
- **abtop adopts the spec but forks it.** Mitigation: define the spec spec
  precisely (JSON Schema, not English), so divergences are detectable.
- **No one wants a spec at all.** Mitigation: the spec is also useful to beto
  alone. The work isn't speculative.

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
| abtop response to interop issue | engaged / ignored | Strategic posture validated either way |

100 stars in 30 days is the headline. Below 25, we revisit positioning before
v0.9 work. Above 250, we accelerate the native Swift menubar.

Distribution channel: one Show HN post titled around the inbox metaphor, NOT
"another agent monitor." Posted no earlier than Obj 1, 3, 4, 6 are green.
