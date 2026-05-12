// sqlite-sessions-table adapter kind.
//
// Reads a SQLite database via the `sqlite3` CLI (no native binding,
// works on any system with sqlite3 on PATH — default on macOS and most
// Linux distros). Outputs JSON via `.mode json`, so we get a structured
// row stream without parsing custom CSV.
//
// Why shell out: avoiding better-sqlite3's native build keeps `bun add
// -g beto` working on machines without node-gyp, and avoids forcing
// Bun-only via bun:sqlite. The cost is one subprocess per poll; at 2s
// cadence with read budgets, that's negligible.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Adapter } from '../adapter.js'
import type { HarnessId, SessionSnapshot } from '../../lib/types.js'
import { normalizeState } from '../state.js'
import type {
  FieldMap,
  SqliteSessionsTableConfig,
} from '../../lib/manifest.ts'
import { expandTilde } from './directoryOfStateJson.js'

export interface SqliteSessionsTableOpts {
  id: HarnessId
  displayName: string
  config: SqliteSessionsTableConfig
  pollMs?: number
  readBudgetMs?: number
  now?: () => number
}

export class SqliteSessionsTableAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly dbPath: string
  private readonly table: string
  private readonly fieldMap: FieldMap
  private readonly where: string | null
  private readonly limit: number
  private readonly pollMs: number
  private readonly readBudgetMs: number
  private readonly now: () => number
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastEmitted: SessionSnapshot[] = []
  private lastDbMtime = 0

  constructor(opts: SqliteSessionsTableOpts) {
    this.id = opts.id
    this.displayName = opts.displayName
    this.dbPath = expandTilde(opts.config.dbPath)
    this.table = opts.config.table
    this.fieldMap = opts.config.fieldMap
    this.where = opts.config.where ?? null
    this.limit = opts.config.limit ?? 200
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
    // Cheap mtime check first — if the db hasn't changed since the last
    // scan, reuse the previous emission. Cuts subprocess overhead to
    // near-zero in idle sessions.
    try {
      const st = await fs.stat(this.dbPath)
      if (st.mtimeMs === this.lastDbMtime && this.lastEmitted.length > 0) {
        return this.lastEmitted
      }
      this.lastDbMtime = st.mtimeMs
    } catch {
      // db missing: emit empty rows and bail.
      if (this.lastEmitted.length > 0) {
        this.lastEmitted = []
        for (const fn of this.listeners) fn([])
      }
      return []
    }

    // Build a SELECT that aliases each fieldMap target to its
    // SessionSnapshot key, so the JSON output is already shaped correctly.
    const sql = this.buildSelect()
    let rows: unknown[]
    try {
      rows = await runSqliteJson(this.dbPath, sql, this.readBudgetMs)
    } catch {
      return this.lastEmitted
    }

    const snapshots: SessionSnapshot[] = []
    for (const r of rows) {
      const snap = this.toSnapshot(r)
      if (snap) snapshots.push(snap)
    }
    snapshots.sort(
      (a, b) =>
        b.lastTransitionAt - a.lastTransitionAt || a.sessionId.localeCompare(b.sessionId),
    )
    if (!shallowEqual(snapshots, this.lastEmitted)) {
      this.lastEmitted = snapshots
      for (const fn of this.listeners) fn(snapshots)
    }
    return snapshots
  }

  private buildSelect(): string {
    const fm = this.fieldMap
    const cols: Array<[string, string]> = [['sessionId', fm.sessionId]]
    if (fm.name) cols.push(['name', fm.name])
    if (fm.state) cols.push(['state', fm.state])
    if (fm.summary) cols.push(['summary', fm.summary])
    if (fm.lastTransitionAt) cols.push(['lastTransitionAt', fm.lastTransitionAt])
    if (fm.processAlive) cols.push(['processAlive', fm.processAlive])
    if (fm.prUrl) cols.push(['prUrl', fm.prUrl])
    if (fm.prCheckStatus) cols.push(['prCheckStatus', fm.prCheckStatus])
    if (fm.cwd) cols.push(['cwd', fm.cwd])
    const selectClause = cols
      .map(([alias, src]) => `"${src}" AS "${alias}"`)
      .join(', ')
    const where = this.where ? ` WHERE ${this.where}` : ''
    return `SELECT ${selectClause} FROM "${this.table}"${where} LIMIT ${this.limit}`
  }

  private toSnapshot(raw: unknown): SessionSnapshot | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : String(o.sessionId ?? '')
    if (!sessionId) return null
    const rawState = typeof o.state === 'string' ? o.state : String(o.state ?? '')
    return {
      harness: this.id,
      sessionId,
      name: asString(o.name) || (sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId),
      state: normalizeState(rawState),
      summary: asString(o.summary),
      lastTransitionAt: asNumber(o.lastTransitionAt) || 0,
      processAlive: asBool(o.processAlive) ?? true,
      prUrl: asString(o.prUrl),
      prCheckStatus: asString(o.prCheckStatus),
      cwd: asString(o.cwd),
      rawStateString: rawState,
    }
  }
}

// Run `sqlite3 <db> -json <sql>`. Resolves with the parsed rows array
// or throws on timeout/parse error. sqlite3 prints `[]` for empty
// result sets, so an empty resolve is just []—not an error.
async function runSqliteJson(
  dbPath: string,
  sql: string,
  timeoutMs: number,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (val: unknown[] | Error) => {
      if (settled) return
      settled = true
      val instanceof Error ? reject(val) : resolve(val)
    }
    // `-json` prints JSON rows. Quote the SQL as a positional arg.
    const child = spawn('sqlite3', ['-json', dbPath, sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    let err = ''
    child.stdout.on('data', (b) => {
      buf += String(b)
    })
    child.stderr.on('data', (b) => {
      err += String(b)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(new Error(`sqlite3 timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      finish(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        return finish(new Error(`sqlite3 exited ${code}: ${err.trim()}`))
      }
      const trimmed = buf.trim()
      if (!trimmed) return finish([])
      try {
        const parsed = JSON.parse(trimmed)
        finish(Array.isArray(parsed) ? parsed : [])
      } catch (e) {
        finish(e as Error)
      }
    })
  })
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}
function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return null
}

function shallowEqual(a: SessionSnapshot[], b: SessionSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.sessionId !== b[i]!.sessionId || a[i]!.state !== b[i]!.state) return false
  }
  return true
}
