import React, { useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import type { SessionSnapshot } from '../lib/types.js'
import { inferRole, ROLE_GLYPH, ROLE_SHORT } from '../lib/roles.js'
import { STATE_COLOR, STATE_GLYPH } from './theme.js'
import { formatBlockedFor } from '../lib/needsInput.js'

interface Props {
  row: SessionSnapshot
  now: number
  // When true, the reply textarea is focused; Enter sends. When false, the
  // panel shows the action menu.
  replyFocused: boolean
  onSubmitReply: (text: string) => void
  flash: { kind: 'ok' | 'err'; text: string } | null
}

// Detail panel for a single session. Shows everything state.json carries,
// plus the reply input. Reply submit handler is passed in; this component
// stays presentation-only.
export function Peek({ row, now, replyFocused, onSubmitReply, flash }: Props) {
  const [draft, setDraft] = useState('')
  const role = inferRole(row.name)
  const stateColor = STATE_COLOR[row.state]
  const blockedFor = formatBlockedFor(row, now)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={stateColor} bold>
          {STATE_GLYPH[row.state]} {row.name}
        </Text>
        <Text dimColor> ({ROLE_GLYPH[role]} {ROLE_SHORT[role]})</Text>
        <Text dimColor> · {row.sessionId}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>State: </Text>
        <Text color={stateColor}>{row.state}</Text>
        {blockedFor ? <Text color="yellow"> · blocked {blockedFor}</Text> : null}
        {row.processAlive === false && row.state === 'working' ? (
          <Text color="red"> · process stale</Text>
        ) : null}
      </Box>

      {row.summary && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Activity:</Text>
          <Text italic>{row.summary}</Text>
        </Box>
      )}

      {row.cwd && (
        <Box marginTop={1}>
          <Text dimColor>cwd: </Text>
          <Text>{row.cwd}</Text>
        </Box>
      )}

      {row.prUrl && (
        <Box marginTop={1}>
          <Text dimColor>PR: </Text>
          <Text>{row.prUrl}</Text>
          {row.prCheckStatus ? (
            <Text dimColor> · {row.prCheckStatus}</Text>
          ) : null}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {replyFocused ? 'Reply (Enter to send, Esc to cancel):' : 'Reply: press [r]'}
        </Text>
        {replyFocused ? (
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => {
                onSubmitReply(v)
                setDraft('')
              }}
              placeholder="Type a reply…"
            />
          </Box>
        ) : null}
      </Box>

      {flash && (
        <Box marginTop={1}>
          <Text color={flash.kind === 'ok' ? 'green' : 'red'}>
            {flash.kind === 'ok' ? '✓ ' : '✗ '}
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}
