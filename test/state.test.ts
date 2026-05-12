import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { StateReader, normalizeState, parseState } from '../src/sources/state.js'

describe('normalizeState', () => {
  it('maps the canonical strings', () => {
    expect(normalizeState('working')).toBe('working')
    expect(normalizeState('needs-input')).toBe('needs-input')
    expect(normalizeState('completed')).toBe('completed')
    expect(normalizeState('failed')).toBe('failed')
    expect(normalizeState('stopped')).toBe('stopped')
    expect(normalizeState('idle')).toBe('idle')
  })

  it('folds variants', () => {
    expect(normalizeState('Running')).toBe('working')
    expect(normalizeState('needsInput')).toBe('needs-input')
    expect(normalizeState('blocked')).toBe('needs-input')
    expect(normalizeState('done')).toBe('completed')
    expect(normalizeState('errored')).toBe('failed')
    expect(normalizeState('cancelled')).toBe('stopped')
  })

  it('handles whitespace, underscores, mixed case', () => {
    expect(normalizeState('  WAITING_FOR_INPUT ')).toBe('needs-input')
  })

  it('falls through to unknown rather than dropping', () => {
    expect(normalizeState('halted-by-mars-rover')).toBe('unknown')
  })
})

describe('parseState', () => {
  const NOW = 1_000_000_000_000

  it('returns null when session id is missing', () => {
    expect(parseState({}, NOW, NOW)).toBeNull()
    expect(parseState({ name: 'Quasar' }, NOW, NOW)).toBeNull()
  })

  it('parses the minimum-viable payload', () => {
    const r = parseState(
      { session_id: 'a1', state: 'working', summary: 'do thing' },
      NOW,
      NOW,
    )
    expect(r).not.toBeNull()
    expect(r!.sessionId).toBe('a1')
    expect(r!.state).toBe('working')
    expect(r!.summary).toBe('do thing')
    expect(r!.processAlive).toBe(true)
    expect(r!.lastTransitionAt).toBe(NOW)
  })

  it('accepts camelCase variants', () => {
    const r = parseState(
      { sessionId: 'b2', status: 'needsInput', activity: 'wait pls', prUrl: 'https://x' },
      NOW,
      NOW,
    )
    expect(r!.sessionId).toBe('b2')
    expect(r!.state).toBe('needs-input')
    expect(r!.summary).toBe('wait pls')
    expect(r!.prUrl).toBe('https://x')
  })

  it('flips stale working sessions to stopped', () => {
    const oldMtime = NOW - 10 * 60 * 1000
    const r = parseState(
      { session_id: 'c3', state: 'working' },
      oldMtime,
      NOW,
    )
    expect(r!.state).toBe('stopped')
    expect(r!.processAlive).toBe(false)
  })

  it('leaves recent working sessions alive', () => {
    const r = parseState({ session_id: 'd4', state: 'working' }, NOW - 30_000, NOW)
    expect(r!.state).toBe('working')
    expect(r!.processAlive).toBe(true)
  })

  it('uses fallback name from sessionId when name absent', () => {
    const r = parseState({ session_id: 'sess-abcdef-999', state: 'idle' }, NOW, NOW)
    expect(r!.name).toBe('sess-abc')
  })
})

describe('StateReader', () => {
  it('returns empty on missing jobs dir', async () => {
    const reader = new StateReader({
      jobsDir: '/nope/does/not/exist/' + Math.random(),
      now: () => 1,
      readTranscripts: false,
    })
    const rows = await reader.scan()
    expect(rows).toEqual([])
  })

  it('reads multiple state.json files and sorts by lastTransitionAt desc', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-test-'))
    await fs.mkdir(path.join(dir, 'a'))
    await fs.mkdir(path.join(dir, 'b'))
    await fs.writeFile(
      path.join(dir, 'a', 'state.json'),
      JSON.stringify({ session_id: 'a', state: 'working', last_transition_at: 100 }),
    )
    await fs.writeFile(
      path.join(dir, 'b', 'state.json'),
      JSON.stringify({ session_id: 'b', state: 'working', last_transition_at: 200 }),
    )
    const reader = new StateReader({ jobsDir: dir, now: () => 300, readTranscripts: false })
    const rows = await reader.scan()
    expect(rows.map((r) => r.sessionId)).toEqual(['b', 'a'])
  })

  it('emits to onChange listener', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-test-'))
    await fs.mkdir(path.join(dir, 'a'))
    await fs.writeFile(
      path.join(dir, 'a', 'state.json'),
      JSON.stringify({ session_id: 'a', state: 'idle' }),
    )
    const reader = new StateReader({ jobsDir: dir, now: () => Date.now(), readTranscripts: false })
    let received: unknown[] = []
    reader.onChange((rows) => {
      received = rows
    })
    await reader.scan()
    expect(received).toHaveLength(1)
  })

  it('survives malformed JSON without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-test-'))
    await fs.mkdir(path.join(dir, 'broken'))
    await fs.writeFile(path.join(dir, 'broken', 'state.json'), '{not-json')
    const reader = new StateReader({ jobsDir: dir, now: () => Date.now(), readTranscripts: false })
    const rows = await reader.scan()
    expect(rows).toEqual([])
  })

  it('merges transcript tokens onto state.json rows when sessionIds match', async () => {
    const NOW = 1_700_000_000_000
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-jobs-'))
    const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-proj-'))

    // state.json says session "a" is working
    await fs.mkdir(path.join(jobsDir, 'a'))
    await fs.writeFile(
      path.join(jobsDir, 'a', 'state.json'),
      JSON.stringify({
        session_id: 'a',
        state: 'working',
        last_transition_at: NOW - 5_000,
      }),
    )
    // transcript for session "a" has token usage
    const proj = path.join(projectsDir, '-proj')
    await fs.mkdir(proj)
    await fs.writeFile(
      path.join(proj, 'a.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW - 10_000).toISOString(),
        message: { usage: { input_tokens: 600, output_tokens: 200 } },
      }),
    )

    const reader = new StateReader({ jobsDir, projectsDir, now: () => NOW })
    const rows = await reader.scan()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('a')
    expect(rows[0]!.state).toBe('working') // state.json wins
    expect(rows[0]!.tokensIn).toBe(600)
    expect(rows[0]!.tokensOut).toBe(200)
    expect(rows[0]!.tokenRateLast60s).toBe(3) // 200 output / 60s ≈ 3
  })

  it('synthesizes sessions present only in transcripts (no state.json)', async () => {
    const NOW = 1_700_000_000_000
    const jobsDir = '/nope/no/jobs/' + Math.random()
    const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-proj-'))
    const proj = path.join(projectsDir, '-proj')
    await fs.mkdir(proj)
    await fs.writeFile(
      path.join(proj, 'foreground-sid.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW - 5_000).toISOString(),
        message: { usage: { input_tokens: 50, output_tokens: 20 } },
      }),
    )
    const reader = new StateReader({ jobsDir, projectsDir, now: () => NOW })
    const rows = await reader.scan()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('foreground-sid')
    expect(rows[0]!.state).toBe('working') // synthesized from recent activity
    expect(rows[0]!.tokensIn).toBe(50)
  })
})
