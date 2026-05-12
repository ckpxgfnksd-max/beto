import { describe, it, expect } from 'vitest'
import { NotificationManager, type NotificationPayload } from '../src/lib/notifications.js'
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

describe('NotificationManager', () => {
  it('does not fire on the first emission of an already-blocked session', () => {
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
  })

  it('fires on a transition INTO needs-input', () => {
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input', summary: 'help me' })])
    expect(fired).toHaveLength(1)
    expect(fired[0]?.message).toBe('help me')
    expect(fired[0]?.title).toMatch(/Quasar/)
  })

  it('does not fire when a blocked session stays blocked', () => {
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
    mgr.observe([row({ state: 'working' })])
    mgr.observe([row({ state: 'needs-input' })])
    rec.fired.length = 0
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
  })

  it('fires again on a fresh needs-input transition after unblocking, respecting throttle', () => {
    const rec = recordingDispatcher()
    let now = 1000
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      throttleMs: 30_000,
      now: () => now,
    })
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
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
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
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
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

  it('does nothing when disabled but still tracks state', () => {
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: false,
      dispatcher: rec.fn,
      now: () => 1000,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired).toHaveLength(0)
    expect(rec.fired).toHaveLength(0)
  })

  it('builds a sensible payload when the session has no summary', () => {
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input', name: 'Quasar' })])
    expect(fired[0]?.title).toMatch(/needs you/)
    expect(fired[0]?.message).toMatch(/Quasar/)
    expect(fired[0]?.message).toMatch(/claude/)
  })

  it('passes sound flag through to the payload', () => {
    const rec = recordingDispatcher()
    const mgr = new NotificationManager({
      enabled: true,
      sound: true,
      dispatcher: rec.fn,
      now: () => 1000,
    })
    mgr.observe([row({ state: 'working' })])
    const fired = mgr.observe([row({ state: 'needs-input' })])
    expect(fired[0]?.sound).toBe(true)
  })
})
