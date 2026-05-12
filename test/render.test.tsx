import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Inbox } from '../src/ui/Inbox.js'
import { Peek } from '../src/ui/Peek.js'
import type { SessionSnapshot } from '../src/lib/types.js'

const NOW = 1_000_000_000_000

function s(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
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

describe('Inbox render', () => {
  it('shows the empty-state message when no sessions', () => {
    const { lastFrame } = render(<Inbox rows={[]} now={NOW} cursorId={null} />)
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
    const { lastFrame } = render(<Inbox rows={rows} now={NOW} cursorId={null} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('Needs you (1)')
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
    const { lastFrame } = render(<Inbox rows={rows} now={NOW} cursorId={null} />)
    const out = lastFrame() ?? ''
    expect(out).toContain('abandoned')
    expect(out).toContain('blocked')
  })

  it('marks the cursored row with ▶', () => {
    const rows = [s({ sessionId: 'a', name: 'Alpha', state: 'working' })]
    const { lastFrame } = render(<Inbox rows={rows} now={NOW} cursorId="a" />)
    const out = lastFrame() ?? ''
    expect(out).toContain('▶')
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
})
