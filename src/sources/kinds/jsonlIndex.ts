// jsonl-index adapter kind (spec draft 0.1).
//
// One JSONL file where each line is a separate session — the file is an
// index of all known sessions, NOT a per-session transcript.
//
// Verified against Codex's `~/.codex/session_index.jsonl` on 2026-05-12;
// each record looks like:
//   {"id":"019dd...","thread_name":"Build x agent","updated_at":"2026-04-29T11:16:37.130813Z"}
//
// Distinct from `jsonl-tail` (which reads ONE file per session and takes
// the last record as current state). Here we read ONE file total and
// treat every line as a row.
//
// State inference: JSONL index records carry no live-state field. We
// infer state from age of `lastTransitionAt`:
//   < 30s     working   (just updated, probably running)
//   < 5 min   idle      (recently active, may still be open)
//   ≥ 5 min   completed (almost certainly not active)
// Without this, 100+ historical sessions flood the Active bucket of any
// inbox UI on first load. Mirrors synthesizeFromTranscript in state.ts.
//
// Performance: read-whole-file. Acceptable because session indexes are
// typically a few KB to a few hundred KB even for power users (Codex's
// is ~5KB for 16 sessions). If we ever see a multi-MB index, switch to
// streaming.

const FRESH_WORKING_MS = 30 * 1000
const FRESH_IDLE_MS = 5 * 60 * 1000

import { promises as fs } from 'node:fs'
import type { Adapter } from '../adapter.js'
import type { HarnessId, SessionSnapshot } from '../../lib/types.js'
import { normalizeState } from '../state.js'
import type { FieldMap, JsonlIndexConfig } from '../../lib/manifest.ts'
import { expandTilde } from './directoryOfStateJson.js'

export interface JsonlIndexOpts {
  id: HarnessId
  displayName: string
  config: JsonlIndexConfig
  pollMs?: number
  readBudgetMs?: number
  now?: () => number
}

export class JsonlIndexAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly filePath: string
  private readonly fieldMap: FieldMap
  private readonly pollMs: number
  private readonly readBudgetMs: number
  private readonly now: () => number
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastEmitted: SessionSnapshot[] = []
  private lastMtimeMs = 0

  constructor(opts: JsonlIndexOpts) {
    this.id = opts.id
    this.displayName = opts.displayName
    this.filePath = expandTilde(opts.config.filePath)
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
    let mtimeMs: number
    try {
      const st = await fs.stat(this.filePath)
      if (!st.isFile()) return this.emit([])
      mtimeMs = st.mtimeMs
    } catch {
      // File missing: harness probably not installed. Idle silently.
      return this.emit([])
    }
    // mtime-cached: if the index file hasn't changed, skip the parse.
    if (mtimeMs === this.lastMtimeMs && this.lastEmitted.length > 0) {
      return this.lastEmitted
    }
    this.lastMtimeMs = mtimeMs

    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf-8')
    } catch {
      return this.lastEmitted
    }

    const fm = this.fieldMap
    const rows: SessionSnapshot[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!obj || typeof obj !== 'object') continue
      const o = obj as Record<string, unknown>
      const sessionId = readString(o, fm.sessionId)
      if (!sessionId) continue
      const rawState = fm.state ? readString(o, fm.state) : ''
      const fallbackName = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
      const lastTransitionAt = fm.lastTransitionAt
        ? readTimestamp(o, fm.lastTransitionAt)
        : 0

      // State inference: prefer the explicit field if mapped + present;
      // otherwise age-based heuristic (working / idle / completed).
      let state: SessionSnapshot['state']
      if (rawState) {
        state = normalizeState(rawState)
      } else if (lastTransitionAt > 0) {
        const age = this.now() - lastTransitionAt
        if (age < FRESH_WORKING_MS) state = 'working'
        else if (age < FRESH_IDLE_MS) state = 'idle'
        else state = 'completed'
      } else {
        state = 'idle'
      }

      rows.push({
        harness: this.id,
        sessionId,
        name: fm.name ? readString(o, fm.name) || fallbackName : fallbackName,
        state,
        summary: fm.summary ? readString(o, fm.summary) : '',
        lastTransitionAt,
        processAlive: state === 'working' || state === 'idle',
        prUrl: fm.prUrl ? readString(o, fm.prUrl) : '',
        prCheckStatus: fm.prCheckStatus ? readString(o, fm.prCheckStatus) : '',
        cwd: fm.cwd ? readString(o, fm.cwd) : '',
        rawStateString: rawState,
      })
    }
    rows.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
    return this.emit(rows)
  }

  private emit(rows: SessionSnapshot[]): SessionSnapshot[] {
    if (!shallowEqual(rows, this.lastEmitted)) {
      this.lastEmitted = rows
      for (const fn of this.listeners) fn(rows)
    }
    return rows
  }
}

function readString(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

// Timestamps may be ISO 8601 strings (Codex) or numeric ms-since-epoch.
// Normalize either form to ms.
function readTimestamp(o: Record<string, unknown>, key: string): number {
  const v = o[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const parsed = Date.parse(v)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function shallowEqual(a: SessionSnapshot[], b: SessionSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.sessionId !== b[i]!.sessionId || a[i]!.lastTransitionAt !== b[i]!.lastTransitionAt) {
      return false
    }
  }
  return true
}
