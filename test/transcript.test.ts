import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ClaudeTranscriptReader } from '../src/sources/tokens/transcript.js'
import { applyTokens, synthesizeFromTranscript } from '../src/sources/state.js'
import type { SessionSnapshot } from '../src/lib/types.js'

const NOW = 1_800_000_000_000 // 2027-01-something

function assistantRec(input: number, output: number, secondsAgo: number): string {
  const ts = new Date(NOW - secondsAgo * 1000).toISOString()
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { usage: { input_tokens: input, output_tokens: output } },
  })
}

describe('ClaudeTranscriptReader.parse', () => {
  const reader = new ClaudeTranscriptReader({ now: () => NOW })

  it('sums input + output tokens across assistant records', () => {
    const text = [
      assistantRec(100, 50, 120),
      assistantRec(200, 80, 90),
      assistantRec(50, 20, 30),
    ].join('\n')
    const snap = reader.parse('sess-1', text)
    expect(snap).not.toBeNull()
    expect(snap!.tokensIn).toBe(350)
    expect(snap!.tokensOut).toBe(150)
  })

  it('computes 60s rolling rate from output tokens inside the window', () => {
    // 120s ago and 90s ago are outside the 60s window. 30s and 10s are inside.
    // Inside the window OUTPUT only: 20 + 200 = 220 → 220/60 ≈ 4 tps
    const text = [
      assistantRec(100, 50, 120),
      assistantRec(200, 80, 90),
      assistantRec(50, 20, 30),
      assistantRec(100, 200, 10),
    ].join('\n')
    const snap = reader.parse('sess-1', text)
    expect(snap!.tokenRateLast60s).toBe(4)
  })

  it('skips non-assistant records', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: new Date(NOW - 30_000).toISOString() }),
      JSON.stringify({ type: 'system', timestamp: new Date(NOW - 20_000).toISOString() }),
      assistantRec(100, 50, 10),
    ].join('\n')
    const snap = reader.parse('sess-1', text)
    expect(snap!.tokensIn).toBe(100)
    expect(snap!.tokensOut).toBe(50)
  })

  it('returns null when no usage data is present', () => {
    const text = JSON.stringify({ type: 'user', message: { content: 'hi' } })
    const snap = reader.parse('sess-1', text)
    expect(snap).toBeNull()
  })

  it('handles invalid JSON lines gracefully', () => {
    const text = [
      '{not valid',
      assistantRec(100, 50, 10),
      'also broken',
    ].join('\n')
    const snap = reader.parse('sess-1', text)
    expect(snap!.tokensIn).toBe(100)
  })

  it('records the most recent assistant timestamp', () => {
    const text = [
      assistantRec(50, 20, 300),
      assistantRec(80, 40, 10),
    ].join('\n')
    const snap = reader.parse('sess-1', text)
    expect(snap!.lastAssistantAt).toBe(NOW - 10_000)
  })

  it('also accepts usage at the top level (legacy variant)', () => {
    const text = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - 10_000).toISOString(),
      usage: { input_tokens: 33, output_tokens: 11 },
    })
    const snap = reader.parse('sess-1', text)
    expect(snap!.tokensIn).toBe(33)
    expect(snap!.tokensOut).toBe(11)
  })
})

describe('ClaudeTranscriptReader.scan (integration)', () => {
  it('walks ~/.claude/projects/*/<id>.jsonl and returns per-session snapshots', async () => {
    const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-transcripts-'))
    const proj = path.join(projectsDir, '-Users-x-repo')
    await fs.mkdir(proj)
    await fs.writeFile(path.join(proj, 'sid-a.jsonl'), assistantRec(100, 50, 10))
    await fs.writeFile(path.join(proj, 'sid-b.jsonl'), assistantRec(200, 80, 30))

    const reader = new ClaudeTranscriptReader({ projectsDir, now: () => NOW })
    const out = await reader.scan()
    expect(out.size).toBe(2)
    expect(out.get('sid-a')?.tokensIn).toBe(100)
    expect(out.get('sid-b')?.tokensOut).toBe(80)
  })

  it('returns empty when projectsDir is missing', async () => {
    const reader = new ClaudeTranscriptReader({
      projectsDir: '/definitely/not/here/' + Math.random(),
      now: () => NOW,
    })
    const out = await reader.scan()
    expect(out.size).toBe(0)
  })
})

describe('applyTokens', () => {
  it('decorates a row with token fields without mutating the input', () => {
    const row: SessionSnapshot = {
      harness: 'claude',
      sessionId: 'sid',
      name: 'X',
      state: 'working',
      summary: '',
      lastTransitionAt: 0,
      processAlive: true,
      prUrl: '',
      prCheckStatus: '',
      cwd: '',
      rawStateString: '',
    }
    const out = applyTokens(row, {
      sessionId: 'sid',
      tokensIn: 1000,
      tokensOut: 500,
      tokenRateLast60s: 25,
      lastAssistantAt: NOW,
    })
    expect(out.tokensIn).toBe(1000)
    expect(out.tokenRateLast60s).toBe(25)
    expect(row.tokensIn).toBeUndefined() // input not mutated
  })
})

describe('synthesizeFromTranscript', () => {
  it('emits "working" when the last assistant message is within 30s', () => {
    const snap = synthesizeFromTranscript(
      'sid',
      { sessionId: 'sid', tokensIn: 100, tokensOut: 50, tokenRateLast60s: 5, lastAssistantAt: NOW - 10_000 },
      NOW,
    )
    expect(snap?.state).toBe('working')
    expect(snap?.processAlive).toBe(true)
  })

  it('emits "idle" within 5 min', () => {
    const snap = synthesizeFromTranscript(
      'sid',
      { sessionId: 'sid', tokensIn: 100, tokensOut: 50, tokenRateLast60s: 0, lastAssistantAt: NOW - 120_000 },
      NOW,
    )
    expect(snap?.state).toBe('idle')
  })

  it('emits "completed" past 5 min', () => {
    const snap = synthesizeFromTranscript(
      'sid',
      { sessionId: 'sid', tokensIn: 100, tokensOut: 50, tokenRateLast60s: 0, lastAssistantAt: NOW - 10 * 60 * 1000 },
      NOW,
    )
    expect(snap?.state).toBe('completed')
    expect(snap?.processAlive).toBe(false)
  })

  it('returns null when transcript has no assistant timestamp', () => {
    const snap = synthesizeFromTranscript(
      'sid',
      { sessionId: 'sid', tokensIn: 0, tokensOut: 0, tokenRateLast60s: 0, lastAssistantAt: 0 },
      NOW,
    )
    expect(snap).toBeNull()
  })
})
