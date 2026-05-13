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
// Tail cap. Above this size, only the trailing slice is parsed for
// tokens / current-activity. Below it, the whole file is one buffer.
const TAIL_BYTES = 64 * 1024
// Head cap. For files larger than the tail cap we ALSO read a small
// head buffer to capture the first user message (the session "task"),
// which lives near line 1 and would otherwise be lost to the tail-only
// read. 8KB is plenty for ~10 leading records on Claude's schema.
const HEAD_BYTES = 8 * 1024
// Cap of records parsed per region per scan — bounded work even if
// someone manages a multi-megabyte transcript with no cache hits.
const MAX_RECORDS_PER_FILE = 2000
// Truncate the task + activity strings to this length when storing them
// on the snapshot. UI surfaces all truncate further to the row width.
const SUMMARY_CAP = 200

export interface TokenSnapshot {
  sessionId: string
  tokensIn: number
  tokensOut: number
  tokenRateLast60s: number
  // Most recent assistant message timestamp (ms epoch) found in this
  // transcript. Useful for the ClaudeAdapter when synthesizing rows
  // from JSONL alone (no state.json present).
  lastAssistantAt: number
  // First user message text in the transcript (truncated to 200 chars).
  // Used as the session's "task" / name when state.json is absent.
  // Empty string if the transcript has no user message yet.
  firstUserMessage: string
  // Most recent assistant *text* block (truncated to 200 chars). Used
  // as the session's "current activity" / summary when state.json
  // doesn't carry one. Skips tool_use blocks — only narrative text.
  lastAssistantText: string
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
  //
  // Strategy: for files ≤ TAIL_BYTES the whole file IS the tail — one
  // read does everything. For larger files we read both a head slice
  // (to capture the first user message that names the session) and a
  // tail slice (for tokens + most-recent assistant text). Two parses
  // share the same logic but operate on different buffers.
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

    const fh = await fs.open(filePath, 'r')
    try {
      let headText = ''
      let tailText = ''

      if (size <= TAIL_BYTES) {
        const buf = Buffer.alloc(size)
        await fh.read(buf, 0, size, 0)
        tailText = buf.toString('utf-8')
        headText = tailText // single buffer covers both regions
      } else {
        const headBytes = Math.min(HEAD_BYTES, size)
        const headBuf = Buffer.alloc(headBytes)
        await fh.read(headBuf, 0, headBytes, 0)
        headText = headBuf.toString('utf-8')

        const tailBuf = Buffer.alloc(TAIL_BYTES)
        await fh.read(tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES)
        let tailRaw = tailBuf.toString('utf-8')
        // Drop the leading partial line — we sliced into the middle of one.
        const firstNl = tailRaw.indexOf('\n')
        if (firstNl >= 0) tailRaw = tailRaw.slice(firstNl + 1)
        tailText = tailRaw
      }

      return this.parse(sessionId, headText, tailText)
    } finally {
      await fh.close()
    }
  }

  // Parse head + tail JSONL buffers into a token snapshot. Public for
  // tests; callers from outside (test fixtures) can pass the same text
  // for both args when the transcript fits in one buffer.
  //
  // Rate semantics: tokens/sec uses *output* tokens only, averaged over
  // the trailing 60-second window. Output is the meaningful "is the
  // model actually generating?" signal — input throughput spikes on
  // every cache read (which fly through in ms) and isn't what the
  // operator wants on the bar. Cumulative tokensIn / tokensOut stay
  // inclusive so the peek view can show the full picture.
  //
  // Activity extraction:
  //   firstUserMessage: first record with type='user' anywhere in head;
  //     truncated. This becomes the session's task title.
  //   lastAssistantText: most recent assistant record's first text block
  //     (skipping tool_use blocks); truncated. This is the agent's most
  //     recent narrative output — what's it doing right now.
  parse(sessionId: string, headText: string, tailText?: string): TokenSnapshot | null {
    const cutoff = this.now() - WINDOW_MS
    let tokensIn = 0
    let tokensOut = 0
    let outputInWindow = 0
    let lastAssistantAt = 0
    let lastAssistantText = ''
    let firstUserMessage = ''

    // Head pass — primarily for firstUserMessage. Stops as soon as it
    // finds one; skips records that aren't user messages.
    {
      let count = 0
      for (const raw of headText.split('\n')) {
        if (++count > MAX_RECORDS_PER_FILE) break
        if (!raw) continue
        const rec = tryParseJson(raw)
        if (!rec) continue
        if (rec.type === 'user' && !firstUserMessage) {
          firstUserMessage = extractUserText(rec).slice(0, SUMMARY_CAP)
          if (firstUserMessage) break
        }
      }
    }

    // Tail pass — tokens, last assistant timestamp, last assistant text.
    // When tail is the same as head (small file), tokens are still
    // counted once because the head-pass above doesn't touch them.
    const tailSource = tailText ?? headText
    {
      let count = 0
      for (const raw of tailSource.split('\n')) {
        if (++count > MAX_RECORDS_PER_FILE) break
        if (!raw) continue
        const rec = tryParseJson(raw)
        if (!rec) continue
        if (rec.type !== 'assistant') continue

        const usage = extractUsage(rec)
        if (usage) {
          tokensIn += usage.input
          tokensOut += usage.output
          const ts = extractTimestamp(rec)
          if (ts > lastAssistantAt) lastAssistantAt = ts
          if (ts >= cutoff) outputInWindow += usage.output
        }

        // Always check for text content, even on records without usage.
        const text = extractAssistantText(rec)
        if (text) lastAssistantText = text.slice(0, SUMMARY_CAP)
      }
    }

    if (
      tokensIn === 0 &&
      tokensOut === 0 &&
      lastAssistantAt === 0 &&
      !firstUserMessage &&
      !lastAssistantText
    ) {
      return null
    }

    return {
      sessionId,
      tokensIn,
      tokensOut,
      tokenRateLast60s: Math.round((outputInWindow / WINDOW_MS) * 1000),
      lastAssistantAt,
      firstUserMessage,
      lastAssistantText,
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

// Defensive JSON parse — returns the record object or null. Mid-write
// transcripts and editor saves can produce malformed lines; we skip
// them without throwing.
function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>
    }
  } catch {
    // skip
  }
  return null
}

// User-message text extraction. Claude's user records nest content
// under `message.content` which is either a string ("hello") or an
// array of content blocks ([{ type: 'text', text: '...' }, ...]).
// Slash-command and system-injected messages with empty/whitespace
// text are skipped so we keep walking for the real first message.
function extractUserText(rec: Record<string, unknown>): string {
  const msg = rec.message
  if (!msg || typeof msg !== 'object') return ''
  const content = (msg as Record<string, unknown>).content
  if (typeof content === 'string') {
    return content.trim().replace(/\s+/g, ' ')
  }
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object') {
        const block = c as Record<string, unknown>
        // Only narrative text blocks. Skip tool_result, image, etc.
        if (block.type === 'text' && typeof block.text === 'string') {
          const t = block.text.trim().replace(/\s+/g, ' ')
          if (t) return t
        }
      }
    }
  }
  return ''
}

// Assistant-message text extraction. Same shape as user content but
// we explicitly skip tool_use blocks (those are the model deciding to
// call a tool, not narrative output to the human). The first text
// block in the latest assistant record is "what is it doing right now."
function extractAssistantText(rec: Record<string, unknown>): string {
  const msg = rec.message
  if (!msg || typeof msg !== 'object') return ''
  const content = (msg as Record<string, unknown>).content
  if (typeof content === 'string') {
    return content.trim().replace(/\s+/g, ' ')
  }
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object') {
        const block = c as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string') {
          const t = block.text.trim().replace(/\s+/g, ' ')
          if (t) return t
        }
      }
    }
  }
  return ''
}
