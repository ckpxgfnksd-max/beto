import React from 'react'
import { Box, Text } from 'ink'
import type { EscalationTier, SessionSnapshot } from '../lib/types.js'
import { inferRole, ROLE_GLYPH, ROLE_SHORT } from '../lib/roles.js'
import { STATE_COLOR, STATE_GLYPH, TIER_COLOR, TIER_LABEL } from './theme.js'
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

  const statusLine =
    row.state === 'needs-input' && blockedFor
      ? `blocked ${blockedFor}`
      : row.state === 'completed' && row.prUrl
        ? 'PR ready'
        : row.state

  const cwdTail = row.cwd ? row.cwd.split('/').filter(Boolean).slice(-1)[0] ?? '' : ''

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={cursor ? 'cyanBright' : undefined}>{cursorMark} </Text>
        <Text dimColor>[{slot}] </Text>
        <Text color={stateColor}>{STATE_GLYPH[row.state]} </Text>
        <Text bold>{row.name}</Text>
        <Text dimColor> ({ROLE_GLYPH[role]} {ROLE_SHORT[role]}) </Text>
        <Text color={stateColor}>· {statusLine}</Text>
        {tierLabel ? (
          <Text color={tierColor}> · {tierLabel}</Text>
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
