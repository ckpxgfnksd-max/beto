import React from 'react'
import { Box, Text } from 'ink'
import type { SessionSnapshot } from '../lib/types.js'
import { groupRows } from '../store/inbox.js'
import { Row } from './Row.js'

interface Props {
  rows: SessionSnapshot[]
  now: number
  cursorId: string | null
}

// Top-level inbox. Three buckets, each preceded by a thin section header.
// The needs-you bucket is unconditionally first — it's the entire reason
// beto exists. Empty buckets render nothing (no "you have 0 needs-you"
// chrome).
export function Inbox({ rows, now, cursorId }: Props) {
  const { needsYou, active, recent } = groupRows(rows, now)
  let renderedIndex = 0

  const total = needsYou.length + active.length + recent.length

  return (
    <Box flexDirection="column">
      <Header total={total} needsYou={needsYou.length} />

      {needsYou.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>
            ▌ Needs you ({needsYou.length})
          </Text>
          {needsYou.map((entry) => {
            const i = renderedIndex++
            return (
              <Row
                key={entry.row.sessionId}
                index={i}
                row={entry.row}
                tier={entry.tier}
                now={now}
                cursor={entry.row.sessionId === cursorId}
              />
            )
          })}
        </Box>
      )}

      {active.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            ▌ Active ({active.length})
          </Text>
          {active.map((row) => {
            const i = renderedIndex++
            return (
              <Row
                key={row.sessionId}
                index={i}
                row={row}
                tier="none"
                now={now}
                cursor={row.sessionId === cursorId}
              />
            )
          })}
        </Box>
      )}

      {recent.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor bold>
            ▌ Recent ({recent.length})
          </Text>
          {recent.map((row) => {
            const i = renderedIndex++
            return (
              <Row
                key={row.sessionId}
                index={i}
                row={row}
                tier="none"
                now={now}
                cursor={row.sessionId === cursorId}
              />
            )
          })}
        </Box>
      )}

      {total === 0 && <Empty />}
    </Box>
  )
}

function Header({ total, needsYou }: { total: number; needsYou: number }) {
  return (
    <Box>
      <Text bold>beto</Text>
      <Text dimColor> · {total} session{total === 1 ? '' : 's'}</Text>
      {needsYou > 0 ? (
        <Text color="yellow" bold>
          {' '}
          · {needsYou} need{needsYou === 1 ? 's' : ''} you
        </Text>
      ) : null}
    </Box>
  )
}

function Empty() {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        The chamber is quiet. Dispatch a session with `d`, or run `claude --bg
        "&lt;task&gt;"` in any repo.
      </Text>
      <Text dimColor>beto reads ~/.claude/jobs/*/state.json — no install needed.</Text>
    </Box>
  )
}
