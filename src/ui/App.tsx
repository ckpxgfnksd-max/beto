import React, { useEffect, useMemo } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { useInbox, groupRows } from '../store/inbox.js'
import { StateReader } from '../sources/state.js'
import { Inbox } from './Inbox.js'
import { Peek } from './Peek.js'
import { Dispatch as DispatchView } from './Dispatch.js'
import { attach, dispatch, reply, resolveDispatchCwd } from '../lib/commander.js'

interface Props {
  reader: StateReader
}

// App root. Owns:
//   - the StateReader subscription (state.json polling)
//   - the 5s tick that advances escalation timing
//   - the keyboard handler (1-9 peek, d dispatch, a attach, r reply, q quit, esc back)
//   - the view switch (inbox / peek / dispatch)
//
// Everything else is presentational.
export function App({ reader }: Props) {
  const { exit } = useApp()
  const rows = useInbox((s) => s.rows)
  const now = useInbox((s) => s.now)
  const view = useInbox((s) => s.view)
  const peekId = useInbox((s) => s.peekId)
  const flash = useInbox((s) => s.flash)

  const setRows = useInbox((s) => s.setRows)
  const tick = useInbox((s) => s.tick)
  const peek = useInbox((s) => s.peek)
  const openDispatch = useInbox((s) => s.openDispatch)
  const closeOverlay = useInbox((s) => s.closeOverlay)
  const setFlash = useInbox((s) => s.setFlash)

  // Subscribe to the state reader and start its polling loop.
  useEffect(() => {
    const unsub = reader.onChange((next) => setRows(next))
    reader.start()
    return () => {
      unsub()
      reader.stop()
    }
  }, [reader, setRows])

  // Tick every 5s so the escalation tier (awaiting → escalated → abandoned)
  // advances without waiting for a state.json change.
  useEffect(() => {
    const id = setInterval(tick, 5_000)
    return () => clearInterval(id)
  }, [tick])

  // Flat index → row lookup. Mirrors the order Inbox renders rows in so
  // the 1-9 hotkeys land on the right card.
  const flatRows = useMemo(() => {
    const { needsYou, active, recent } = groupRows(rows, now)
    return [...needsYou.map((x) => x.row), ...active, ...recent]
  }, [rows, now])

  // Reply input mode: when peeked and the user pressed 'r', we hand the
  // raw stdin over to ink-text-input. Track that here so the keyboard
  // handler doesn't double-fire on the same keystrokes.
  const [replyFocused, setReplyFocused] = React.useState(false)
  useEffect(() => {
    if (view !== 'peek') setReplyFocused(false)
  }, [view])

  useInput(
    (input, key) => {
      // Quit anywhere.
      if (input === 'q' && !replyFocused && view !== 'dispatch') {
        exit()
        return
      }

      // Escape returns to inbox from any overlay.
      if (key.escape) {
        if (replyFocused) {
          setReplyFocused(false)
          return
        }
        if (view !== 'inbox') closeOverlay()
        return
      }

      // Dispatch from anywhere.
      if (input === 'd' && view === 'inbox') {
        openDispatch()
        return
      }

      // Peek hotkeys 1-9 from inbox.
      if (view === 'inbox') {
        const n = parseInt(input, 10)
        if (!isNaN(n) && n >= 1 && n <= 9) {
          const target = flatRows[n - 1]
          if (target) peek(target.sessionId)
          return
        }
        if (input === '0') {
          peek(null)
          return
        }
      }

      // Peek-mode actions.
      if (view === 'peek' && peekId && !replyFocused) {
        const row = flatRows.find((r) => r.sessionId === peekId)
        if (!row) return
        if (input === 'a') {
          void attach(row.sessionId).then((res) => {
            setFlash(
              res.ok
                ? { kind: 'ok', text: res.message }
                : { kind: 'err', text: `${res.kind}: ${res.message}` },
            )
          })
          return
        }
        if (input === 'r') {
          setReplyFocused(true)
          return
        }
      }
    },
    { isActive: view !== 'dispatch' || !replyFocused },
  )

  if (view === 'dispatch') {
    return (
      <Box flexDirection="column" padding={1}>
        <DispatchView
          defaultCwd={resolveDispatchCwd()}
          flash={flash}
          onSubmit={(prompt, cwd) => {
            void dispatch(prompt, cwd).then((res) => {
              setFlash(
                res.ok
                  ? { kind: 'ok', text: res.message }
                  : { kind: 'err', text: `${res.kind}: ${res.message}` },
              )
              if (res.ok) closeOverlay()
            })
          }}
        />
        <Footer mode="dispatch" />
      </Box>
    )
  }

  if (view === 'peek' && peekId) {
    const row = flatRows.find((r) => r.sessionId === peekId)
    if (!row) {
      // Row disappeared between peek and render — return to inbox.
      closeOverlay()
      return null
    }
    return (
      <Box flexDirection="column" padding={1}>
        <Peek
          row={row}
          now={now}
          replyFocused={replyFocused}
          flash={flash}
          onSubmitReply={(text) => {
            void reply(row.sessionId, text).then((res) => {
              setFlash(
                res.ok
                  ? { kind: 'ok', text: res.message }
                  : { kind: 'err', text: `${res.kind}: ${res.message}` },
              )
              setReplyFocused(false)
            })
          }}
        />
        <Footer mode="peek" />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Inbox rows={rows} now={now} cursorId={peekId} />
      {flash && (
        <Box marginTop={1}>
          <Text color={flash.kind === 'ok' ? 'green' : 'red'}>
            {flash.kind === 'ok' ? '✓ ' : '✗ '}
            {flash.text}
          </Text>
        </Box>
      )}
      <Footer mode="inbox" />
    </Box>
  )
}

function Footer({ mode }: { mode: 'inbox' | 'peek' | 'dispatch' }) {
  const hints =
    mode === 'inbox'
      ? '[1-9] peek  [d] dispatch  [q] quit'
      : mode === 'peek'
        ? '[a] attach  [r] reply  [Esc] back  [q] quit'
        : '[Enter] confirm  [Esc] back'
  return (
    <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>{hints}</Text>
    </Box>
  )
}
