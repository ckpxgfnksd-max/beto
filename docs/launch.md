# v0.8.0 launch plan

**Status: drafted, awaiting user approval.** This file gates posting
to any public forum. The author (Chase) approves the channel + the
exact post text before either gets executed.

## Pre-launch gate

Do NOT cut the v0.8.0 tag until all of these are on `main`:

- [x] PR #8 — v0.8 Obj 1: verified manifests + jsonl-index kind + strategy lock
- [x] PR #9 — v0.8 Obj 3: zero-write CI proof
- [x] PR #10 — v0.8 Obj 4: real install path
- [ ] PR #11 — v0.8 follow-up: jsonl-index zero-write coverage
- [ ] PR #12 — v0.8 Obj 2: OpenCode adapter (verified)
- [ ] PR #13 — v0.8 Obj 5: npm publish prep
- [ ] PR #14 — v0.8 Obj 6: README rewrite (live README replaced, not just draft)
- [ ] (optional) abtop interop issue opened on `graykode/abtop`

When all checked: cut the tag, watch the release workflow build the
three binaries, then run `npm publish`.

## Cut the tag

```sh
git checkout main && git pull
git tag -a v0.8.0 -m "v0.8.0: verified manifests + zero-write CI + curl install"
git push origin v0.8.0
```

The push triggers `.github/workflows/release.yml`:
- Cross-compiles `beto-darwin-arm64`, `beto-darwin-x64`, `beto-linux-x64`.
- Writes `SHA256SUMS`.
- Smoke-tests the linux binary.
- Uploads everything + `scripts/install.sh` to the GitHub Release.
- Generates release notes from merged PRs.

Watch: <https://github.com/ckpxgfnksd-max/beto/actions/workflows/release.yml>.

## npm publish

After the GitHub Release is live:

```sh
git checkout main && git pull
bun run prepublishOnly   # sanity check
npm publish              # requires npm credentials
```

`prepublishOnly` runs tsc + vitest + build inside the publish hook
so a broken artifact can't slip out. Verified locally on PR #13:
146 tests pass, dist/cli.js builds at 1.24 MB, npm pack dry-run
ships 13 files at 263 KB.

## Success metrics

Defined ahead of the launch (per `docs/strategy.md`); do NOT change
post-hoc.

| Metric | Target @ 30 days | Why |
|---|---|---|
| GitHub stars | 100 | Validation that the inbox metaphor resonates |
| `npm i -g beto-tui` downloads | 250 | Real install friction is acceptable |
| GitHub Issues opened by non-author | 5 | Reached users who care enough to file feedback |
| Third-party manifest PRs | 1 | Spec serves anyone besides me |
| abtop interop issue response | engaged / ignored | Strategic posture validated either way |

Headline: **100 stars in 30 days.** Below 25, revisit positioning
before v0.9 work. Above 250, accelerate the native Swift menubar.

## Distribution channel — ONE only

The critique was emphatic: pick one channel, not all three. Cross-
posting dilutes attention and makes attribution impossible to track.

### Option A — Show HN (recommended)

**Title:** `Show HN: beto – an inbox for stuck AI coding agents`

**First comment (post immediately after submission):**

> Hi HN — beto solves a small but real problem I had running 5+
> Claude Code / Codex sessions in parallel: I'd context-switch to
> check on agents, find one stalled 5 minutes ago waiting for input,
> and lose 20 minutes of flow.
>
> beto reads each harness's session data (zero hooks, no daemons —
> verified in CI), surfaces blocked sessions with a 3-tier
> escalation ramp (gold/orange/red as wait time grows), and lives
> in the macOS menubar via SwiftBar so you don't have to look.
>
> Closest thing in the field is abtop (great project — htop for
> agents). beto and abtop have overlap; mine took the inbox-of-
> stuck-agents shape, theirs took the everything-dashboard. They
> compose fine; I run both.
>
> Plugin manifest spec means new harnesses are one JSON file, not
> a code change. Verified today: Claude / Codex / OpenCode.
>
> Most useful feedback: which harness do you want next? Or, if
> you're shipping one, want to add a beto-manifest.json to your
> repo?

**Why HN:** the niche audience (devs running multiple AI coding
sessions) is HN-shaped. r/ClaudeAI is bigger but more casual;
HN engagement converts to issues / PRs / stars at a higher rate
for tools like this.

### Option B — r/ClaudeAI

Higher volume but lower-fidelity engagement. Use only if (a) the
HN post fails to land, or (b) we want a follow-up surge two weeks
out.

### Option C — Comment on abtop's repo / issue

Higher leverage if the abtop interop issue gets engagement. Wait
to see the response before deciding to cross-post.

**Pick A unless you have a reason to do otherwise.**

## What to do if launch goes well (>50 stars in 24h)

- Don't add features mid-launch. The roadmap stays as written in
  `docs/strategy.md`.
- Respond to every issue + manifest PR within 24 hours.
- Open a thread in the README (or a GitHub Discussion) inviting
  third-party manifest contributions.
- Update `docs/strategy.md` with the actual metrics for the 7-day
  and 30-day checkpoints.

## What to do if launch flops (<25 stars in 7 days)

- DO NOT pivot the product immediately. Validate the assumption
  that broke first.
- Write a one-paragraph post-mortem in `docs/strategy.md`: was it
  the title, the comparison framing, the install friction, the
  comparison anchor (abtop)?
- Revisit the strategy doc's compete-vs-collaborate decision.
- Don't ship v0.9 work until the post-mortem points at something
  testable.

## Weekly cadence post-launch

Every 7 days for the first month, regardless of metrics:

1. Re-check abtop releases. New version? Inbox metaphor? Plugin
   manifest? Revisit `docs/strategy.md`.
2. Re-check OpenCode schema. Any breaking changes to `~/.local/
   share/opencode/opencode.db`? Update the manifest if so.
3. Count: stars, npm dls, non-author issues, third-party manifest
   PRs. Log to `docs/strategy.md`.
4. If a new harness becomes notable, add the experimental manifest.

## Author checklist before posting

- [ ] All gate-PRs merged
- [ ] v0.8.0 tag pushed
- [ ] Release workflow succeeded, binaries uploaded
- [ ] `curl -fsSL <install-url> | sh` works end-to-end from a
      fresh terminal on a fresh tmpdir
- [ ] `npm publish` succeeded; `npm i -g beto-tui` works (binary on PATH = `beto`)
- [ ] README.md on main is the v0.8 rewrite (not the draft)
- [ ] (if posting abtop issue) interop issue is open on
      `graykode/abtop`
- [ ] Post text reviewed; obvious typos and version numbers
      double-checked
