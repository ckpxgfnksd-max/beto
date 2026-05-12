// state.json reader. Ported from aggro/src-tauri/src/state_tailer.rs.
//
// `~/.claude/jobs/<id>/state.json` is the canonical "what is each Claude
// Code session doing" file the supervisor maintains and `claude agents`
// reads. v0 of beto reads only this source — no hook installation
// required, zero install friction, works whether or not Claude Code is
// running right now.
//
// Defensive parsing: every field except sessionId + state is best-effort.
// Unknown fields are ignored; unknown state strings fall through to
// 'unknown' so a future Claude Code release that adds a state never
// drops a row.
//
// Polling: 2s. The Rust version used notify (kqueue/inotify) + 5s fallback;
// 2s polling on a directory with <50 entries is fine for v0 and ships
// cross-platform without a notify shim. Upgrade if we ever feel the lag.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { HarnessId, SessionSnapshot, SessionState } from '../lib/types.js'
import type { Adapter } from './adapter.js'
import { ClaudeTranscriptReader, type TokenSnapshot } from './tokens/transcript.js'

// Working session with state.json mtime older than this is treated as dead
// regardless of what the JSON says. The supervisor reaps idle processes
// after ~1h; 5min keeps beto honest about stuck/dead working sessions.
const STALE_WORKING_MS = 5 * 60 * 1000

// Per-file cache: skip parse if mtime unchanged since last scan.
interface FileCache {
  mtimeMs: number
  snapshot: SessionSnapshot
}

export interface StateReaderOptions {
  // Override for testing. Defaults to ~/.claude/jobs/.
  jobsDir?: string
  // Override for testing. Defaults to ~/.claude/projects/.
  projectsDir?: string
  // Override for testing. Defaults to Date.now.
  now?: () => number
  // Poll interval. Default 2000ms.
  pollMs?: number
  // Set to false to skip the JSONL transcript pass (state.json only).
  // Default true: also read transcripts so we get tokens and surface
  // foreground sessions that don't have a state.json entry.
  readTranscripts?: boolean
}

export class ClaudeAdapter implements Adapter {
  readonly id: HarnessId = 'claude'
  readonly displayName = 'Claude Code'

  private readonly jobsDir: string
  private readonly now: () => number
  private readonly pollMs: number
  private readonly cache = new Map<string, FileCache>()
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastEmitted: SessionSnapshot[] = []
  private readonly transcriptReader: ClaudeTranscriptReader | null

  constructor(opts: StateReaderOptions = {}) {
    this.jobsDir = opts.jobsDir ?? path.join(os.homedir(), '.claude', 'jobs')
    this.now = opts.now ?? (() => Date.now())
    this.pollMs = opts.pollMs ?? 2000
    this.transcriptReader =
      opts.readTranscripts === false
        ? null
        : new ClaudeTranscriptReader({
            projectsDir: opts.projectsDir,
            now: this.now,
          })
  }

  // Start the polling loop. Fires the first scan immediately so the UI
  // doesn't sit empty for 2s on launch.
  start(): void {
    if (this.timer) return
    void this.scan()
    this.timer = setInterval(() => {
      void this.scan()
    }, this.pollMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // Subscribe to scan results. The full list of snapshots is emitted on
  // every scan that produces a change vs the prior emit. Returns an
  // unsubscribe function.
  onChange(fn: (rows: SessionSnapshot[]) => void): () => void {
    this.listeners.add(fn)
    if (this.lastEmitted.length > 0) fn(this.lastEmitted)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // One scan pass. Reads state.json (the supervisor's authoritative
  // status file when present) and ~/.claude/projects/*/<sid>.jsonl
  // transcripts in parallel, then merges:
  //
  //   - state.json rows are authoritative for state / summary / pr.
  //   - JSONL tokens enrich every row that has a matching sessionId.
  //   - JSONL also synthesizes a row for any session that has a recent
  //     transcript but no state.json entry — that's the common case for
  //     foreground `claude` sessions (no supervisor state file written).
  //
  // Returns the merged + emitted list.
  async scan(): Promise<SessionSnapshot[]> {
    const [stateRows, tokenSnaps] = await Promise.all([
      this.scanStateDir(),
      this.transcriptReader ? this.transcriptReader.scan() : Promise.resolve(new Map<string, TokenSnapshot>()),
    ])

    // Index state.json rows by sessionId for the merge.
    const byId = new Map<string, SessionSnapshot>()
    for (const row of stateRows) byId.set(row.sessionId, row)

    // Enrich existing rows with token data; synthesize new ones for
    // sessionIds present only in transcripts.
    for (const [sessionId, tok] of tokenSnaps) {
      const existing = byId.get(sessionId)
      if (existing) {
        byId.set(sessionId, applyTokens(existing, tok))
      } else {
        const synth = synthesizeFromTranscript(sessionId, tok, this.now())
        if (synth) byId.set(sessionId, synth)
      }
    }

    const merged = [...byId.values()].sort((a, b) => {
      if (a.lastTransitionAt !== b.lastTransitionAt) {
        return b.lastTransitionAt - a.lastTransitionAt
      }
      return a.sessionId.localeCompare(b.sessionId)
    })
    return this.emit(merged)
  }

  // The original v0.1 behavior — scan ~/.claude/jobs/<id>/state.json. Now
  // a helper called by `scan()` and combined with transcript data.
  private async scanStateDir(): Promise<SessionSnapshot[]> {
    let entries: string[] = []
    try {
      entries = await fs.readdir(this.jobsDir)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      process.stderr.write(`beto: scan ${this.jobsDir} failed: ${String(e)}\n`)
      return []
    }
    const rows: SessionSnapshot[] = []
    for (const id of entries) {
      const filePath = path.join(this.jobsDir, id, 'state.json')
      const row = await this.readOne(filePath)
      if (row) rows.push(row)
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
      // Parse errors are common during atomic writes (file exists but is
      // truncated mid-rewrite). Skip; the next poll picks up the rewrite.
      return cached?.snapshot ?? null
    }

    const parsed = parseState(json, mtimeMs, this.now())
    if (!parsed) return null

    this.cache.set(filePath, { mtimeMs, snapshot: parsed })
    return parsed
  }

  private emit(rows: SessionSnapshot[]): SessionSnapshot[] {
    if (!shallowEqualRows(rows, this.lastEmitted)) {
      this.lastEmitted = rows
      for (const fn of this.listeners) fn(rows)
    }
    return rows
  }
}

// Parse a state.json body into a snapshot. Returns null when the file
// lacks a session id — we have nowhere to attach the row otherwise.
// Field-name resolution is tolerant: snake_case + camelCase variants both
// match. mtimeMs is the file mtime (for stale-working override + as a
// fallback for lastTransitionAt when the JSON doesn't carry one).
export function parseState(
  json: unknown,
  mtimeMs: number,
  nowMs: number,
): SessionSnapshot | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>

  const sessionId = pickStr(obj, ['session_id', 'sessionId', 'id'])
  if (!sessionId) return null

  const rawState = pickStr(obj, ['state', 'status'])
  let state = normalizeState(rawState)
  const rawAlive = pickBool(obj, ['process_alive', 'processAlive', 'alive'], true)

  // Stale-mtime override: working sessions whose file hasn't been touched
  // in 5min are presumed reaped by the supervisor.
  let processAlive = rawAlive
  if (state === 'working' && mtimeMs > 0 && nowMs - mtimeMs >= STALE_WORKING_MS) {
    state = 'stopped'
    processAlive = false
  }

  const lastTransitionAt =
    pickU64(obj, ['last_transition_at', 'lastTransitionAt', 'updated_at', 'updatedAt', 'mtime_ms']) ||
    mtimeMs

  const fallbackName = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId

  return {
    harness: 'claude',
    sessionId,
    name: pickStr(obj, ['name', 'title']) || fallbackName,
    state,
    summary: pickStr(obj, ['summary', 'activity', 'description']),
    lastTransitionAt,
    processAlive,
    prUrl: pickStr(obj, ['pr_url', 'prUrl', 'pull_request_url', 'pullRequestUrl']),
    prCheckStatus: pickStr(obj, [
      'pr_check_status',
      'prCheckStatus',
      'ci_status',
      'ciStatus',
      'checks_status',
    ]),
    cwd: pickStr(obj, ['cwd', 'working_directory', 'workingDirectory']),
    rawStateString: rawState,
  }
}

function pickStr(o: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string') return v
  }
  return ''
}

function pickU64(o: Record<string, unknown>, keys: readonly string[]): number {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return 0
}

function pickBool(o: Record<string, unknown>, keys: readonly string[], dflt: boolean): boolean {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'boolean') return v
  }
  return dflt
}

export function normalizeState(raw: string): SessionState {
  const canon = raw.trim().toLowerCase().replace(/_/g, '-').replace(/ /g, '-')
  switch (canon) {
    case 'working':
    case 'running':
    case 'active':
      return 'working'
    case 'needs-input':
    case 'needsinput':
    case 'blocked':
    case 'waiting-for-input':
      return 'needs-input'
    case 'idle':
    case 'waiting':
      return 'idle'
    case 'completed':
    case 'done':
    case 'finished':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
    case 'errored':
      return 'failed'
    case 'stopped':
    case 'killed':
    case 'cancelled':
    case 'canceled':
      return 'stopped'
    default:
      return 'unknown'
  }
}

function shallowEqualRows(a: SessionSnapshot[], b: SessionSnapshot[]): boolean {
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
      x.processAlive !== y.processAlive ||
      x.prUrl !== y.prUrl ||
      x.prCheckStatus !== y.prCheckStatus ||
      x.tokensIn !== y.tokensIn ||
      x.tokensOut !== y.tokensOut ||
      x.tokenRateLast60s !== y.tokenRateLast60s
    ) {
      return false
    }
  }
  return true
}

// Decorate an existing SessionSnapshot with token data pulled from the
// transcript. Pure: returns a new snapshot. Used when state.json and
// transcript both speak about the same sessionId.
export function applyTokens(row: SessionSnapshot, tok: TokenSnapshot): SessionSnapshot {
  return {
    ...row,
    tokensIn: tok.tokensIn,
    tokensOut: tok.tokensOut,
    tokenRateLast60s: tok.tokenRateLast60s,
  }
}

// Build a snapshot for a session that only the transcript knows about
// (no state.json). State is inferred from recent activity: assistant
// message in the last 30s → working; in the last 5min → idle; else
// completed. Returns null for transcripts with zero activity.
const RECENT_WORKING_MS = 30 * 1000
const RECENT_IDLE_MS = 5 * 60 * 1000
export function synthesizeFromTranscript(
  sessionId: string,
  tok: TokenSnapshot,
  nowMs: number,
): SessionSnapshot | null {
  if (tok.lastAssistantAt === 0) return null
  const age = nowMs - tok.lastAssistantAt
  let state: SessionState
  if (age < RECENT_WORKING_MS) state = 'working'
  else if (age < RECENT_IDLE_MS) state = 'idle'
  else state = 'completed'
  const fallbackName = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
  return {
    harness: 'claude',
    sessionId,
    name: fallbackName,
    state,
    summary: '',
    lastTransitionAt: tok.lastAssistantAt,
    processAlive: age < RECENT_IDLE_MS,
    prUrl: '',
    prCheckStatus: '',
    cwd: '',
    rawStateString: '',
    tokensIn: tok.tokensIn,
    tokensOut: tok.tokensOut,
    tokenRateLast60s: tok.tokenRateLast60s,
  }
}

// Back-compat: keep StateReader as an alias for ClaudeAdapter so v0.1
// imports + tests keep working. Drop in a future major bump.
export { ClaudeAdapter as StateReader }
