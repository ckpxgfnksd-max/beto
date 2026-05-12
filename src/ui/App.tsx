import React, { useEffect, useMemo } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { flatRows, groupRows, useInbox } from '../store/inbox.js'
import { HarnessRegistry } from '../sources/adapter.js'
import { Inbox } from './Inbox.js'
import { Peek } from './Peek.js'
import { Dispatch as DispatchView } from './Dispatch.js'
import { attach, dispatch, reply, resolveDispatchCwd } from '../lib/commander.js'
import type { NotificationManager } from '../lib/notifications.js'

interface Props {
  registry: HarnessRegistry
  // Optional so tests and the mock-dir path can pass nothing and skip
  // notifications. When present, each registry emission is fed in.
  notifier?: NotificationManager
}

// App root. Owns:
//   - the HarnessRegistry subscription (merged multi-harness emissions)
//   - the 5s tick that advances escalation timing
//   - the keyboard handler (1-9 peek, d dispatch, a attach, r reply,
//     f cycle harness filter, q quit, esc back)
//   - the view switch (inbox / peek / dispatch)
//
// Width comes from `useStdout().stdout.columns` and drives the layout-mode
// selection in Inbox/SidebarRow/Row.
export function App({ registry, notifier }: Props) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = stdout?.columns ?? 80

  const rowsByHarness = useInbox((s) => s.rowsByHarness)
  const harnessFilter = useInbox((s) => s.harnessFilter)
  const now = useInbox((s) => s.now)
  const view = useInbox((s) => s.view)
  const peekId = useInbox((s) => s.peekId)
  const flash = useInbox((s) => s.flash)

  const setHarnessRows = useInbox((s) => s.setHarnessRows)
  const tick = useInbox((s) => s.tick)
  const peek = useInbox((s) => s.peek)
  const openDispatch = useInbox((s) => s.openDispatch)
  const closeOverlay = useInbox((s) => s.closeOverlay)
  const setFlash = useInbox((s) => s.setFlash)
  const cycleHarnessFilter = useInbox((s) => s.cycleHarnessFilter)

  // Subscribe to the registry's merged stream. We split by harness on the
  // emit so the store's per-harness slices stay accurate — this lets a
  // future v0.3 expose "rows from this one harness only" without
  // re-flattening.
  useEffect(() => {
    const unsub = registry.onChange((merged) => {
      // Group the merged emission back by harness so setHarnessRows can
      // replace the right slice.
      const byHarness = new Map<string, typeof merged>()
      for (const row of merged) {
        const arr = byHarness.get(row.harness) ?? []
        arr.push(row)
        byHarness.set(row.harness, arr)
      }
      for (const [harness, rows] of byHarness) {
        setHarnessRows(harness as never, rows)
      }
      const seenIds = new Set(merged.map((r) => r.harness))
      for (const id of registry.harnessIds) {
        if (!seenIds.has(id)) setHarnessRows(id, [])
      }
      // v0.5: feed every merged emission to the notifier so it can fire
      // OS notifications on needs-input transitions. The notifier dedups
      // and throttles internally; the App doesn't need to track state.
      notifier?.observe(merged)
    })
    registry.start()
    return () => {
      unsub()
      registry.stop()
    }
  }, [registry, setHarnessRows, notifier])

  useEffect(() => {
    const id = setInterval(tick, 5_000)
    return () => clearInterval(id)
  }, [tick])

  // Memoize per-harness counts AND the filtered flat list so renderers
  // don't recompute on unrelated state changes.
  const filteredRows = useMemo(
    () => flatRows(rowsByHarness, harnessFilter),
    [rowsByHarness, harnessFilter],
  )

  const harnessCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [id, rows] of Object.entries(rowsByHarness)) out[id] = rows?.length ?? 0
    return out as never
  }, [rowsByHarness])

  // Flat index → row lookup. Mirrors Inbox's render order so the 1-9
  // hotkeys land on the right card.
  const flatForHotkeys = useMemo(() => {
    const { needsYou, active, recent } = groupRows(filteredRows, now)
    return [...needsYou.map((x) => x.row), ...active, ...recent]
  }, [filteredRows, now])

  const [replyFocused, setReplyFocused] = React.useState(false)
  useEffect(() => {
    if (view !== 'peek') setReplyFocused(false)
  }, [view])

  useInput(
    (input, key) => {
      if (input === 'q' && !replyFocused && view !== 'dispatch') {
        exit()
        return
      }

      if (key.escape) {
        if (replyFocused) {
          setReplyFocused(false)
          return
        }
        if (view !== 'inbox') closeOverlay()
        return
      }

      if (input === 'd' && view === 'inbox') {
        openDispatch()
        return
      }

      // Cycle harness filter from inbox view.
      if (input === 'f' && view === 'inbox') {
        cycleHarnessFilter(registry.harnessIds)
        return
      }

      if (view === 'inbox') {
        const n = parseInt(input, 10)
        if (!isNaN(n) && n >= 1 && n <= 9) {
          const target = flatForHotkeys[n - 1]
          if (target) peek(target.sessionId)
          return
        }
        if (input === '0') {
          peek(null)
          return
        }
      }

      if (view === 'peek' && peekId && !replyFocused) {
        const row = flatForHotkeys.find((r) => r.sessionId === peekId)
        if (!row) return
        if (input === 'a') {
          if (row.harness !== 'claude') {
            setFlash({
              kind: 'err',
              text: `attach is Claude-only in v0.2 (this is ${row.harness})`,
            })
            return
          }
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
          if (row.harness !== 'claude') {
            setFlash({
              kind: 'err',
              text: `reply is Claude-only in v0.2 (this is ${row.harness})`,
            })
            return
          }
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
    const row = flatForHotkeys.find((r) => r.sessionId === peekId)
    if (!row) {
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
      <Inbox
        rows={filteredRows}
        now={now}
        cursorId={peekId}
        harnessCounts={harnessCounts}
        harnessFilter={harnessFilter}
        width={width}
      />
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
      ? '[1-9] peek  [d] dispatch  [f] filter  [q] quit'
      : mode === 'peek'
        ? '[a] attach  [r] reply  [Esc] back  [q] quit'
        : '[Enter] confirm  [Esc] back'
  return (
    <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>{hints}</Text>
    </Box>
  )
}
