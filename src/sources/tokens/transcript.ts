// Claude Code transcript reader.
//
// Each transcript is a JSONL file at
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// where the filename (sans extension) is the session id and each line is
// a JSON record. Assistant-type records carry usage data:
//
//   { "type": "assistant", "timestamp": "2026-...",
//     "message": { "usage": { "input_tokens": N, "output_tokens": M, ... } } }
//
// We sum input + output tokens per session (cumulative), and a 60s
// rolling-window rate based on the `timestamp` field. Cache tokens
// (input cache create/read) are not counted — they price differently
// and inflating "tps" with them would mislead the operator.
//
// Reads are tail-only: at most ~64KB from the file end, parsed line by
// line from the bottom. For typical sessions (≤ a few hundred KB) we
// just read the whole thing; only very long sessions get truncated.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const WINDOW_MS = 60 * 1000
// Above this, only the trailing 64KB is read each scan; below it, the
// whole file is parsed. Most transcripts are well under 64KB so this is
// effectively "read the whole file" in practice.
const TAIL_BYTES = 64 * 1024
// Cap of records parsed per file per scan — bounded work even if
// someone manages a multi-megabyte transcript with no cache hits.
const MAX_RECORDS_PER_FILE = 2000

export interface TokenSnapshot {
  sessionId: string
  tokensIn: number
  tokensOut: number
  tokenRateLast60s: number
  // Most recent assistant message timestamp (ms epoch) found in this
  // transcript. Useful for the ClaudeAdapter when synthesizing rows
  // from JSONL alone (no state.json present).
  lastAssistantAt: number
}

export interface ClaudeTranscriptReaderOptions {
  // Override for tests. Defaults to ~/.claude/projects.
  projectsDir?: string
  // Override for tests. Defaults to Date.now.
  now?: () => number
}

export class ClaudeTranscriptReader {
  private readonly projectsDir: string
  private readonly now: () => number

  constructor(opts: ClaudeTranscriptReaderOptions = {}) {
    this.projectsDir = opts.projectsDir ?? path.join(os.homedir(), '.claude', 'projects')
    this.now = opts.now ?? (() => Date.now())
  }

  // Walk every project directory + collect the most recent token
  // snapshot per session id. Returns a map keyed by sessionId.
  async scan(): Promise<Map<string, TokenSnapshot>> {
    const out = new Map<string, TokenSnapshot>()
    let projects: string[] = []
    try {
      projects = await fs.readdir(this.projectsDir)
    } catch {
      return out
    }
    for (const proj of projects) {
      const dir = path.join(this.projectsDir, proj)
      let files: string[] = []
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue
        const sessionId = name.slice(0, -'.jsonl'.length)
        const filePath = path.join(dir, name)
        const snap = await this.readOne(sessionId, filePath)
        if (snap) out.set(sessionId, snap)
      }
    }
    return out
  }

  // Read one transcript and compute its token snapshot.
  async readOne(sessionId: string, filePath: string): Promise<TokenSnapshot | null> {
    let size: number
    try {
      const st = await fs.stat(filePath)
      if (!st.isFile()) return null
      size = st.size
    } catch {
      return null
    }
    if (size === 0) return null

    // Read the tail (or whole file if small).
    const fh = await fs.open(filePath, 'r')
    try {
      const bytesToRead = Math.min(size, TAIL_BYTES)
      const offset = size - bytesToRead
      const buf = Buffer.alloc(bytesToRead)
      await fh.read(buf, 0, bytesToRead, offset)
      let text = buf.toString('utf-8')
      if (offset > 0) {
        // Drop the leading partial line — we sliced into the middle of one.
        const firstNl = text.indexOf('\n')
        if (firstNl >= 0) text = text.slice(firstNl + 1)
      }
      return this.parse(sessionId, text)
    } finally {
      await fh.close()
    }
  }

  // Parse a JSONL text blob into a token snapshot. Public for tests.
  //
  // Rate semantics: tokens/sec uses *output* tokens only, averaged over
  // the trailing 60-second window. Output is the meaningful "is the
  // model actually generating?" signal — input throughput spikes on
  // every cache read (which fly through in ms) and isn't what the
  // operator wants on the bar. Cumulative tokensIn / tokensOut stay
  // inclusive so the peek view can show the full picture.
  parse(sessionId: string, text: string): TokenSnapshot | null {
    const cutoff = this.now() - WINDOW_MS
    let tokensIn = 0
    let tokensOut = 0
    let outputInWindow = 0
    let lastAssistantAt = 0
    let count = 0

    const lines = text.split('\n')
    for (const raw of lines) {
      if (++count > MAX_RECORDS_PER_FILE) break
      if (!raw) continue
      let obj: unknown
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      const rec = obj as Record<string, unknown>
      if (rec.type !== 'assistant') continue

      const usage = extractUsage(rec)
      if (!usage) continue
      tokensIn += usage.input
      tokensOut += usage.output

      const ts = extractTimestamp(rec)
      if (ts > lastAssistantAt) lastAssistantAt = ts
      if (ts >= cutoff) outputInWindow += usage.output
    }

    if (tokensIn === 0 && tokensOut === 0 && lastAssistantAt === 0) return null

    return {
      sessionId,
      tokensIn,
      tokensOut,
      tokenRateLast60s: Math.round((outputInWindow / WINDOW_MS) * 1000),
      lastAssistantAt,
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function extractUsage(rec: Record<string, unknown>): { input: number; output: number } | null {
  // Anthropic's transcript records nest usage under `message.usage`,
  // but some older variants put it at top level — handle both.
  const msg = rec.message
  const fromMsg =
    msg && typeof msg === 'object'
      ? (msg as Record<string, unknown>).usage
      : null
  const usage =
    (fromMsg && typeof fromMsg === 'object' && fromMsg) ||
    (rec.usage && typeof rec.usage === 'object' && rec.usage) ||
    null
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  // Total "input" = fresh prompt tokens + cache writes + cache reads.
  // Claude Code routes 99%+ of multi-turn input through prompt caching,
  // so reporting `input_tokens` alone undercounts by ~1000x. Operators
  // care about throughput, not pricing — so we sum all three. Pricing-
  // accurate breakdowns can ship later as a peek-detail row.
  const input =
    pickU(u, 'input_tokens') +
    pickU(u, 'cache_creation_input_tokens') +
    pickU(u, 'cache_read_input_tokens')
  const output = pickU(u, 'output_tokens')
  if (input === 0 && output === 0) return null
  return { input, output }
}

function extractTimestamp(rec: Record<string, unknown>): number {
  const t = rec.timestamp
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    if (Number.isFinite(ms)) return ms
  }
  if (typeof t === 'number' && Number.isFinite(t)) return t
  return 0
}

function pickU(o: Record<string, unknown>, key: string): number {
  const v = o[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}
