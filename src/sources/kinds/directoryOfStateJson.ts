// directory-of-state-json adapter kind.
//
// Reads `<sessionId>/state.json` files from one or more state directories.
// Each session is identified by its directory name; the JSON body
// describes its current state. Same shape as Claude Code's
// ~/.claude/jobs/ layout — this kind generalizes ClaudeAdapter so any
// harness with the same scheme can ship as a manifest, not TS code.
//
// Field resolution uses the manifest's `fieldMap` first, then falls
// back to snake_case + camelCase variants of the SessionSnapshot field
// name (so Claude's untyped `session_id`/`sessionId` both work).

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Adapter } from '../adapter.js'
import type {
  HarnessId,
  SessionSnapshot,
  SessionState,
} from '../../lib/types.js'
import { normalizeState } from '../state.js'
import type {
  DirectoryOfStateJsonConfig,
  FieldMap,
} from '../../lib/manifest.ts'

const STALE_WORKING_MS = 5 * 60 * 1000

export interface DirectoryOfStateJsonOpts {
  id: HarnessId
  displayName: string
  config: DirectoryOfStateJsonConfig
  pollMs?: number
  readBudgetMs?: number
  now?: () => number
}

interface CacheEntry {
  mtimeMs: number
  snapshot: SessionSnapshot
}

export class DirectoryOfStateJsonAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly stateDirs: string[]
  private readonly fieldMap: FieldMap | undefined
  private readonly pollMs: number
  private readonly readBudgetMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastEmitted: SessionSnapshot[] = []

  constructor(opts: DirectoryOfStateJsonOpts) {
    this.id = opts.id
    this.displayName = opts.displayName
    this.stateDirs = opts.config.stateDirs.map(expandTilde)
    this.fieldMap = opts.config.fieldMap
    this.pollMs = opts.pollMs ?? 2000
    this.readBudgetMs = opts.readBudgetMs ?? 1500
    this.now = opts.now ?? (() => Date.now())
  }

  start(): void {
    if (this.timer) return
    void this.scan()
    this.timer = setInterval(() => void this.scan(), this.pollMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  onChange(fn: (rows: SessionSnapshot[]) => void): () => void {
    this.listeners.add(fn)
    if (this.lastEmitted.length > 0) fn(this.lastEmitted)
    return () => this.listeners.delete(fn)
  }

  async scan(): Promise<SessionSnapshot[]> {
    const deadline = this.now() + this.readBudgetMs
    const rows: SessionSnapshot[] = []
    for (const stateDir of this.stateDirs) {
      if (this.now() > deadline) break
      const files = await listSessionFiles(stateDir)
      for (const filePath of files) {
        if (this.now() > deadline) break
        const row = await this.readOne(filePath)
        if (row) rows.push(row)
      }
    }
    rows.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt || a.sessionId.localeCompare(b.sessionId))
    if (!shallowEqual(rows, this.lastEmitted)) {
      this.lastEmitted = rows
      for (const fn of this.listeners) fn(rows)
    }
    return rows
  }

  private async readOne(filePath: string): Promise<SessionSnapshot | null> {
    let mtimeMs: number
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return null
      mtimeMs = stat.mtimeMs
    } catch {
      return null
    }
    const cached = this.cache.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.snapshot
    let json: unknown
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      json = JSON.parse(raw)
    } catch {
      return cached?.snapshot ?? null
    }
    const snap = this.parse(json, mtimeMs)
    if (snap) this.cache.set(filePath, { mtimeMs, snapshot: snap })
    return snap
  }

  private parse(json: unknown, mtimeMs: number): SessionSnapshot | null {
    if (!json || typeof json !== 'object') return null
    const obj = json as Record<string, unknown>
    const fm = this.fieldMap
    const sessionId = pickField(obj, fm?.sessionId, ['session_id', 'sessionId', 'id'])
    if (!sessionId) return null
    const rawState = pickField(obj, fm?.state, ['state', 'status'])
    let state: SessionState = normalizeState(rawState)
    const rawAlive = pickFieldBool(obj, fm?.processAlive, [
      'process_alive',
      'processAlive',
      'alive',
    ])
    let processAlive = rawAlive ?? true
    if (state === 'working' && mtimeMs > 0 && this.now() - mtimeMs >= STALE_WORKING_MS) {
      state = 'stopped'
      processAlive = false
    }
    const lastTransitionAt =
      pickFieldNumber(obj, fm?.lastTransitionAt, [
        'last_transition_at',
        'lastTransitionAt',
        'updated_at',
        'updatedAt',
        'mtime_ms',
      ]) || mtimeMs
    const fallbackName = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
    return {
      harness: this.id,
      sessionId,
      name: pickField(obj, fm?.name, ['name', 'title']) || fallbackName,
      state,
      summary: pickField(obj, fm?.summary, ['summary', 'activity', 'description']),
      lastTransitionAt,
      processAlive,
      prUrl: pickField(obj, fm?.prUrl, ['pr_url', 'prUrl', 'pull_request_url', 'pullRequestUrl']),
      prCheckStatus: pickField(obj, fm?.prCheckStatus, [
        'pr_check_status',
        'prCheckStatus',
        'ci_status',
        'ciStatus',
        'checks_status',
      ]),
      cwd: pickField(obj, fm?.cwd, ['cwd', 'working_directory', 'workingDirectory']),
      rawStateString: rawState,
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

async function listSessionFiles(stateDir: string): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(stateDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    const candidate = path.join(stateDir, name, 'state.json')
    try {
      const st = await fs.stat(candidate)
      if (st.isFile()) out.push(candidate)
    } catch {
      // skip non-session entries
    }
  }
  return out
}

function pickField(
  obj: Record<string, unknown>,
  mapped: string | undefined,
  fallbacks: readonly string[],
): string {
  const keys = mapped ? [mapped, ...fallbacks] : fallbacks
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string') return v
  }
  return ''
}

function pickFieldNumber(
  obj: Record<string, unknown>,
  mapped: string | undefined,
  fallbacks: readonly string[],
): number {
  const keys = mapped ? [mapped, ...fallbacks] : fallbacks
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return 0
}

function pickFieldBool(
  obj: Record<string, unknown>,
  mapped: string | undefined,
  fallbacks: readonly string[],
): boolean | null {
  const keys = mapped ? [mapped, ...fallbacks] : fallbacks
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'boolean') return v
  }
  return null
}

export function expandTilde(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p === '~') return os.homedir()
  return p
}

function shallowEqual(a: SessionSnapshot[], b: SessionSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.harness !== y.harness ||
      x.sessionId !== y.sessionId ||
      x.state !== y.state ||
      x.summary !== y.summary ||
      x.lastTransitionAt !== y.lastTransitionAt ||
      x.prUrl !== y.prUrl
    ) {
      return false
    }
  }
  return true
}
