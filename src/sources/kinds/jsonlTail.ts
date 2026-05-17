// jsonl-tail adapter kind.
//
// Each session = one JSONL file. The latest record in each file is the
// snapshot of "what is this session doing now." Covers Aider, Open
// Interpreter, Codex (rollout files), and similar tools that journal
// conversation events to disk one line at a time.
//
// Reading strategy: glob the file pattern, take the last N lines of
// each (default 100), parse JSON line-by-line from the end, emit the
// most recent fully-valid record per file. Cheap because we never
// re-read the whole file — only the tail.
//
// Codex extras (opt-in via manifest):
//   - headFieldMap: pull static metadata (cwd, originator, sessionId)
//     from the FIRST line of each file (a `session_meta` record in
//     Codex's case). Fills slots the tail record didn't supply.
//   - exclude: drop the file entirely if the head record matches a
//     simple `field == equals` predicate. Codex Desktop writes guardian
//     subagent rollouts with `payload.thread_source: "subagent"` — we
//     don't want every internal policy-check showing up in the inbox.
//   - Field-map values support dotted paths (`payload.cwd`) for nested
//     JSON. Flat keys still resolve normally.
//
// State inference (when no `state` field is mapped): age of
// `lastTransitionAt` (or file mtime if unmapped):
//   < 30s     working
//   < 5 min   idle
//   ≥ 5 min   completed
// Without this, historical rollouts going back weeks would all show as
// `working`. Mirrors the same heuristic in jsonl-index.

const FRESH_WORKING_MS = 30 * 1000
const FRESH_IDLE_MS = 5 * 60 * 1000

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Adapter } from '../adapter.js'
import type { HarnessId, SessionSnapshot } from '../../lib/types.js'
import { normalizeState } from '../state.js'
import type { FieldMap, JsonlTailConfig, StateInferenceRule } from '../../lib/manifest.ts'
import {
  readDotted,
  readDottedString,
  readDottedTimestamp,
  toStringOrEmpty,
} from '../dotted.js'
import { applyStateInference } from '../stateInference.js'
import { expandTilde } from './directoryOfStateJson.js'

export interface JsonlTailOpts {
  id: HarnessId
  displayName: string
  config: JsonlTailConfig
  pollMs?: number
  readBudgetMs?: number
  now?: () => number
}

// Matches the trailing UUID in Codex rollout filenames:
//   rollout-2026-05-17T10-33-23-019e3511-8ea7-7cb3-9ae1-a4426936d3ed.jsonl
//                              └──────────────── captured ────────────────┘
const UUID_SUFFIX_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^.]+$/i

export class JsonlTailAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly fileGlob: string
  private readonly fieldMap: FieldMap
  private readonly headFieldMap?: FieldMap
  private readonly exclude?: { field: string; equals: string }
  private readonly tailLines: number
  private readonly stateInference?: readonly StateInferenceRule[]
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
    this.headFieldMap = opts.config.headFieldMap
    this.exclude = opts.config.exclude
    this.tailLines = opts.config.tailLines ?? 100
    this.stateInference = opts.config.stateInference
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

    // Head record: first JSON line of the file. Cheap one-time read
    // capped at ~64KB to handle Codex's verbose session_meta payloads.
    let head: Record<string, unknown> | null = null
    if (this.headFieldMap || this.exclude) {
      head = await readHeadRecord(filePath, size)
      // Exclude check runs against head — that's where Codex puts the
      // thread_source / source.subagent.* discriminators.
      if (head && this.exclude) {
        const v = readDotted(head, this.exclude.field)
        if (toStringOrEmpty(v) === this.exclude.equals) return null
      }
    }

    // Tail: read up to last ~16KB; that's plenty for the trailing N
    // records of a typical JSONL stream. Reading from the end requires
    // opening and seeking — fs.open + read.
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
      const snap = this.parse(obj, head, filePath, mtimeMs)
      if (snap) return snap
    }
    return null
  }

  private parse(
    tailJson: unknown,
    head: Record<string, unknown> | null,
    filePath: string,
    mtimeMs: number,
  ): SessionSnapshot | null {
    if (!tailJson || typeof tailJson !== 'object') return null
    const tail = tailJson as Record<string, unknown>
    const fm = this.fieldMap
    const hfm = this.headFieldMap
    // Resolve each slot: prefer tail value; fall back to head value.
    const pickWithFallback = (slot: keyof FieldMap): string => {
      const tailKey = fm[slot]
      const headKey = hfm?.[slot]
      const fromTail = tailKey ? readDottedString(tail, tailKey) : ''
      if (fromTail) return fromTail
      if (head && headKey) return readDottedString(head, headKey)
      return ''
    }
    const pickNumWithFallback = (slot: keyof FieldMap): number => {
      const tailKey = fm[slot]
      const headKey = hfm?.[slot]
      let v = tailKey ? readDottedTimestamp(tail, tailKey) : 0
      if (v > 0) return v
      if (head && headKey) v = readDottedTimestamp(head, headKey)
      return v
    }

    let sessionId = pickWithFallback('sessionId')
    if (!sessionId) sessionId = extractUuidFromFilename(filePath)
    if (!sessionId) sessionId = path.basename(filePath, path.extname(filePath))
    if (!sessionId) return null

    const rawState = pickWithFallback('state')
    const lastTransitionAt = pickNumWithFallback('lastTransitionAt') || mtimeMs
    const fallbackName = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId

    // State precedence:
    //   1. Explicit mapped `state` field (Claude path; never reached
    //      for Codex since its manifest doesn't map state).
    //   2. Declarative stateInference rules from the manifest
    //      (Codex: task_complete → needs-input, etc).
    //   3. Age-based fallback (rolling window on lastTransitionAt).
    let state: SessionSnapshot['state']
    if (rawState) {
      state = normalizeState(rawState)
    } else {
      const inferred = applyStateInference(
        this.stateInference,
        { tail, head },
        { now: this.now(), lastTransitionAt, defaultScope: 'tail' },
      )
      if (inferred) {
        state = inferred
      } else if (lastTransitionAt > 0) {
        const age = this.now() - lastTransitionAt
        if (age < FRESH_WORKING_MS) state = 'working'
        else if (age < FRESH_IDLE_MS) state = 'idle'
        else state = 'completed'
      } else {
        state = 'working'
      }
    }

    return {
      harness: this.id,
      sessionId,
      name: pickWithFallback('name') || fallbackName,
      state,
      summary: pickWithFallback('summary'),
      lastTransitionAt,
      processAlive: state === 'working' || state === 'idle',
      prUrl: pickWithFallback('prUrl'),
      prCheckStatus: pickWithFallback('prCheckStatus'),
      cwd: pickWithFallback('cwd'),
      rawStateString: rawState,
    }
  }
}

// Read the first complete JSON record from the head of a file. Reads up
// to `maxBytes` from offset 0, finds the first newline-terminated line
// that parses as JSON. Returns null on any failure.
async function readHeadRecord(
  filePath: string,
  size: number,
): Promise<Record<string, unknown> | null> {
  if (size === 0) return null
  const maxBytes = 64 * 1024
  const fh = await fs.open(filePath, 'r')
  try {
    const bytesToRead = Math.min(size, maxBytes)
    const buf = Buffer.alloc(bytesToRead)
    await fh.read(buf, 0, bytesToRead, 0)
    const text = buf.toString('utf-8')
    // First newline-terminated line. If the head record is longer than
    // maxBytes (extremely large session_meta), we'll see no newline and
    // give up — that's an acceptable trade for bounded I/O.
    const nl = text.indexOf('\n')
    const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim()
    if (!firstLine) return null
    try {
      const obj = JSON.parse(firstLine)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>
      }
    } catch {
      // not JSON
    }
    return null
  } finally {
    await fh.close()
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

function extractUuidFromFilename(filePath: string): string {
  const base = path.basename(filePath)
  const m = UUID_SUFFIX_RE.exec(base)
  return m ? m[1]!.toLowerCase() : ''
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
