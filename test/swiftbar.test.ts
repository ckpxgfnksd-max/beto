import { describe, it, expect } from 'vitest'
import { renderSwiftBar } from '../src/lib/swiftbar.js'
import type { SessionSnapshot } from '../src/lib/types.js'

const NOW = 1_800_000_000_000

function row(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    harness: 'claude',
    sessionId: 's1',
    name: 'X',
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

describe('renderSwiftBar', () => {
  it('emits an idle title when no rows', () => {
    const out = renderSwiftBar([], { now: () => NOW })
    expect(out.split('\n')[0]).toContain('beto · idle')
  })

  it('puts needs-input + live counts on the menubar title', () => {
    const rows = [
      row({ sessionId: 'a', state: 'needs-input', lastTransitionAt: NOW - 90_000 }),
      row({ sessionId: 'b', state: 'working' }),
      row({ sessionId: 'c', state: 'working' }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    const title = out.split('\n')[0]
    expect(title).toMatch(/⚠ 1/)
    expect(title).toMatch(/● 2 live/)
  })

  it('colors the title red when an abandoned session exists', () => {
    const rows = [row({ state: 'needs-input', lastTransitionAt: NOW - 10 * 60 * 1000 })]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out.split('\n')[0]).toContain('color=red')
  })

  it('colors the title orange for awaiting only', () => {
    const rows = [row({ state: 'needs-input', lastTransitionAt: NOW - 20_000 })]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out.split('\n')[0]).toContain('color=orange')
  })

  it('renders harness sigil + name + blocked time for needs-you rows', () => {
    const rows = [
      row({
        sessionId: 'a',
        name: 'Quasar',
        harness: 'codex',
        state: 'needs-input',
        lastTransitionAt: NOW - 2 * 60 * 1000,
      }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).toContain('Quasar')
    expect(out).toMatch(/ X /) // codex sigil
    expect(out).toContain('escalated 2m')
  })

  it('shows TPS when tokenRateLast60s > 0', () => {
    const rows = [
      row({
        sessionId: 'a',
        name: 'Vega',
        state: 'working',
        lastTransitionAt: NOW - 60_000,
        tokenRateLast60s: 42,
      }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).toContain('42 tps')
  })

  it('omits TPS when 0 or absent', () => {
    const rows = [
      row({ sessionId: 'a', name: 'Lyra', state: 'working', lastTransitionAt: NOW - 60_000 }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).not.toContain('tps')
  })

  it('puts the open-inbox footer with the resolved beto path', () => {
    const out = renderSwiftBar([], { now: () => NOW, betoPath: '/opt/bin/beto' })
    expect(out).toContain('Open beto inbox | bash=/opt/bin/beto terminal=true')
  })

  it('groups rows by bucket (NEEDS YOU / ACTIVE / RECENT) with section headers', () => {
    const rows = [
      row({ sessionId: 'a', name: 'A', state: 'needs-input', lastTransitionAt: NOW - 30_000 }),
      row({ sessionId: 'b', name: 'B', state: 'working' }),
      row({ sessionId: 'c', name: 'C', state: 'completed' }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).toContain('NEEDS YOU (1)')
    expect(out).toContain('ACTIVE (1)')
    expect(out).toContain('RECENT')
  })

  it('shows time-in-state for working rows without the literal "working" word', () => {
    // The green glyph + green row color say "working". The text uses
    // the freed space for the time-in-state alone.
    const rows = [
      row({
        sessionId: 'a',
        name: 'R',
        state: 'working',
        lastTransitionAt: NOW - 5 * 60 * 1000,
      }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).toContain('5m')
    expect(out).not.toMatch(/working 5m/)
    // And the row gets the green color flag
    expect(out).toMatch(/font=Menlo color=green/)
  })

  it('keeps the "idle Xs" label so gray rows are still readable', () => {
    const rows = [
      row({
        sessionId: 'b',
        name: 'L',
        state: 'idle',
        lastTransitionAt: NOW - 120_000,
      }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).toMatch(/idle 2m/)
  })

  it('shows cumulative input tokens when present', () => {
    const rows = [
      row({
        sessionId: 'c',
        name: 'Q',
        state: 'working',
        lastTransitionAt: NOW - 10_000,
        tokensIn: 5_900_000,
        tokensOut: 24_100,
        tokenRateLast60s: 142,
      }),
    ]
    const out = renderSwiftBar(rows, { now: () => NOW })
    expect(out).toContain('5.9M in')
    expect(out).toContain('24.1k out')
    expect(out).toContain('142 tps')
  })

  it('uses sfcolor-compatible color names that SwiftBar recognizes', () => {
    const rows = [row({ state: 'needs-input', lastTransitionAt: NOW - 10 * 60 * 1000 })]
    const out = renderSwiftBar(rows, { now: () => NOW })
    // SwiftBar accepts color=red/orange/yellow/green/blue/purple/gray/etc.
    // We use them as plain names (not hex) for built-in palette.
    expect(out).toMatch(/color=(red|orange|gray|#)/)
  })

  it('renders the menubar title on the very first line', () => {
    const rows = [row({ state: 'working' })]
    const out = renderSwiftBar(rows, { now: () => NOW })
    const lines = out.split('\n')
    // First line is the title; second is the "---" separator
    expect(lines[0]).toMatch(/●|beto/)
    expect(lines[1]).toBe('---')
  })
})
