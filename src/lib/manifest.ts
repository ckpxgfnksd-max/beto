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

import type { HarnessId } from './types.js'

// ─── Adapter kinds ───────────────────────────────────────────────────

export type AdapterKind =
  | 'directory-of-state-json'
  | 'sqlite-sessions-table'
  | 'jsonl-tail'
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
export interface SqliteSessionsTableConfig {
  dbPath: string
  table: string
  fieldMap: FieldMap
  where?: string
  limit?: number
}

// Kind: jsonl-tail. Each session is one JSONL file; the latest record is
// the source of truth for the session's current state.
export interface JsonlTailConfig {
  fileGlob: string
  fieldMap: FieldMap
  tailLines?: number
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
  | { kind: 'process-watch-only'; config: ProcessWatchOnlyConfig }

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
      return {
        kind,
        config: {
          dbPath,
          table,
          fieldMap,
          ...(where ? { where } : {}),
          ...(limit ? { limit } : {}),
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
      return { kind, config: { fileGlob, fieldMap, ...(tailLines ? { tailLines } : {}) } }
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
