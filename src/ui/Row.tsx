import React from 'react'
import { Box, Text } from 'ink'
import type { EscalationTier, SessionSnapshot } from '../lib/types.js'
import { inferRole, ROLE_GLYPH, ROLE_SHORT } from '../lib/roles.js'
import { summarizeTask } from '../lib/summarize.js'
import {
  colorFor,
  sigilFor,
  STATE_COLOR,
  STATE_GLYPH,
  TIER_COLOR,
  TIER_LABEL,
} from './theme.js'
import { formatBlockedFor } from '../lib/needsInput.js'

interface Props {
  index: number
  row: SessionSnapshot
  // Row tier when in the needs-you bucket; 'none' otherwise.
  tier: EscalationTier
  now: number
  // Highlighted when this row is the keyboard cursor (peeked).
  cursor: boolean
}

// A single inbox row. Three lines of information density without leaning
// on raid-frame chrome:
//
//   line 1: [n] glyph  name (role)  • status         tier-tag
//   line 2: summary (Haiku one-liner; dim italic if supported)
//   line 3: pr/ci badge + cwd tail (only when present)
//
// 80-cols safe; longer summary truncates with an ellipsis. cwd shows the
// last path segment only.
export function Row({ index, row, tier, now, cursor }: Props) {
  const role = inferRole(row.name)
  const stateColor = STATE_COLOR[row.state]
  const tierColor = TIER_COLOR[tier]
  const tierLabel = TIER_LABEL[tier]
  const blockedFor = formatBlockedFor(row, now)

  const cursorMark = cursor ? '▶' : ' '
  const slot = index < 9 ? `${index + 1}` : '·'

  // "working" reads redundant when the green dot+text already say so.
  // Show time-in-state instead. Same posture for idle/completed where
  // a label would just repeat the glyph.
  const ageString = blockedFor || formatAge(row.lastTransitionAt, now)
  const statusLine =
    row.state === 'needs-input' && blockedFor
      ? `blocked ${blockedFor}`
      : row.state === 'completed' && row.prUrl
        ? 'PR ready'
        : row.state === 'working'
          ? ageString || 'working'
          : row.state === 'idle'
            ? `idle ${ageString}`.trim()
            : row.state

  const cwdTail = row.cwd ? row.cwd.split('/').filter(Boolean).slice(-1)[0] ?? '' : ''

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={cursor ? 'cyanBright' : undefined}>{cursorMark} </Text>
        <Text dimColor>[{slot}] </Text>
        <Text color={stateColor}>{STATE_GLYPH[row.state]} </Text>
        <Text bold>{summarizeTask(row.name, { maxWords: 3, maxChars: 28 })}</Text>
        <Text color={colorFor(row.harness)} bold> {sigilFor(row.harness)}</Text>
        <Text dimColor> ({ROLE_GLYPH[role]} {ROLE_SHORT[role]}) </Text>
        <Text color={stateColor}>· {statusLine}</Text>
        {tierLabel ? (
          <Text color={tierColor}> · {tierLabel}</Text>
        ) : null}
        {row.tokensIn != null && row.tokensIn > 0 ? (
          <Text dimColor>  · {formatCount(row.tokensIn)} in</Text>
        ) : null}
        {row.tokensOut != null && row.tokensOut > 0 ? (
          <Text dimColor> · {formatCount(row.tokensOut)} out</Text>
        ) : null}
        {row.tokenRateLast60s != null && row.tokenRateLast60s > 0 ? (
          <Text dimColor> · {row.tokenRateLast60s} tps</Text>
        ) : null}
        {row.prCheckStatus ? (
          <Text dimColor>  {prBadge(row.prCheckStatus)}</Text>
        ) : null}
      </Box>
      {row.summary ? (
        <Box paddingLeft={5}>
          <Text dimColor italic>
            {truncate(row.summary, 80)}
          </Text>
        </Box>
      ) : null}
      {cwdTail || row.prUrl ? (
        <Box paddingLeft={5}>
          {cwdTail ? <Text dimColor>~/{cwdTail} </Text> : null}
          {row.prUrl ? <Text dimColor>· {row.prUrl}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}

function prBadge(status: string): string {
  switch (status) {
    case 'pending':
      return '◐ CI'
    case 'success':
      return '✓ CI'
    case 'failure':
    case 'failed':
      return '✗ CI'
    default:
      return '◌ CI'
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

// Time-in-state for working/idle rows. Same shape as ageString in
// swiftbar.ts — kept local to avoid the cross-import.
function formatAge(ts: number, now: number): string {
  if (!ts) return ''
  const sec = Math.floor((now - ts) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}
