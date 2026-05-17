// Plugin manifest schema for beto v0.3+.
//
// A manifest describes a harness — its identity, binary, and how to read
// its sessions — without requiring TypeScript code in beto's repo. Anyone
// can drop a manifest into ~/.beto/plugins/ and beto auto-registers an
// adapter on next launch.
//
// One of the four built-in `kind` values determines how the adapter reads
// state; the `config` block is kind-specific. Future kinds plug in as
// additional union members here.

import type { HarnessId, SessionState } from './types.js'

// ─── State inference rules ───────────────────────────────────────────
//
// Declarative way to map raw event/row data to a SessionState when the
// adapter can't read an explicit `state` field. Each rule's `when` is a
// conjunction (all predicates AND together). The first rule that
// matches wins; if no rule matches, the adapter falls through to its
// default heuristic (age-based for jsonl-tail, 'unknown' for sqlite).
//
// Predicate vocabulary:
//   - equals: dotted-path → required string value (after String()
//             coercion). Multiple entries AND together.
//   - present: dotted-path is present AND not empty/null/0.
//   - absent: dotted-path is missing OR empty/null.
//   - minAgeMs: age (now - lastTransitionAt) is at least this many ms.
//
// Scope (`against`, jsonl-tail only): which JSON record to evaluate
// predicates against. 'tail' (default) = the most-recent record;
// 'head' = the first-line session_meta record. Sqlite adapters expose
// scopes via `joinLatest.as` virtual names instead.
export interface StateInferenceRule {
  name?: string
  mapsTo: SessionState
  when: {
    equals?: Record<string, string>
    present?: string[]
    absent?: string[]
    minAgeMs?: number
    against?: 'tail' | 'head'
  }
}

// ─── Adapter kinds ───────────────────────────────────────────────────

export type AdapterKind =
  | 'directory-of-state-json'
  | 'sqlite-sessions-table'
  | 'jsonl-tail'
  | 'jsonl-index'
  | 'process-watch-only'

// Field map: maps SessionSnapshot fields to the harness's native keys.
// Every field is optional except sessionId. Unmapped keys fall back to
// snake_case + camelCase variants of the SessionSnapshot field name.
export interface FieldMap {
  sessionId: string
  name?: string
  state?: string
  summary?: string
  lastTransitionAt?: string
  processAlive?: string
  prUrl?: string
  prCheckStatus?: string
  cwd?: string
}

// Kind: directory-of-state-json. Each session is a `<sessionId>/state.json`
// file under one or more state dirs. Same shape as Claude Code's adapter.
export interface DirectoryOfStateJsonConfig {
  stateDirs: string[] // tildes expanded; first existing one wins
  fieldMap?: FieldMap
}

// Kind: sqlite-sessions-table. A SQLite database with a sessions table.
// Shells out to the `sqlite3` CLI for portability (no native binding).
//
// Optional extras for state inference:
//   - joinLatest: a per-session sub-query whose result columns are
//     exposed under a virtual scope name (e.g. 'latestMessage'). The
//     adapter batches the sub-query into a single SQL round-trip using
//     `WHERE <sessionIdCol> IN (...)`, so one extra subprocess covers
//     all selected sessions. Used by OpenCode to peek at the latest
//     row of `session_message` for blocked-state detection.
//   - stateInference: rules that map joined data to a SessionState.
//     First matching rule wins; runs after `where` filtering, before
//     the existing `unknown` fallback.
export interface SqliteJoinLatest {
  // Virtual scope name surfaced in stateInference paths (no dots).
  as: string
  // Single SELECT statement returning at most one row per session.
  // MUST contain the literal token `:sessionIds` exactly once — the
  // adapter substitutes it with a comma-separated quoted list of
  // session IDs at scan time. The SELECT must also include a column
  // named `session_id` (or the join key configured via `keyAs`).
  sql: string
  // Column in the sub-query result that matches the parent session id.
  // Defaults to `session_id`.
  keyAs?: string
}

export interface SqliteSessionsTableConfig {
  dbPath: string
  table: string
  fieldMap: FieldMap
  where?: string
  limit?: number
  joinLatest?: SqliteJoinLatest
  stateInference?: StateInferenceRule[]
}

// Kind: jsonl-tail. Each session is one JSONL file; the latest record is
// the source of truth for the session's current state.
//
// Optional extras (used by Codex):
//   - `headFieldMap`: read static metadata (cwd, originator, sessionId)
//     from the FIRST record of each file. Useful when the first line is
//     a session_meta record and subsequent lines are events. Head fields
//     fill any slot the tail field map left empty.
//   - `exclude`: drop files whose head record matches `field == equals`.
//     Codex Desktop spawns subagent rollouts (guardian etc.) we don't
//     want to surface as standalone agents.
//   - Field-map values support dotted paths (`payload.cwd`) for nested
//     JSON. Flat keys still work.
export interface JsonlTailConfig {
  fileGlob: string
  fieldMap: FieldMap
  headFieldMap?: FieldMap
  exclude?: { field: string; equals: string }
  tailLines?: number
  // Optional declarative state inference. Rules are evaluated AFTER
  // `exclude` and field mapping, BEFORE the age-based fallback. Useful
  // for harnesses (Codex) whose tail records carry no explicit state
  // but have terminator events like `event_msg / task_complete` that
  // deterministically mean "waiting on the user."
  stateInference?: StateInferenceRule[]
}

// Kind: jsonl-index. A single JSONL file where each line is a separate
// session (e.g. Codex's ~/.codex/session_index.jsonl). Distinct from
// jsonl-tail which reads one file per session.
export interface JsonlIndexConfig {
  filePath: string
  fieldMap: FieldMap
}

// Kind: process-watch-only. No state on disk. Synthesize one row per
// running process matching the binary name. Used for CLIs like Aider
// that don't centralize state.
export interface ProcessWatchOnlyConfig {
  // What SessionSnapshot.state to assign synthesized rows.
  // Default 'working'.
  stateOnRunning?: 'working' | 'idle'
}

export type AdapterConfig =
  | { kind: 'directory-of-state-json'; config: DirectoryOfStateJsonConfig }
  | { kind: 'sqlite-sessions-table'; config: SqliteSessionsTableConfig }
  | { kind: 'jsonl-tail'; config: JsonlTailConfig }
  | { kind: 'jsonl-index'; config: JsonlIndexConfig }
  | { kind: 'process-watch-only'; config: ProcessWatchOnlyConfig }

// Optional token-source config for a manifest. When present, the plugin
// loader will instantiate a TokenSource alongside the main adapter and
// enrich every emitted SessionSnapshot with tokens. v0.6 ships the
// `jsonl-transcript` source (Claude-style); future kinds plug in here.
//
// Field maps under `fieldMap` translate the harness's native usage keys
// to beto's `input` / `output` axes. `messageType` selects which JSONL
// record type carries usage (Claude uses `assistant`).
export type TokenSourceConfig =
  | {
      kind: 'jsonl-transcript'
      // Glob pattern matching transcript files. `<sessionId>` token in
      // the path is replaced with each session's id at lookup time.
      fileGlob: string
      // Record-type filter (default `assistant`).
      messageType?: string
      // Field map from JSONL → beto. Defaults match Claude Code:
      //   input:  message.usage.input_tokens
      //   output: message.usage.output_tokens
      //   timestamp: timestamp (ISO string)
      fieldMap?: {
        input?: string
        output?: string
        timestamp?: string
      }
    }
  | {
      kind: 'sqlite-usage-table'
      dbPath: string
      table: string
      // Column names. `sessionId` is required; `input/output/timestamp`
      // map to numeric / ISO-string columns the kind sums per session.
      fieldMap: {
        sessionId: string
        input?: string
        output?: string
        timestamp?: string
      }
    }

// The full manifest shape.
export interface PluginManifest {
  // Unique slug; becomes the HarnessId. Lowercase + hyphens.
  id: HarnessId
  displayName: string
  // Single character preferred. Defaults to first letter of id.
  sigil?: string
  // Ink color name; defaults to 'gray'.
  color?: string
  // Binary name on PATH. Used for detection (PATH probe + process scan).
  // Omit only for process-watch-only kinds with no associated binary.
  binary?: string
  versionFlag?: string
  // Polling cadence in ms. Default 2000.
  pollMs?: number
  // Per-poll read budget in ms. Adapter aborts the current poll and uses
  // last-known rows if a single scan exceeds this. Default 1500ms.
  readBudgetMs?: number
  // Kind + kind-specific config — discriminated union.
  adapter: AdapterConfig
  // Optional token source. When set, the plugin loader composes a
  // TokenSource that enriches snapshots from this manifest's adapter
  // with token counts + 60s tps. Not all adapter kinds have a useful
  // token source — that's ok, the field is optional.
  tokens?: TokenSourceConfig
}

// ─── Validation ──────────────────────────────────────────────────────

export interface ValidationError {
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  // Present when `ok`. Manifest with defaults filled in.
  manifest?: PluginManifest
}

// Validate a parsed JSON object as a PluginManifest. Returns the
// normalized manifest with defaults applied, or a list of errors.
// Validation is intentionally strict on the discriminator (kind) so a
// typo doesn't fall through to a silent no-op adapter.
export function validateManifest(raw: unknown): ValidationResult {
  const errors: ValidationError[] = []
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'manifest must be an object' }] }
  }
  const o = raw as Record<string, unknown>

  // Top-level required fields.
  const id = pickString(o, 'id')
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
    errors.push({ path: 'id', message: 'must be lowercase-with-hyphens slug' })
  }
  const displayName = pickString(o, 'displayName')
  if (!displayName) errors.push({ path: 'displayName', message: 'required string' })

  // Optional top-level fields with type checks.
  const sigil = pickString(o, 'sigil')
  if (sigil != null && sigil.length > 2) {
    errors.push({ path: 'sigil', message: 'one or two characters' })
  }
  const color = pickString(o, 'color')
  const binary = pickString(o, 'binary')
  const versionFlag = pickString(o, 'versionFlag')
  const pollMs = pickNumber(o, 'pollMs')
  if (pollMs != null && (pollMs < 100 || pollMs > 60_000)) {
    errors.push({ path: 'pollMs', message: 'must be between 100 and 60000 ms' })
  }
  const readBudgetMs = pickNumber(o, 'readBudgetMs')
  if (readBudgetMs != null && (readBudgetMs < 50 || readBudgetMs > 10_000)) {
    errors.push({ path: 'readBudgetMs', message: 'must be between 50 and 10000 ms' })
  }

  // Adapter block — discriminated by `kind`.
  const adapterRaw = o.adapter
  if (!adapterRaw || typeof adapterRaw !== 'object') {
    errors.push({ path: 'adapter', message: 'required object with kind + config' })
    return { ok: false, errors }
  }
  const a = adapterRaw as Record<string, unknown>
  const kind = pickString(a, 'kind') as AdapterKind | null
  const KINDS: readonly AdapterKind[] = [
    'directory-of-state-json',
    'sqlite-sessions-table',
    'jsonl-tail',
    'jsonl-index',
    'process-watch-only',
  ]
  if (!kind || !KINDS.includes(kind)) {
    errors.push({
      path: 'adapter.kind',
      message: `must be one of: ${KINDS.join(', ')}`,
    })
    return { ok: false, errors }
  }

  const config = a.config
  if (!config || typeof config !== 'object') {
    errors.push({ path: 'adapter.config', message: 'required object' })
    return { ok: false, errors }
  }
  const cfg = config as Record<string, unknown>
  const adapter = validateAdapterConfig(kind, cfg, errors)
  if (!adapter) return { ok: false, errors }

  if (errors.length > 0) return { ok: false, errors }

  const manifest: PluginManifest = {
    id: id!,
    displayName: displayName!,
    ...(sigil != null ? { sigil } : {}),
    ...(color != null ? { color } : {}),
    ...(binary != null ? { binary } : {}),
    ...(versionFlag != null ? { versionFlag } : {}),
    ...(pollMs != null ? { pollMs } : {}),
    ...(readBudgetMs != null ? { readBudgetMs } : {}),
    adapter,
  }
  return { ok: true, errors: [], manifest }
}

function validateAdapterConfig(
  kind: AdapterKind,
  cfg: Record<string, unknown>,
  errors: ValidationError[],
): AdapterConfig | null {
  switch (kind) {
    case 'directory-of-state-json': {
      const stateDirs = pickStringArray(cfg, 'stateDirs')
      if (!stateDirs || stateDirs.length === 0) {
        errors.push({ path: 'adapter.config.stateDirs', message: 'non-empty string array' })
        return null
      }
      const fieldMap = pickFieldMap(cfg, 'fieldMap', errors)
      return { kind, config: { stateDirs, ...(fieldMap ? { fieldMap } : {}) } }
    }
    case 'sqlite-sessions-table': {
      const dbPath = pickString(cfg, 'dbPath')
      const table = pickString(cfg, 'table')
      const fieldMap = pickFieldMap(cfg, 'fieldMap', errors)
      if (!dbPath) errors.push({ path: 'adapter.config.dbPath', message: 'required string' })
      if (!table) errors.push({ path: 'adapter.config.table', message: 'required string' })
      if (!fieldMap?.sessionId) {
        errors.push({ path: 'adapter.config.fieldMap.sessionId', message: 'required' })
      }
      if (!dbPath || !table || !fieldMap) return null
      const where = pickString(cfg, 'where')
      const limit = pickNumber(cfg, 'limit')
      const joinLatest = pickJoinLatest(cfg, 'joinLatest', errors)
      const stateInference = pickStateInference(cfg, 'stateInference', errors)
      return {
        kind,
        config: {
          dbPath,
          table,
          fieldMap,
          ...(where ? { where } : {}),
          ...(limit ? { limit } : {}),
          ...(joinLatest ? { joinLatest } : {}),
          ...(stateInference ? { stateInference } : {}),
        },
      }
    }
    case 'jsonl-tail': {
      const fileGlob = pickString(cfg, 'fileGlob')
      const fieldMap = pickFieldMap(cfg, 'fieldMap', errors)
      if (!fileGlob) errors.push({ path: 'adapter.config.fileGlob', message: 'required string' })
      if (!fieldMap?.sessionId) {
        errors.push({ path: 'adapter.config.fieldMap.sessionId', message: 'required' })
      }
      if (!fileGlob || !fieldMap) return null
      const tailLines = pickNumber(cfg, 'tailLines')
      const headFieldMap = pickFieldMap(cfg, 'headFieldMap', errors)
      const exclude = pickExclude(cfg, 'exclude', errors)
      const stateInference = pickStateInference(cfg, 'stateInference', errors)
      return {
        kind,
        config: {
          fileGlob,
          fieldMap,
          ...(headFieldMap ? { headFieldMap } : {}),
          ...(exclude ? { exclude } : {}),
          ...(tailLines ? { tailLines } : {}),
          ...(stateInference ? { stateInference } : {}),
        },
      }
    }
    case 'jsonl-index': {
      const filePath = pickString(cfg, 'filePath')
      const fieldMap = pickFieldMap(cfg, 'fieldMap', errors)
      if (!filePath) errors.push({ path: 'adapter.config.filePath', message: 'required string' })
      if (!fieldMap?.sessionId) {
        errors.push({ path: 'adapter.config.fieldMap.sessionId', message: 'required' })
      }
      if (!filePath || !fieldMap) return null
      return { kind, config: { filePath, fieldMap } }
    }
    case 'process-watch-only': {
      const stateOnRunning = pickString(cfg, 'stateOnRunning')
      const okState =
        stateOnRunning == null || stateOnRunning === 'working' || stateOnRunning === 'idle'
      if (!okState) {
        errors.push({
          path: 'adapter.config.stateOnRunning',
          message: "must be 'working' or 'idle'",
        })
        return null
      }
      return {
        kind,
        config: stateOnRunning
          ? { stateOnRunning: stateOnRunning as 'working' | 'idle' }
          : {},
      }
    }
  }
}

function pickExclude(
  o: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): { field: string; equals: string } | undefined {
  const v = o[key]
  if (v == null) return undefined
  if (typeof v !== 'object') {
    errors.push({ path: `adapter.config.${key}`, message: 'must be an object' })
    return undefined
  }
  const vo = v as Record<string, unknown>
  const field = pickString(vo, 'field')
  const equals = pickString(vo, 'equals')
  if (!field) errors.push({ path: `adapter.config.${key}.field`, message: 'required string' })
  if (equals == null) {
    errors.push({ path: `adapter.config.${key}.equals`, message: 'required string' })
  }
  if (!field || equals == null) return undefined
  return { field, equals }
}

function pickFieldMap(
  o: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): FieldMap | undefined {
  const fm = o[key]
  if (fm == null) return undefined
  if (typeof fm !== 'object') {
    errors.push({ path: `adapter.config.${key}`, message: 'must be an object' })
    return undefined
  }
  const fmo = fm as Record<string, unknown>
  const sessionId = pickString(fmo, 'sessionId')
  if (!sessionId) {
    errors.push({ path: `adapter.config.${key}.sessionId`, message: 'required string' })
  }
  return {
    sessionId: sessionId ?? '',
    name: pickString(fmo, 'name') ?? undefined,
    state: pickString(fmo, 'state') ?? undefined,
    summary: pickString(fmo, 'summary') ?? undefined,
    lastTransitionAt: pickString(fmo, 'lastTransitionAt') ?? undefined,
    processAlive: pickString(fmo, 'processAlive') ?? undefined,
    prUrl: pickString(fmo, 'prUrl') ?? undefined,
    prCheckStatus: pickString(fmo, 'prCheckStatus') ?? undefined,
    cwd: pickString(fmo, 'cwd') ?? undefined,
  }
}

const VALID_STATES: readonly SessionState[] = [
  'working',
  'needs-input',
  'idle',
  'completed',
  'failed',
  'stopped',
  'unknown',
]

function pickStateInference(
  o: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): StateInferenceRule[] | undefined {
  const v = o[key]
  if (v == null) return undefined
  if (!Array.isArray(v)) {
    errors.push({ path: `adapter.config.${key}`, message: 'must be an array of rules' })
    return undefined
  }
  const rules: StateInferenceRule[] = []
  v.forEach((entry, idx) => {
    const base = `adapter.config.${key}[${idx}]`
    if (!entry || typeof entry !== 'object') {
      errors.push({ path: base, message: 'rule must be an object' })
      return
    }
    const eo = entry as Record<string, unknown>
    const mapsTo = pickString(eo, 'mapsTo')
    if (!mapsTo || !(VALID_STATES as readonly string[]).includes(mapsTo)) {
      errors.push({
        path: `${base}.mapsTo`,
        message: `must be one of: ${VALID_STATES.join(', ')}`,
      })
      return
    }
    const name = pickString(eo, 'name') ?? undefined
    const whenRaw = eo.when
    if (!whenRaw || typeof whenRaw !== 'object') {
      errors.push({ path: `${base}.when`, message: 'required object' })
      return
    }
    const w = whenRaw as Record<string, unknown>
    const when: StateInferenceRule['when'] = {}
    // equals: dotted-path → string value map
    if (w.equals != null) {
      if (typeof w.equals !== 'object' || Array.isArray(w.equals)) {
        errors.push({ path: `${base}.when.equals`, message: 'must be an object' })
      } else {
        const equalsMap: Record<string, string> = {}
        for (const [k, val] of Object.entries(w.equals as Record<string, unknown>)) {
          if (typeof val !== 'string') {
            errors.push({
              path: `${base}.when.equals.${k}`,
              message: 'value must be a string',
            })
            continue
          }
          equalsMap[k] = val
        }
        if (Object.keys(equalsMap).length > 0) when.equals = equalsMap
      }
    }
    if (w.present != null) {
      const arr = pickStringArrayLoose(w.present)
      if (!arr) {
        errors.push({ path: `${base}.when.present`, message: 'must be string[]' })
      } else {
        when.present = arr
      }
    }
    if (w.absent != null) {
      const arr = pickStringArrayLoose(w.absent)
      if (!arr) {
        errors.push({ path: `${base}.when.absent`, message: 'must be string[]' })
      } else {
        when.absent = arr
      }
    }
    if (w.minAgeMs != null) {
      if (typeof w.minAgeMs !== 'number' || !Number.isFinite(w.minAgeMs) || w.minAgeMs < 0) {
        errors.push({ path: `${base}.when.minAgeMs`, message: 'must be a non-negative number' })
      } else {
        when.minAgeMs = w.minAgeMs
      }
    }
    if (w.against != null) {
      if (w.against !== 'tail' && w.against !== 'head') {
        errors.push({ path: `${base}.when.against`, message: "must be 'tail' or 'head'" })
      } else {
        when.against = w.against
      }
    }
    rules.push({ ...(name ? { name } : {}), mapsTo: mapsTo as SessionState, when })
  })
  return rules.length > 0 ? rules : undefined
}

function pickJoinLatest(
  o: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): SqliteJoinLatest | undefined {
  const v = o[key]
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) {
    errors.push({ path: `adapter.config.${key}`, message: 'must be an object' })
    return undefined
  }
  const vo = v as Record<string, unknown>
  const as = pickString(vo, 'as')
  const sql = pickString(vo, 'sql')
  const keyAs = pickString(vo, 'keyAs')
  if (!as || !/^[a-z][a-zA-Z0-9]*$/.test(as)) {
    errors.push({
      path: `adapter.config.${key}.as`,
      message: 'required identifier (lowerCamelCase)',
    })
  }
  if (!sql) {
    errors.push({ path: `adapter.config.${key}.sql`, message: 'required SELECT statement' })
  }
  if (sql) {
    // Defensive: manifests live in user-writable ~/.beto/plugins/. A
    // benign typo or copy-paste of a malicious snippet shouldn't be
    // able to issue arbitrary writes. Enforce single SELECT.
    const trimmed = sql.trim()
    if (!/^select\s/i.test(trimmed)) {
      errors.push({
        path: `adapter.config.${key}.sql`,
        message: 'must start with SELECT',
      })
    }
    // Allow a single trailing semicolon; reject any other.
    const withoutTrailing = trimmed.replace(/;\s*$/, '')
    if (withoutTrailing.includes(';')) {
      errors.push({
        path: `adapter.config.${key}.sql`,
        message: 'must be a single statement (no embedded semicolons)',
      })
    }
    if (!sql.includes(':sessionIds')) {
      errors.push({
        path: `adapter.config.${key}.sql`,
        message: 'must contain the :sessionIds placeholder',
      })
    }
  }
  if (!as || !sql) return undefined
  return { as, sql, ...(keyAs ? { keyAs } : {}) }
}

function pickStringArrayLoose(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  if (!v.every((x) => typeof x === 'string')) return null
  return v as string[]
}

function pickString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' ? v : null
}
function pickNumber(o: Record<string, unknown>, key: string): number | null {
  const v = o[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function pickStringArray(o: Record<string, unknown>, key: string): string[] | null {
  const v = o[key]
  if (!Array.isArray(v)) return null
  if (!v.every((x) => typeof x === 'string')) return null
  return v as string[]
}
