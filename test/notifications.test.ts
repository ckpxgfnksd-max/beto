import { describe, it, expect } from 'vitest'
import { NotificationManager, type NotificationPayload } from '../src/lib/notifications.js'
import { MemoryNotificationLedger } from '../src/lib/notificationLedger.js'
import type { SessionSnapshot } from '../src/lib/types.js'

function row(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    harness: 'claude',
    sessionId: 's1',
    name: 'Quasar',
    state: 'working',
    summary: '',
    lastTransitionAt: 0,
    processAlive: true,
    prUrl: '',
    prCheckStatus: '',
    cwd: '',
    rawStateString: '',
    ...over,
  }
}

// A dispatcher that captures calls into a list and never invokes a real OS.
function recordingDispatcher(): {
  fn: (p: NotificationPayload) => Promise<void>
  fired: NotificationPayload[]
} {
  const fired: NotificationPayload[] = []
  return {
    fn: async (p) => {
      fired.push(p)
    },
    fired,
  }
}

describe('NotificationManager — cold start (no prior ledger)', () => {
  it('silently seeds the ledger from already-blocked sessions; does NOT fire', () => {
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({ coldStart: true })
    let coldStartCalls: number[] = []
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
      ledger,
      onColdStart: (n) => coldStartCalls.push(n),
    })
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
    expect(ledger.hasNotified('claude:s1')).toBe(true)
    expect(coldStartCalls).toEqual([1])
  })

  it('onColdStart fires exactly once even with zero blocked sessions', () => {
    const ledger = new MemoryNotificationLedger({ coldStart: true })
    let seededReports: number[] = []
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: recordingDispatcher().fn,
      now: () => 1000,
      ledger,
      onColdStart: (n) => seededReports.push(n),
    })
    mgr.observe([row({ state: 'working' })])
    expect(seededReports).toEqual([0])
    // Second tick is a normal one — onColdStart is NOT invoked again.
    mgr.observe([row({ state: 'working' })])
    expect(seededReports).toEqual([0])
  })

  it('subsequent transition fires after cold-start was consumed', () => {
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({ coldStart: true })
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
      ledger,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(1)
  })
})

describe('NotificationManager — warm start (ledger already exists)', () => {
  it('first emission of a session NOT in ledger fires (startup-discovery)', () => {
    // The "warm start, but this particular session is brand new" case.
    // Catches sessions that transitioned to blocked while beto was off.
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({
      coldStart: false,
      prefill: [
        // Some unrelated session already seen previously.
        { key: 'claude:other', firstSeenMs: 0, lastFiredMs: 0 },
      ],
    })
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
      ledger,
    })
    const fired = mgr.observe([row({ sessionId: 'new', state: 'needs-input' })])
    expect(fired).toHaveLength(1)
    expect(ledger.hasNotified('claude:new')).toBe(true)
  })

  it('first emission of a session ALREADY in ledger does NOT fire (already told)', () => {
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({
      coldStart: false,
      prefill: [{ key: 'claude:s1', firstSeenMs: 0, lastFiredMs: 0 }],
    })
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
      ledger,
    })
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
  })

  it('clears ledger entry when state leaves needs-input, so re-block fires fresh', () => {
    const rec = recordingDispatcher()
    let now = 100_000
    const ledger = new MemoryNotificationLedger({
      coldStart: false,
      prefill: [{ key: 'claude:s1', firstSeenMs: 0, lastFiredMs: 0 }],
    })
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      throttleMs: 30_000,
      now: () => now,
      ledger,
    })
    // First: ledger says we already told them — skip.
    mgr.observe([row({ state: 'needs-input' })])
    expect(rec.fired).toHaveLength(0)
    expect(ledger.hasNotified('claude:s1')).toBe(true)

    // Session goes back to working — ledger entry cleared.
    now += 60_000
    mgr.observe([row({ state: 'working' })])
    expect(ledger.hasNotified('claude:s1')).toBe(false)

    // Re-block → fires fresh.
    now += 60_000
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(1)
  })
})

describe('NotificationManager — in-process behavior', () => {
  // Helper: build a manager with a normal warm ledger, no cold start.
  function mgrSetup(opts?: { throttleMs?: number; nowSource?: () => number }) {
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({ coldStart: false })
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      throttleMs: opts?.throttleMs ?? 30_000,
      now: opts?.nowSource ?? (() => 1000),
      ledger,
    })
    return { mgr, rec, ledger }
  }

  it('fires on a transition INTO needs-input', () => {
    const { mgr, rec } = mgrSetup()
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input', summary: 'help me' })])
    expect(fired).toHaveLength(1)
    expect(fired[0]?.message).toBe('help me')
    expect(fired[0]?.title).toMatch(/Quasar/)
  })

  it('does not fire when a blocked session stays blocked', () => {
    const { mgr, rec } = mgrSetup()
    mgr.observe([row({ state: 'working' })])
    mgr.observe([row({ state: 'needs-input' })])
    rec.fired.length = 0
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
  })

  it('fires again on a fresh needs-input transition after unblocking, respecting throttle', () => {
    let now = 1000
    const { mgr } = mgrSetup({ throttleMs: 30_000, nowSource: () => now })
    mgr.observe([row({ state: 'working' })])
    now = 2000
    mgr.observe([row({ state: 'needs-input' })])
    now = 3000
    mgr.observe([row({ state: 'working' })])
    // Within throttle window: should NOT fire even though state pattern repeats.
    now = 4000
    const a = mgr.observe([row({ state: 'needs-input' })])
    expect(a).toHaveLength(0)
    // After throttle window: should fire again.
    now = 50_000
    mgr.observe([row({ state: 'working' })])
    now = 60_000
    const b = mgr.observe([row({ state: 'needs-input' })])
    expect(b).toHaveLength(1)
  })

  it('handles multiple sessions independently', () => {
    const { mgr } = mgrSetup()
    mgr.observe([
      row({ sessionId: 'a', state: 'working' }),
      row({ sessionId: 'b', state: 'working' }),
    ])
    const fired = mgr.observe([
      row({ sessionId: 'a', state: 'needs-input', name: 'Alpha' }),
      row({ sessionId: 'b', state: 'working' }),
    ])
    expect(fired).toHaveLength(1)
    expect(fired[0]?.title).toMatch(/Alpha/)
  })

  it('keys by harness + sessionId so same id across harnesses is distinct', () => {
    const { mgr } = mgrSetup()
    mgr.observe([
      row({ sessionId: 'x', harness: 'claude', state: 'working' }),
      row({ sessionId: 'x', harness: 'codex', state: 'working' }),
    ])
    const fired = mgr.observe([
      row({ sessionId: 'x', harness: 'claude', state: 'needs-input', name: 'Q' }),
      row({ sessionId: 'x', harness: 'codex', state: 'needs-input', name: 'N' }),
    ])
    expect(fired).toHaveLength(2)
  })

  it('does nothing when disabled but still tracks state + ledger observations', () => {
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({ coldStart: false })
    const mgr = new NotificationManager({
      enabled: false,
      dispatcher: rec.fn,
      now: () => 1000,
      ledger,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
  })

  it('builds a sensible payload when the session has no summary', () => {
    const { mgr } = mgrSetup()
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input', name: 'Quasar' })])
    expect(fired[0]?.title).toMatch(/needs you/)
    expect(fired[0]?.message).toMatch(/Quasar/)
    expect(fired[0]?.message).toMatch(/claude/)
  })

  it('passes sound flag through to the payload', () => {
    const rec = recordingDispatcher()
    const ledger = new MemoryNotificationLedger({ coldStart: false })
    const mgr = new NotificationManager({
      enabled: true,
      sound: true,
      dispatcher: rec.fn,
      now: () => 1000,
      ledger,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired[0]?.sound).toBe(true)
  })
})
