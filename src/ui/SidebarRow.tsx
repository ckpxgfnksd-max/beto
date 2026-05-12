import React from 'react'
import { Box, Text } from 'ink'
import type { EscalationTier, SessionSnapshot } from '../lib/types.js'
import {
  colorFor,
  sigilFor,
  STATE_COLOR,
  STATE_GLYPH,
  TIER_COLOR,
} from './theme.js'
import { formatBlockedFor } from '../lib/needsInput.js'

interface Props {
  index: number
  row: SessionSnapshot
  tier: EscalationTier
  now: number
  cursor: boolean
  // Available row width (terminal columns minus padding). Drives the
  // summary truncation budget.
  width: number
  // When true, drops the summary line entirely and renders a single
  // compact line. Used for ultra-narrow panes (<50 cols).
  ultraCompact?: boolean
}

// Sidebar-optimized row. Trades the cwd tail + PR URL line for vertical
// density so 6–10 rows fit in a tmux/zellij side pane.
//
// Layouts:
//   ultra-compact (1 line): "[1] ◉ Quasar  C  abandoned 8m"
//   sidebar (2 lines):
//     [1] ◉ Quasar  C · abandoned 8m
//        auth migrations: squash or keep both?
export function SidebarRow({ index, row, tier, now, cursor, width, ultraCompact }: Props) {
  const slot = index < 9 ? `${index + 1}` : '·'
  const cursorMark = cursor ? '▶' : ' '
  const stateColor = STATE_COLOR[row.state]
  const tierColor = TIER_COLOR[tier]
  const blockedFor = formatBlockedFor(row, now)

  const tierBit =
    row.state === 'needs-input' && blockedFor
      ? `${tier} ${blockedFor}`
      : row.state === 'completed' && row.prUrl
        ? 'PR ready'
        : row.state

  // Summary truncation budget. The leading row is ~22 chars of chrome
  // (cursor + slot + glyph + name + sigil + tier-bit + separators); the
  // summary line is fully its own budget minus a 5-char indent.
  const summaryBudget = Math.max(20, width - 5)
  const summary = row.summary ? truncate(row.summary, summaryBudget) : ''

  if (ultraCompact) {
    return (
      <Box>
        <Text color={cursor ? 'cyanBright' : undefined}>{cursorMark}</Text>
        <Text dimColor>[{slot}] </Text>
        <Text color={stateColor}>{STATE_GLYPH[row.state]} </Text>
        <Text bold>{truncate(row.name, 10)}</Text>
        <Text color={colorFor(row.harness)}> {sigilFor(row.harness)}</Text>
        <Text color={row.state === 'needs-input' ? tierColor : stateColor}> {tierBit}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={cursor ? 'cyanBright' : undefined}>{cursorMark}</Text>
        <Text dimColor>[{slot}] </Text>
        <Text color={stateColor}>{STATE_GLYPH[row.state]} </Text>
        <Text bold>{truncate(row.name, 14).padEnd(14)}</Text>
        <Text color={colorFor(row.harness)} bold>{sigilFor(row.harness)} </Text>
        <Text dimColor>· </Text>
        <Text color={row.state === 'needs-input' ? tierColor : stateColor}>{tierBit}</Text>
      </Box>
      {summary && (
        <Box paddingLeft={5}>
          <Text dimColor italic>{summary}</Text>
        </Box>
      )}
    </Box>
  )
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, max)
  return s.slice(0, max - 1) + '…'
}
