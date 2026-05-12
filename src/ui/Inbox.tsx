import React from 'react'
import { Box, Text } from 'ink'
import type { HarnessId, SessionSnapshot } from '../lib/types.js'
import { groupRows } from '../store/inbox.js'
import { Row } from './Row.js'
import { SidebarRow } from './SidebarRow.js'
import { colorFor, pickLayout, sigilFor } from './theme.js'

interface Props {
  rows: SessionSnapshot[]
  now: number
  cursorId: string | null
  // Per-harness row counts for the header tally. Comes from the registry
  // so even harnesses with zero current rows can be rendered if desired.
  harnessCounts: Record<HarnessId, number>
  // Active filter — null means "all." Surfaces in the header.
  harnessFilter: Set<HarnessId> | null
  // Terminal width in columns. Drives layout-mode selection.
  width: number
}

// Top-level inbox. Picks ultra/sidebar/wide layout from width, then renders
// the three buckets. Needs-you is always first.
export function Inbox({ rows, now, cursorId, harnessCounts, harnessFilter, width }: Props) {
  const mode = pickLayout(width)
  const { needsYou, active, recent } = groupRows(rows, now)
  let renderedIndex = 0
  const total = needsYou.length + active.length + recent.length

  return (
    <Box flexDirection="column">
      <Header
        total={total}
        needsYou={needsYou.length}
        counts={harnessCounts}
        filter={harnessFilter}
        mode={mode}
      />

      {needsYou.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeader label="Need" color="yellow" count={needsYou.length} mode={mode} />
          {needsYou.map((entry) => {
            const i = renderedIndex++
            return renderRow({
              key: `${entry.row.harness}:${entry.row.sessionId}`,
              index: i,
              row: entry.row,
              tier: entry.tier,
              now,
              cursor: entry.row.sessionId === cursorId,
              mode,
              width,
            })
          })}
        </Box>
      )}

      {active.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeader label="Active" color="cyan" count={active.length} mode={mode} />
          {active.map((row) => {
            const i = renderedIndex++
            return renderRow({
              key: `${row.harness}:${row.sessionId}`,
              index: i,
              row,
              tier: 'none' as const,
              now,
              cursor: row.sessionId === cursorId,
              mode,
              width,
            })
          })}
        </Box>
      )}

      {recent.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeader label="Recent" color="gray" count={recent.length} mode={mode} dim />
          {recent.map((row) => {
            const i = renderedIndex++
            return renderRow({
              key: `${row.harness}:${row.sessionId}`,
              index: i,
              row,
              tier: 'none' as const,
              now,
              cursor: row.sessionId === cursorId,
              mode,
              width,
            })
          })}
        </Box>
      )}

      {total === 0 && <Empty filtered={harnessFilter !== null} />}
    </Box>
  )
}

function renderRow(args: {
  key: string
  index: number
  row: SessionSnapshot
  tier: import('../lib/types.js').EscalationTier
  now: number
  cursor: boolean
  mode: 'ultra' | 'sidebar' | 'wide'
  width: number
}) {
  if (args.mode === 'wide') {
    return (
      <Row
        key={args.key}
        index={args.index}
        row={args.row}
        tier={args.tier}
        now={args.now}
        cursor={args.cursor}
      />
    )
  }
  return (
    <SidebarRow
      key={args.key}
      index={args.index}
      row={args.row}
      tier={args.tier}
      now={args.now}
      cursor={args.cursor}
      width={args.width}
      ultraCompact={args.mode === 'ultra'}
    />
  )
}

function Header({
  total,
  needsYou,
  counts,
  filter,
  mode,
}: {
  total: number
  needsYou: number
  counts: Record<HarnessId, number>
  filter: Set<HarnessId> | null
  mode: 'ultra' | 'sidebar' | 'wide'
}) {
  // Harness tally like "4C 2X 1H 1G". Only harnesses with at least one
  // row appear. Hidden in ultra-compact mode where every column counts.
  const tally = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id: id as HarnessId, n }))
  return (
    <Box flexDirection={mode === 'ultra' ? 'column' : 'row'}>
      <Box>
        <Text bold>beto</Text>
        <Text dimColor> · {total} session{total === 1 ? '' : 's'}</Text>
      </Box>
      {mode !== 'ultra' && tally.length > 0 && (
        <Box>
          <Text dimColor> (</Text>
          {tally.map((t, i) => (
            <React.Fragment key={t.id}>
              <Text color={colorFor(t.id)}>
                {t.n}{sigilFor(t.id)}
              </Text>
              {i < tally.length - 1 && <Text dimColor> </Text>}
            </React.Fragment>
          ))}
          <Text dimColor>)</Text>
        </Box>
      )}
      {needsYou > 0 && (
        <Box>
          <Text color="yellow" bold>
            {' '}· {needsYou} need{needsYou === 1 ? 's' : ''} you
          </Text>
        </Box>
      )}
      {filter && [...filter].length > 0 && (
        <Box>
          <Text dimColor>  filter:</Text>
          {[...filter].map((id) => (
            <Text key={id} color={colorFor(id)}> {sigilFor(id)}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function SectionHeader({
  label,
  count,
  color,
  mode,
  dim,
}: {
  label: string
  count: number
  color: string
  mode: 'ultra' | 'sidebar' | 'wide'
  dim?: boolean
}) {
  if (mode === 'wide') {
    return (
      <Text color={color} bold dimColor={dim}>
        ▌ {label} ({count})
      </Text>
    )
  }
  return (
    <Text color={color} bold dimColor={dim}>
      ▌{label} · {count}
    </Text>
  )
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {filtered ? (
        <Text dimColor>No sessions match the current filter. Press [f] to cycle or clear.</Text>
      ) : (
        <>
          <Text dimColor>
            The chamber is quiet. No agent sessions found.
          </Text>
          <Text dimColor>
            Dispatch with [d], or start a session in any installed harness
            (claude --bg, codex, etc.).
          </Text>
        </>
      )}
    </Box>
  )
}
