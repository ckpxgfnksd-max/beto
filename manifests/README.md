# beto manifests

Two tiers:

| Tier | Directory | Loaded by default? | Verification status |
|------|-----------|--------------------|---------------------|
| **Verified** | `manifests/*.json` | yes | Field map exercised against a real install. Fixture snapshot in `test/fixtures/<harness>/`. Regression-tested in CI. |
| **Experimental** | `manifests/experimental/*.json` | no — opt-in via `~/.beto/plugins/` | Field map is best-effort from public docs / research. May not work against a real install. PRs welcome with corrections. |

## Verified (loaded out of the box)

| Manifest | Adapter kind | Verified against |
|----------|--------------|------------------|
| Claude Code *(built-in adapter, not via manifest)* | n/a | 122 real sessions on developer machine (2026-05-12) |
| `codex.json` | `jsonl-index` | 16 real sessions in `~/.codex/session_index.jsonl` (2026-05-12) |
| `opencode.json` | `sqlite-sessions-table` | `~/.local/share/opencode/opencode.db` schema confirmed against opencode-ai v1.14.48 (2026-05-12). `session` table (singular), `time_updated` in ms epoch. |

## Experimental (opt-in only)

| Manifest | Adapter kind | Notes |
|----------|--------------|-------|
| `experimental/hermes.json` | `sqlite-sessions-table` | Schema best-effort from Nous Research docs; needs verification on a real install |
| `experimental/goose.json` | `sqlite-sessions-table` | Schema best-effort from Block/AAIF docs; needs verification on a real install |
| `experimental/aider.json` | `process-watch-only` | Trivially works (no field map) but Aider's per-repo `.aider.chat.history.md` is not surfaced — only running processes |
| `experimental/open-interpreter.json` | `jsonl-tail` | Schema best-effort; needs verification against `~/.config/open-interpreter/conversations/*.jsonl` |
| `experimental/kimi.json` | `process-watch-only` | Detects the `kimi` process. Per-session state lives at `~/.kimi/sessions/<md5(cwd)>/<session_id>/{state.json,context.jsonl}` but the current adapter kinds don't fit a 2-level path. Richer adapter is on the v0.9 roadmap; PRs welcome from Kimi users. |

## Using experimental manifests

```sh
mkdir -p ~/.beto/plugins
cp manifests/experimental/hermes.json ~/.beto/plugins/
# now beto will load it on next launch
```

If you run one of these harnesses, please contribute back. A one-line fieldMap PR turning an experimental manifest into a verified one is the single highest-leverage contribution to this repo.

## Adding a new harness

See [`../docs/manifest-spec.md`](../docs/manifest-spec.md) for the full spec. The TL;DR:

1. Find where the harness writes session data (look in `~/.<harness-id>/`, `~/.local/share/<harness-id>/`, or `~/.config/<harness-id>/`).
2. Pick the adapter kind that fits: `directory-of-state-json`, `sqlite-sessions-table`, `jsonl-tail`, `jsonl-index`, or `process-watch-only`.
3. Map the harness's native field names to beto's normalized session shape via `fieldMap`.
4. Drop the JSON in `~/.beto/plugins/<harness-id>.json` to test, then PR to `manifests/` (verified) or `manifests/experimental/` (best-effort).
