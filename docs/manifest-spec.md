# Agent Harness Manifest — interop spec

**Status:** Draft 0.1. **Reference implementation:** [beto](https://github.com/ckpxgfnksd-max/beto).
**Discussion:** propose changes by opening an issue on the reference repo.

## What this spec is for

A JSON-format declaration that lets any monitoring tool (TUI, menubar, web
dashboard) discover and read sessions from any AI coding agent CLI (Claude
Code, Codex, OpenCode, Goose, etc.) without writing tool-specific code.

The spec describes:

- **Identity:** which harness this is, how to name and color it.
- **Discovery:** what on-disk files / databases hold session data, and how to
  match a session id to its state.
- **Field map:** how the harness's native keys (`thread_name`, `status`,
  `usage.output_tokens`, etc.) translate to a normalized session shape.

Tools that consume the spec produce the same session model regardless of
which harness emitted the data. This means:

- **Adding a new harness = one JSON file.** No code change in the consumer.
- **Adopting a manifest = one filesystem-read code path per kind**, shared
  across every supported harness.
- **Coverage races become collaborative.** Any tool's manifest contribution
  benefits every other consumer.

## Why a spec, not a library

Consumers are written in different stacks: beto is TypeScript+Bun, abtop is
Rust+ratatui, hypothetical future tools could be Python, Go, Swift. A spec
expressed as JSON Schema is language-agnostic. Each consumer implements its
own adapter-kind handlers; the schema is the contract.

## The manifest

A manifest is a JSON file. Filename convention: `<harness-id>.json`. Drop it
into the consumer's plugins directory (`~/.beto/plugins/` for beto;
TBD for other consumers).

### Top-level fields

| Field          | Type        | Required | Notes                                                                                |
|----------------|-------------|----------|--------------------------------------------------------------------------------------|
| `id`           | string      | yes      | Unique slug, lowercase + hyphens (e.g. `codex`, `open-interpreter`)                  |
| `displayName`  | string      | yes      | Human-readable name                                                                  |
| `binary`       | string      | no       | Binary name on PATH. Used by detection probes.                                       |
| `versionFlag`  | string      | no       | Flag to print the version. Default `--version`.                                      |
| `sigil`        | string      | no       | 1–2 character sigil shown in compact UIs. Default: first letter of `id` uppercased.  |
| `color`        | string      | no       | Color name (consumer-defined palette; see Theme below).                              |
| `pollMs`       | number      | no       | Polling cadence. Default `2000`. Range `[100, 60000]`.                               |
| `readBudgetMs` | number      | no       | Hard cap on a single poll. Default `1500`. Range `[50, 10000]`.                      |
| `adapter`      | object      | yes      | Adapter kind + kind-specific config. See below.                                      |
| `tokens`       | object      | no       | Optional token-source spec for usage / tps. See "Token sources".                     |

### Adapter kinds

The `adapter` block is a discriminated union on `kind`. Five kinds defined
in this draft:

#### 1. `directory-of-state-json`

One JSON file per session under one or more directories. Filename convention
is `<sessionId>/state.json` (or similar — controlled by `fileGlob`).

Example consumers: Claude Code (`~/.claude/jobs/<id>/state.json`).

```json
{
  "kind": "directory-of-state-json",
  "config": {
    "stateDirs": ["~/.claude/jobs"],
    "fileGlob": "*/state.json",
    "fieldMap": {
      "sessionId": "session_id",
      "name": "name",
      "state": "status",
      "summary": "summary",
      "lastTransitionAt": "updated_at_ms"
    }
  }
}
```

#### 2. `sqlite-sessions-table`

A SQLite database with a table holding one row per session. Consumers
typically shell out to the `sqlite3` CLI (zero native deps).

Example consumers: OpenCode (`~/.local/share/opencode/opencode.db`),
Goose (`~/.local/share/goose/sessions/sessions.db`).

```json
{
  "kind": "sqlite-sessions-table",
  "config": {
    "dbPath": "~/.local/share/opencode/opencode.db",
    "table": "sessions",
    "fieldMap": {
      "sessionId": "id",
      "name": "title",
      "state": "status",
      "summary": "summary",
      "lastTransitionAt": "updated_at"
    },
    "where": "deleted_at IS NULL",
    "limit": 200
  }
}
```

#### 3. `jsonl-tail`

One JSONL file per session. The most recent record is the session's current
state. Consumers tail the last ~16KB of each matched file.

Example consumers: Open Interpreter
(`~/.config/open-interpreter/conversations/*.jsonl`).

```json
{
  "kind": "jsonl-tail",
  "config": {
    "fileGlob": "~/.config/open-interpreter/conversations/*.jsonl",
    "fieldMap": {
      "sessionId": "conversation_id",
      "summary": "content",
      "state": "type",
      "lastTransitionAt": "created_at"
    },
    "tailLines": 50
  }
}
```

#### 4. `jsonl-index` *(new in spec draft 0.1)*

A single JSONL file where each line is a separate session — the file is an
index of all known sessions, not a per-session transcript.

Example consumers: Codex (`~/.codex/session_index.jsonl`). This is the
schema verified against a real Codex install on 2026-05-12.

```json
{
  "kind": "jsonl-index",
  "config": {
    "filePath": "~/.codex/session_index.jsonl",
    "fieldMap": {
      "sessionId": "id",
      "name": "thread_name",
      "lastTransitionAt": "updated_at"
    }
  }
}
```

`lastTransitionAt` values may be ISO 8601 strings or numeric epochs;
the consumer normalizes.

#### 5. `process-watch-only`

The harness writes nothing useful per-session. Consumer scans the OS process
list and synthesizes one row per matching process.

Example consumers: Aider (no central per-session state).

```json
{
  "kind": "process-watch-only",
  "config": {
    "stateOnRunning": "working"
  }
}
```

### Token sources

Optional `tokens` block lets a manifest declare where token-usage data lives.
When set, consumers compute cumulative + 60s-rolling rate.

Two kinds in draft 0.1:

```json
{
  "tokens": {
    "kind": "jsonl-transcript",
    "fileGlob": "~/.codex/transcripts/<sessionId>.jsonl",
    "messageType": "assistant",
    "fieldMap": {
      "input": "message.usage.input_tokens",
      "output": "message.usage.output_tokens",
      "timestamp": "timestamp"
    }
  }
}
```

Or for SQLite:

```json
{
  "tokens": {
    "kind": "sqlite-usage-table",
    "dbPath": "~/.local/share/opencode/opencode.db",
    "table": "messages",
    "fieldMap": {
      "sessionId": "session_id",
      "input": "input_tokens",
      "output": "output_tokens",
      "timestamp": "created_at"
    }
  }
}
```

### Normalized session shape

After a consumer applies a field map, the resulting session record looks like:

```ts
interface Session {
  harness: string           // manifest.id
  sessionId: string         // unique within harness
  name: string              // human name; falls back to sessionId prefix
  state:                    // closed set; unknown harness states fold to 'unknown'
    | 'working'
    | 'needs-input'
    | 'idle'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'unknown'
  summary: string           // one-line "what is it doing"
  lastTransitionAt: number  // ms epoch
  // Optional enrichments below this line
  tokensIn?: number
  tokensOut?: number
  tokenRateLast60s?: number // output-tokens-per-second, trailing 60s window
  cwd?: string
  prUrl?: string
  prCheckStatus?: string
}
```

Consumers may add their own UI-specific fields, but the above is the
contract. Adding a new top-level field requires a spec minor bump.

### State normalization

Consumers MUST fold these state strings (case-insensitive, hyphens / underscores / spaces equivalent) into the closed `state` set:

- `'working' | 'running' | 'active'` → `working`
- `'needs-input' | 'needs_input' | 'blocked' | 'waiting-for-input'` → `needs-input`
- `'idle' | 'waiting'` → `idle`
- `'completed' | 'done' | 'finished' | 'success'` → `completed`
- `'failed' | 'error' | 'errored'` → `failed`
- `'stopped' | 'killed' | 'cancelled' | 'canceled'` → `stopped`
- Anything else → `unknown` (with the raw string preserved in `rawStateString`).

## Read-only invariant

A consumer that adopts this spec MUST be read-only with respect to harness
directories. It MAY write to its own state (`~/.<consumer>/`), but MUST NOT:

- Write to `~/.<harness>/` or any subdirectory.
- Modify settings files like `~/.claude/settings.json`.
- Install hooks, plugins, or daemons into the harness's process tree.

Verification: consumers SHOULD ship a CI test that fingerprints
`~/.<harness>/` before and after a run and fails on any byte of change.

## Versioning

The spec is SemVer. Draft 0.1 means "ready to discuss, not stable." Spec v1.0
freezes when at least two independent consumers ship against the same minor
version.

| Bump | When |
|------|------|
| PATCH | Editorial fixes, additional adapter-kind variants (consumer-optional) |
| MINOR | New adapter kinds, new optional fields, new normalized state values |
| MAJOR | Renamed required fields, removed adapter kinds, changed normalization rules |

## Reference implementations

| Tool | Status | Stack | Spec adoption |
|------|--------|-------|---------------|
| [beto](https://github.com/ckpxgfnksd-max/beto) | shipping | TS / Bun | reference impl, draft 0.1 |
| [abtop](https://github.com/graykode/abtop) | invited | Rust / ratatui | proposed via [interop issue](#TODO) |

## Open spec questions

- Should the schema enforce a max poll cadence to protect harness daemons?
- Should `tokens.kind: 'sqlite-usage-table'` be a separate `tokens.kind` or
  unified with `adapter.kind: 'sqlite-sessions-table'`?
- Do we need a hash-of-content debounce field per adapter kind to avoid
  emitting unchanged snapshots?

File issues on the reference repo to discuss.
