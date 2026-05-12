// jsonl-tail adapter kind.
//
// Each session = one JSONL file. The latest record in each file is the
// snapshot of "what is this session doing now." Covers Aider, Open
// Interpreter, and similar tools that journal conversation events to
// disk one line at a time.
//
// Reading strategy: glob the file pattern, take the last N lines of
// each (default 100), parse JSON line-by-line from the end, emit the
// most recent fully-valid record per file. Cheap because we never
// re-read the whole file — only the tail.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Adapter } from '../adapter.js'
import type { HarnessId, SessionSnapshot } from '../../lib/types.js'
import { normalizeState } from '../state.js'
import type { FieldMap, JsonlTailConfig } from '../../lib/manifest.ts'
import { expandTilde } from './directoryOfStateJson.js'

export interface JsonlTailOpts {
  id: HarnessId
  displayName: string
  config: JsonlTailConfig
  pollMs?: number
  readBudgetMs?: number
  now?: () => number
}

export class JsonlTailAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly fileGlob: string
  private readonly fieldMap: FieldMap
  private readonly tailLines: number
  private readonly pollMs: number
  private readonly readBudgetMs: number
  private readonly now: () => number
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private timer: NodeJS.Timeout | null = null
  private lastEmitted: SessionSnapshot[] = []

  constructor(opts: JsonlTailOpts) {
    this.id = opts.id
    this.displayName = opts.displayName
    this.fileGlob = expandTilde(opts.config.fileGlob)
    this.fieldMap = opts.config.fieldMap
    this.tailLines = opts.config.tailLines ?? 100
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
    const files = await expandGlob(this.fileGlob)
    const snapshots: SessionSnapshot[] = []
    for (const file of files) {
      if (this.now() > deadline) break
      const snap = await this.readOne(file)
      if (snap) snapshots.push(snap)
    }
    snapshots.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
    if (!shallowEqual(snapshots, this.lastEmitted)) {
      this.lastEmitted = snapshots
      for (const fn of this.listeners) fn(snapshots)
    }
    return snapshots
  }

  private async readOne(filePath: string): Promise<SessionSnapshot | null> {
    let mtimeMs: number
    let size: number
    try {
      const st = await fs.stat(filePath)
      if (!st.isFile()) return null
      mtimeMs = st.mtimeMs
      size = st.size
    } catch {
      return null
    }
    // Read up to last ~16KB; that's plenty for the trailing N records
    // of a typical JSONL stream. Reading from the end requires opening
    // and seeking — fs.open + read.
    const lines = await tailLines(filePath, size, 16 * 1024, this.tailLines)
    // Walk from the end; the first parseable line is the current state.
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i]!.trim()
      if (!raw) continue
      let obj: unknown
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      const snap = this.parse(obj, filePath, mtimeMs)
      if (snap) return snap
    }
    return null
  }

  private parse(
    json: unknown,
    filePath: string,
    mtimeMs: number,
  ): SessionSnapshot | null {
    if (!json || typeof json !== 'object') return null
    const obj = json as Record<string, unknown>
    const fm = this.fieldMap
    let sessionId = pickField(obj, fm.sessionId)
    // Fall back to the file basename so a tool that doesn't include a
    // session id in each record still gets one row per file.
    if (!sessionId) sessionId = path.basename(filePath, path.extname(filePath))
    if (!sessionId) return null
    const rawState = fm.state ? pickField(obj, fm.state) : ''
    const state = rawState ? normalizeState(rawState) : 'working'
    const lastTransitionAt = fm.lastTransitionAt
      ? pickFieldNumber(obj, fm.lastTransitionAt) || mtimeMs
      : mtimeMs
    const fallbackName = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
    return {
      harness: this.id,
      sessionId,
      name: fm.name ? pickField(obj, fm.name) || fallbackName : fallbackName,
      state,
      summary: fm.summary ? pickField(obj, fm.summary) : '',
      lastTransitionAt,
      processAlive: true,
      prUrl: fm.prUrl ? pickField(obj, fm.prUrl) : '',
      prCheckStatus: fm.prCheckStatus ? pickField(obj, fm.prCheckStatus) : '',
      cwd: fm.cwd ? pickField(obj, fm.cwd) : '',
      rawStateString: rawState,
    }
  }
}

// Read at most `maxBytes` bytes from the tail of a file, split into
// lines, return up to `maxLines` of them. Designed for JSONL files
// where each line is independent and the most recent record is at the
// end. The leading partial line (if any) is discarded.
async function tailLines(
  filePath: string,
  size: number,
  maxBytes: number,
  maxLines: number,
): Promise<string[]> {
  if (size === 0) return []
  const fh = await fs.open(filePath, 'r')
  try {
    const bytesToRead = Math.min(size, maxBytes)
    const offset = size - bytesToRead
    const buf = Buffer.alloc(bytesToRead)
    await fh.read(buf, 0, bytesToRead, offset)
    let text = buf.toString('utf-8')
    if (offset > 0) {
      // Drop the leading partial line.
      const firstNl = text.indexOf('\n')
      if (firstNl >= 0) text = text.slice(firstNl + 1)
    }
    const lines = text.split('\n')
    return lines.slice(-maxLines)
  } finally {
    await fh.close()
  }
}

// Minimal globbing — supports `~/path/to/*.jsonl` and `~/path/**/*.jsonl`.
// Built without a dep because Node's `fs.glob` isn't stable until 22
// and we still target 18. Two patterns: '*' (single segment) and '**'
// (recursive).
async function expandGlob(pattern: string): Promise<string[]> {
  const segments = pattern.split('/')
  if (!segments.some((s) => s.includes('*'))) {
    try {
      const st = await fs.stat(pattern)
      if (st.isFile()) return [pattern]
    } catch {
      // not found
    }
    return []
  }
  // Walk from the first concrete prefix, then accumulate matches.
  let bases: string[] = ['/']
  if (pattern.startsWith('/')) {
    bases = ['/']
  } else if (pattern.startsWith('~')) {
    bases = [expandTilde(segments[0]!)]
    segments.shift()
  } else {
    bases = [process.cwd()]
  }
  for (const seg of segments) {
    if (!seg) continue
    if (seg === '**') {
      bases = await Promise.all(bases.map((b) => walkRecursive(b))).then((arrs) => arrs.flat())
    } else if (seg.includes('*')) {
      const re = globSegmentToRegex(seg)
      const nextBases: string[] = []
      for (const b of bases) {
        let entries: string[] = []
        try {
          entries = await fs.readdir(b)
        } catch {
          continue
        }
        for (const name of entries) {
          if (re.test(name)) nextBases.push(path.join(b, name))
        }
      }
      bases = nextBases
    } else {
      bases = bases.map((b) => path.join(b, seg))
    }
  }
  // Filter to files only.
  const out: string[] = []
  for (const candidate of bases) {
    try {
      const st = await fs.stat(candidate)
      if (st.isFile()) out.push(candidate)
    } catch {
      // skip
    }
  }
  return out
}

async function walkRecursive(root: string): Promise<string[]> {
  const out: string[] = [root]
  let entries: string[] = []
  try {
    entries = await fs.readdir(root)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = path.join(root, name)
    try {
      const st = await fs.stat(p)
      if (st.isDirectory()) {
        out.push(...(await walkRecursive(p)))
      }
    } catch {
      // skip
    }
  }
  return out
}

function globSegmentToRegex(seg: string): RegExp {
  const escaped = seg
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp('^' + escaped + '$')
}

function pickField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
function pickFieldNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
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
