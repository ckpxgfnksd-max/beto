// process-watch-only adapter kind.
//
// For agent CLIs that write nothing useful per session (Aider's
// `.aider.chat.history.md` is per-repo with no central index; some
// home-grown ollama-based agents likewise). We can't introspect their
// state, but we can at least *show that they are running* — one row
// per matching process, with the process command line as the summary.
//
// Detection is via `detect.scanProcesses`. We match by basename
// against the manifest's `binary` (passed in via opts.binary), so the
// caller picks which command names count as a "session."

import { scanProcesses } from '../../lib/detect.js'
import type { Adapter } from '../adapter.js'
import type { HarnessId, SessionSnapshot } from '../../lib/types.js'
import type { ProcessWatchOnlyConfig } from '../../lib/manifest.ts'
import * as path from 'node:path'

export interface ProcessWatchOnlyOpts {
  id: HarnessId
  displayName: string
  binary: string | undefined
  config: ProcessWatchOnlyConfig
  pollMs?: number
  readBudgetMs?: number
  now?: () => number
}

export class ProcessWatchOnlyAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly matchBinary: string | null
  private readonly stateOnRunning: 'working' | 'idle'
  private readonly pollMs: number
  private readonly readBudgetMs: number
  private readonly now: () => number
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastEmitted: SessionSnapshot[] = []

  constructor(opts: ProcessWatchOnlyOpts) {
    this.id = opts.id
    this.displayName = opts.displayName
    this.matchBinary = opts.binary ?? null
    this.stateOnRunning = opts.config.stateOnRunning ?? 'working'
    this.pollMs = opts.pollMs ?? 3000 // process scan is slightly more expensive
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
    if (!this.matchBinary) return this.emit([])
    const procs = await scanProcesses(this.readBudgetMs).catch(() => [])
    const matches = procs.filter((cmd) => {
      const first = cmd.trim().split(/\s+/)[0]
      if (!first) return false
      const base = path.basename(first)
      return base === this.matchBinary
    })
    const now = this.now()
    // Synthesize one row per matching process. Without a real session id,
    // we hash the command line so multiple invocations stay distinguishable.
    const snapshots: SessionSnapshot[] = matches.map((cmd, i) => {
      const sessionId = `${this.id}:${hashStr(cmd) || String(i)}`
      return {
        harness: this.id,
        sessionId,
        name: `${this.displayName}#${i + 1}`,
        state: this.stateOnRunning,
        summary: truncate(cmd, 120),
        lastTransitionAt: now,
        processAlive: true,
        prUrl: '',
        prCheckStatus: '',
        cwd: '',
        rawStateString: this.stateOnRunning,
      }
    })
    return this.emit(snapshots)
  }

  private emit(snapshots: SessionSnapshot[]): SessionSnapshot[] {
    if (!shallowEqual(snapshots, this.lastEmitted)) {
      this.lastEmitted = snapshots
      for (const fn of this.listeners) fn(snapshots)
    }
    return snapshots
  }
}

function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31 + s.charCodeAt(i)) >>> 0) | 0
  return h.toString(16)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function shallowEqual(a: SessionSnapshot[], b: SessionSnapshot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.sessionId !== b[i]!.sessionId) return false
  }
  return true
}
