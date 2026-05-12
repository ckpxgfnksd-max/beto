import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Inbox } from '../src/ui/Inbox.js'
import { Peek } from '../src/ui/Peek.js'
import type { HarnessId, SessionSnapshot } from '../src/lib/types.js'

const NOW = 1_000_000_000_000

function s(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    harness: 'claude',
    sessionId: 'x',
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

// Wide-mode props default — keeps the v0.1-equivalent renders simple.
function wideProps(rows: SessionSnapshot[], cursorId: string | null = null) {
  return {
    rows,
    now: NOW,
    cursorId,
    harnessCounts: counts(rows),
    harnessFilter: null,
    width: 100,
  }
}

function counts(rows: SessionSnapshot[]): Record<HarnessId, number> {
  const out: Partial<Record<HarnessId, number>> = {}
  for (const r of rows) out[r.harness] = (out[r.harness] ?? 0) + 1
  return out as Record<HarnessId, number>
}

describe('Inbox render (wide)', () => {
  it('shows the empty-state message when no sessions', () => {
    const { lastFrame } = render(<Inbox {...wideProps([])} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('beto')
    expect(out).toContain('chamber is quiet')
  })

  it('renders three bucket headers and the needs-you count in header', () => {
    const rows = [
      s({ sessionId: 'a', name: 'Alpha', state: 'needs-input', lastTransitionAt: NOW - 30_000, summary: 'asking the user a question' }),
      s({ sessionId: 'b', name: 'Bravo', state: 'working', summary: 'doing the thing' }),
      s({ sessionId: 'c', name: 'Charlie', state: 'completed', summary: 'merged the PR' }),
    ]
    const { lastFrame } = render(<Inbox {...wideProps(rows)} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('Need (1)')
    expect(out).toContain('Active (1)')
    expect(out).toContain('Recent (1)')
    expect(out).toContain('Alpha')
    expect(out).toContain('Bravo')
    expect(out).toContain('Charlie')
    expect(out).toContain('1 needs you')
  })

  it('shows escalation tier label on a blocked row', () => {
    const rows = [
      s({ sessionId: 'a', name: 'Alpha', state: 'needs-input', lastTransitionAt: NOW - 10 * 60_000, summary: 'stuck' }),
    ]
    const { lastFrame } = render(<Inbox {...wideProps(rows)} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('abandoned')
    expect(out).toContain('blocked')
  })

  it('marks the cursored row with ▶', () => {
    const rows = [s({ sessionId: 'a', name: 'Alpha', state: 'working' })]
    const { lastFrame } = render(<Inbox {...wideProps(rows, 'a')} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('▶')
  })

  it('shows mixed-harness sigils in the header tally', () => {
    const rows = [
      s({ sessionId: 'a', name: 'Alpha', harness: 'claude', state: 'working' }),
      s({ sessionId: 'b', name: 'Bravo', harness: 'codex', state: 'working' }),
      s({ sessionId: 'c', name: 'Carl', harness: 'hermes', state: 'idle' }),
    ]
    const { lastFrame } = render(<Inbox {...wideProps(rows)} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('1C')
    expect(out).toContain('1X')
    expect(out).toContain('1H')
  })
})

describe('Inbox render (sidebar mode)', () => {
  it('switches to compact section headers under 80 cols', () => {
    const rows = [s({ sessionId: 'a', name: 'Alpha', state: 'working' })]
    const props = { ...wideProps(rows), width: 60 }
    const { lastFrame } = render(<Inbox {...props} />)
    const out = lastFrame() ?? ''
    // Sidebar section header style: "▌Active · 1" instead of "▌ Active (1)"
    expect(out).toContain('▌Active · 1')
  })

  it('drops the summary line in ultra-compact (<50 cols)', () => {
    const rows = [
      s({ sessionId: 'a', name: 'Alpha', state: 'needs-input', lastTransitionAt: NOW - 30_000, summary: 'this should not appear' }),
    ]
    const props = { ...wideProps(rows), width: 40 }
    const { lastFrame } = render(<Inbox {...props} />)
    const out = lastFrame() ?? ''
    expect(out).not.toContain('this should not appear')
    expect(out).toContain('Alpha')
  })
})

describe('Inbox render (filter)', () => {
  it('surfaces the active filter in the header', () => {
    const rows = [s({ sessionId: 'a', name: 'Alpha', state: 'working' })]
    const props = { ...wideProps(rows), harnessFilter: new Set<HarnessId>(['codex']) }
    const { lastFrame } = render(<Inbox {...props} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('filter:')
  })

  it('shows a filter-aware empty state', () => {
    const props = { ...wideProps([]), harnessFilter: new Set<HarnessId>(['codex']) }
    const { lastFrame } = render(<Inbox {...props} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('No sessions match')
  })
})

describe('Peek render', () => {
  it('shows session detail and reply hint', () => {
    const row = s({
      sessionId: 'sess-quasar',
      name: 'Quasar',
      state: 'needs-input',
      lastTransitionAt: NOW - 90_000,
      summary: 'asking whether to keep both migrations',
      cwd: '/Users/x/repo',
      prUrl: 'https://github.com/x/y/pull/1',
      prCheckStatus: 'pending',
    })
    const { lastFrame } = render(
      <Peek row={row} now={NOW} replyFocused={false} flash={null} onSubmitReply={() => {}} />,
    )
    const out = lastFrame() ?? ''
    expect(out).toContain('Quasar')
    expect(out).toContain('sess-quasar')
    expect(out).toContain('blocked 1m 30s')
    expect(out).toContain('asking whether to keep both migrations')
    expect(out).toContain('/Users/x/repo')
    expect(out).toContain('pull/1')
    expect(out).toContain('press [r]')
    expect(out).toContain('Claude Code')
  })

  it('shows the flash banner when present', () => {
    const row = s({ sessionId: 'a', name: 'Alpha', state: 'working' })
    const { lastFrame } = render(
      <Peek
        row={row}
        now={NOW}
        replyFocused={false}
        flash={{ kind: 'ok', text: 'attached to a in Terminal' }}
        onSubmitReply={() => {}}
      />,
    )
    const out = lastFrame() ?? ''
    expect(out).toContain('attached to a in Terminal')
  })

  it('shows the correct harness name for non-Claude sessions', () => {
    const row = s({ sessionId: 'a', name: 'Alpha', harness: 'codex', state: 'working' })
    const { lastFrame } = render(
      <Peek row={row} now={NOW} replyFocused={false} flash={null} onSubmitReply={() => {}} />,
    )
    const out = lastFrame() ?? ''
    expect(out).toContain('Codex')
  })
})
