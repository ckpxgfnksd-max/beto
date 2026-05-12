import { describe, it, expect } from 'vitest'
import { groupRows } from '../src/store/inbox.js'
import { deriveTier, formatBlockedFor } from '../src/lib/needsInput.js'
import type { SessionSnapshot } from '../src/lib/types.js'

const NOW = 1_000_000_000_000

function row(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    sessionId: 'x',
    name: 'x',
    state: 'working',
    summary: '',
    lastTransitionAt: NOW,
    processAlive: true,
    prUrl: '',
    prCheckStatus: '',
    cwd: '',
    rawStateString: '',
    ...over,
  }
}

describe('deriveTier', () => {
  it('returns none when not needs-input', () => {
    expect(deriveTier(row({ state: 'working' }), NOW)).toBe('none')
    expect(deriveTier(row({ state: 'completed' }), NOW)).toBe('none')
  })

  it('returns awaiting when blocked under 60s', () => {
    expect(deriveTier(row({ state: 'needs-input', lastTransitionAt: NOW - 30_000 }), NOW)).toBe('awaiting')
  })

  it('returns escalated between 60s and 5m', () => {
    expect(deriveTier(row({ state: 'needs-input', lastTransitionAt: NOW - 90_000 }), NOW)).toBe('escalated')
    expect(deriveTier(row({ state: 'needs-input', lastTransitionAt: NOW - 4 * 60_000 }), NOW)).toBe('escalated')
  })

  it('returns abandoned past 5m', () => {
    expect(deriveTier(row({ state: 'needs-input', lastTransitionAt: NOW - 6 * 60_000 }), NOW)).toBe('abandoned')
    expect(deriveTier(row({ state: 'needs-input', lastTransitionAt: NOW - 60 * 60_000 }), NOW)).toBe('abandoned')
  })
})

describe('formatBlockedFor', () => {
  it('returns empty for non-blocked', () => {
    expect(formatBlockedFor(row({ state: 'working' }), NOW)).toBe('')
  })

  it('formats seconds, minutes, hours', () => {
    expect(formatBlockedFor(row({ state: 'needs-input', lastTransitionAt: NOW - 30_000 }), NOW)).toBe('30s')
    expect(formatBlockedFor(row({ state: 'needs-input', lastTransitionAt: NOW - 90_000 }), NOW)).toBe('1m 30s')
    expect(formatBlockedFor(row({ state: 'needs-input', lastTransitionAt: NOW - 2 * 3600_000 }), NOW)).toBe('2h 0m')
  })
})

describe('groupRows', () => {
  it('puts needs-input first, sorted by tier severity', () => {
    const rows = [
      row({ sessionId: 'a', state: 'needs-input', lastTransitionAt: NOW - 30_000 }),     // awaiting
      row({ sessionId: 'b', state: 'needs-input', lastTransitionAt: NOW - 10 * 60_000 }), // abandoned
      row({ sessionId: 'c', state: 'working' }),
      row({ sessionId: 'd', state: 'needs-input', lastTransitionAt: NOW - 2 * 60_000 }),  // escalated
    ]
    const g = groupRows(rows, NOW)
    expect(g.needsYou.map((x) => x.row.sessionId)).toEqual(['b', 'd', 'a'])
    expect(g.active.map((r) => r.sessionId)).toEqual(['c'])
  })

  it('caps recent at 8', () => {
    const rows: SessionSnapshot[] = []
    for (let i = 0; i < 12; i++) {
      rows.push(row({ sessionId: `s${i}`, state: 'completed', lastTransitionAt: NOW - i * 1000 }))
    }
    const g = groupRows(rows, NOW)
    expect(g.recent).toHaveLength(8)
  })
})
