// SwiftBar plugin output. Pure formatter: takes the rows beto has at scan
// time and returns the markdown SwiftBar reads from stdout.
//
// SwiftBar contract:
//   - First non-empty line before "---" is the menubar title
//   - Subsequent lines (after the first "---") populate the dropdown
//   - Each line accepts `| key=value` flags: color, sfcolor, size, font,
//     bash, terminal, refresh, ansi, alternate, length, …
//   - The whole script re-runs every N seconds based on filename
//     (`beto.30s.sh` = 30s refresh)
//
// Design goals:
//   - Title fits in ~40 chars (macOS menubar width budget)
//   - Visual ramp matches escalation tiers (yellow → orange → red)
//   - Per-row info matches Tier 1: name · harness sigil · time-in-state · tps
//   - Clickable footer to open the full beto inbox in a terminal

import type { EscalationTier, SessionSnapshot } from './types.js'
import { deriveTier, formatBlockedFor } from './needsInput.js'
import { groupRows } from '../store/inbox.js'
import { sigilFor } from '../ui/theme.js'

// SF symbols + Unicode glyphs. SwiftBar renders Unicode reliably; SF
// symbols need extra config so we stick with plain Unicode for v0.7.
const STATE_GLYPH: Record<string, string> = {
  working: '●',
  'needs-input': '◉',
  idle: '○',
  completed: '✓',
  failed: '✗',
  stopped: '⊘',
  unknown: '?',
}

// SwiftBar color names. `sfcolor` adapts to dark/light mode automatically;
// `color` is fallback for older SwiftBar versions.
const TIER_COLOR: Record<EscalationTier, string> = {
  abandoned: 'red',
  escalated: 'orange',
  awaiting: '#D4A017', // amber — neither yellow (too pale) nor orange
  none: 'gray',
}

const HARNESS_SIGIL: Record<string, string> = {
  claude: 'C',
  codex: 'X',
  hermes: 'H',
  goose: 'G',
  kimi: 'K',
  openclaw: 'O',
  openhands: 'D',
  aider: 'A',
  'open-interpreter': 'I',
  crewai: 'W',
  metagpt: 'M',
}

export interface SwiftBarOptions {
  // Absolute path to the beto binary. Used in the "open inbox" footer
  // action so SwiftBar can spawn `beto` in a Terminal.
  betoPath?: string
  // Override for tests; defaults to Date.now.
  now?: () => number
}

// Public API. Pass the full row set; we group, filter, and format.
// Returns the complete stdout body. Caller writes it and exits.
export function renderSwiftBar(rows: readonly SessionSnapshot[], opts: SwiftBarOptions = {}): string {
  const now = (opts.now ?? Date.now)()
  const betoPath = opts.betoPath ?? 'beto'

  const grouped = groupRows([...rows], now)
  const needsCount = grouped.needsYou.length
  const liveCount = grouped.active.length
  const worstTier = grouped.needsYou[0]?.tier

  const out: string[] = []

  // ─── menubar title ─────────────────────────────────────────────────
  out.push(buildTitle(needsCount, liveCount, worstTier))
  out.push('---')

  // ─── needs-you bucket ──────────────────────────────────────────────
  if (grouped.needsYou.length > 0) {
    out.push(`NEEDS YOU (${needsCount}) | size=10 color=gray`)
    for (const { row, tier } of grouped.needsYou) {
      const blocked = formatBlockedFor(row, now) || ''
      out.push(formatRow(row, `${tier} ${blocked}`.trim(), TIER_COLOR[tier]))
    }
  }

  // ─── active bucket ─────────────────────────────────────────────────
  // Working rows: drop the literal "working" word — the green glyph +
  // green row color say it. Tail is just the time-in-state.
  // Idle rows: keep "idle Xs" — gray-on-gray is less obvious without
  // the label.
  if (grouped.active.length > 0) {
    if (out[out.length - 1] !== '---') out.push('---')
    out.push(`ACTIVE (${liveCount}) | size=10 color=gray`)
    for (const row of grouped.active) {
      const ageBit = ageString(row.lastTransitionAt, now)
      if (row.state === 'idle') {
        out.push(formatRow(row, `idle ${ageBit}`.trim()))
      } else {
        out.push(formatRow(row, ageBit, 'green'))
      }
    }
  }

  // ─── recent bucket — collapsed, only first 3 ───────────────────────
  if (grouped.recent.length > 0) {
    if (out[out.length - 1] !== '---') out.push('---')
    out.push(`RECENT | size=10 color=gray`)
    for (const row of grouped.recent.slice(0, 3)) {
      const tail = row.state === 'completed' && row.prUrl ? 'PR ready' : row.state
      out.push(formatRow(row, tail, row.state === 'failed' ? 'red' : 'gray'))
    }
  }

  // ─── footer ────────────────────────────────────────────────────────
  out.push('---')
  out.push(`Open beto inbox | bash=${betoPath} terminal=true`)
  out.push(`Open beto doctor | bash=${betoPath} param1=doctor terminal=true`)
  out.push(`Refresh | refresh=true`)

  return out.join('\n') + '\n'
}

// ─── helpers ────────────────────────────────────────────────────────

function buildTitle(needs: number, live: number, worstTier: EscalationTier | undefined): string {
  const parts: string[] = []
  if (needs > 0) {
    const tag = worstTier && worstTier !== 'none' ? ` (${worstTier})` : ''
    parts.push(`⚠ ${needs}${tag}`)
  }
  if (live > 0) parts.push(`● ${live} live`)
  if (parts.length === 0) parts.push('beto · idle')
  // Color: red if abandoned/escalated outstanding; orange for awaiting;
  // gray when nothing's blocked.
  const color =
    worstTier === 'abandoned' || worstTier === 'escalated'
      ? 'color=red'
      : worstTier === 'awaiting'
        ? 'color=orange'
        : 'color=gray'
  return `${parts.join(' · ')} | ${color}`
}

function formatRow(row: SessionSnapshot, statusTail: string, color = ''): string {
  // Use the theme module's dynamic sigil lookup so plugin manifests'
  // `sigil` overrides are honored. The local HARNESS_SIGIL fallback
  // remains for built-in harnesses when theme registration hasn't run
  // (e.g. unit tests that import this formatter directly).
  const themeSigil = sigilFor(row.harness)
  const sigil =
    themeSigil && themeSigil !== row.harness.charAt(0).toUpperCase()
      ? themeSigil
      : HARNESS_SIGIL[row.harness] ?? themeSigil
  // Token bits, all omitted when zero so completed rows stay clean:
  //   in  — cumulative input (includes cache reads/writes). Cost magnitude.
  //   out — cumulative output. "How much narrative has this produced."
  //   tps — live output tokens/sec. "Is it generating right now."
  const tokIn = row.tokensIn != null && row.tokensIn > 0 ? ` · ${formatCount(row.tokensIn)} in` : ''
  const tokOut = row.tokensOut != null && row.tokensOut > 0 ? ` · ${formatCount(row.tokensOut)} out` : ''
  const tps =
    row.tokenRateLast60s != null && row.tokenRateLast60s > 0
      ? ` · ${row.tokenRateLast60s} tps`
      : ''
  const glyph = STATE_GLYPH[row.state] ?? '·'
  const name = truncate(row.name, 22).padEnd(22)
  const line = `${glyph} ${name} ${sigil} · ${statusTail}${tokIn}${tokOut}${tps}`
  const flags: string[] = ['font=Menlo']
  if (color) flags.push(`color=${color}`)
  return `${line} | ${flags.join(' ')}`
}

function ageString(ts: number, now: number): string {
  if (!ts) return ''
  const sec = Math.floor((now - ts) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, max)
  return s.slice(0, max - 1) + '…'
}

// Compact integer formatter for token counts: 1234 → "1.2k", 1234567 → "1.2M".
function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}
