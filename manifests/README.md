# Reference manifests

These are the manifests beto ships built-in. Each one is a working example of one of the four adapter kinds:

| Manifest | Kind | Notes |
|----------|------|-------|
| `codex.json` | `directory-of-state-json` | OpenAI Codex CLI, scans `~/.codex/sessions/` |
| `hermes.json` | `sqlite-sessions-table` | Nous Research Hermes, reads `~/.hermes/state.db` |
| `goose.json` | `sqlite-sessions-table` | Block Goose, reads `~/.local/share/goose/sessions/sessions.db` |
| `aider.json` | `process-watch-only` | Aider, synthesizes one row per running process |
| `open-interpreter.json` | `jsonl-tail` | Open Interpreter, tails `~/.config/open-interpreter/conversations/*.jsonl` |

## Status — verified vs. best-effort

**Verified against installed harnesses:** none yet.

**Best-effort field maps from public docs / research:** all of the above.

The field names in each `fieldMap` are derived from the research surveys in [the v0.2.1 PR](https://github.com/ckpxgfnksd-max/beto/pull/2) and may not match the real on-disk schema exactly. If you run one of these harnesses, please open a PR with the corrections — a one-line `fieldMap` adjustment makes the adapter work for everyone.

## Writing your own

Drop a JSON file into `~/.beto/plugins/`. Beto reads it on next launch. See [README.md → Plugin manifests](../README.md#plugin-manifests) for the schema.
