import { describe, it, expect, vi } from 'vitest'
import { HarnessRegistry } from '../src/sources/adapter.js'
import type { Adapter } from '../src/sources/adapter.js'
import type { HarnessId, SessionSnapshot } from '../src/lib/types.js'

// A tiny adapter that lets a test drive emissions manually. Useful for
// asserting merge semantics without spinning up real polling.
class FakeAdapter implements Adapter {
  readonly displayName: string
  private listeners = new Set<(rows: SessionSnapshot[]) => void>()
  started = false
  stopped = false

  constructor(readonly id: HarnessId) {
    this.displayName = `fake:${id}`
  }

  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  onChange(fn: (rows: SessionSnapshot[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  // Test hook: emit rows.
  emit(rows: SessionSnapshot[]): void {
    for (const fn of this.listeners) fn(rows)
  }
}

function row(harness: HarnessId, sessionId: string, lastTransitionAt = 1000): SessionSnapshot {
  return {
    harness,
    sessionId,
    name: sessionId,
    state: 'working',
    summary: '',
    lastTransitionAt,
    processAlive: true,
    prUrl: '',
    prCheckStatus: '',
    cwd: '',
    rawStateString: '',
  }
}

describe('HarnessRegistry', () => {
  it('merges rows from multiple adapters', () => {
    const reg = new HarnessRegistry()
    const a = new FakeAdapter('claude')
    const b = new FakeAdapter('codex')
    reg.add(a)
    reg.add(b)

    const got: SessionSnapshot[][] = []
    reg.onChange((rows) => got.push(rows))

    a.emit([row('claude', 'q1', 100)])
    b.emit([row('codex', 'x1', 200)])

    expect(got).toHaveLength(2)
    // After the second emit, merged should contain both.
    expect(got[1]!.map((r) => `${r.harness}:${r.sessionId}`).sort()).toEqual(['claude:q1', 'codex:x1'])
  })

  it('replaces only the emitting adapter\'s slice', () => {
    const reg = new HarnessRegistry()
    const a = new FakeAdapter('claude')
    const b = new FakeAdapter('codex')
    reg.add(a)
    reg.add(b)

    let merged: SessionSnapshot[] = []
    reg.onChange((rows) => (merged = rows))

    a.emit([row('claude', 'q1'), row('claude', 'q2')])
    b.emit([row('codex', 'x1')])
    a.emit([row('claude', 'q3')]) // replaces claude slice; codex untouched

    expect(merged.map((r) => `${r.harness}:${r.sessionId}`).sort()).toEqual(['claude:q3', 'codex:x1'])
  })

  it('sorts merged rows by lastTransitionAt desc', () => {
    const reg = new HarnessRegistry()
    const a = new FakeAdapter('claude')
    const b = new FakeAdapter('codex')
    reg.add(a)
    reg.add(b)
    let merged: SessionSnapshot[] = []
    reg.onChange((rows) => (merged = rows))

    a.emit([row('claude', 'q1', 100)])
    b.emit([row('codex', 'x1', 300), row('codex', 'x2', 200)])

    expect(merged.map((r) => r.sessionId)).toEqual(['x1', 'x2', 'q1'])
  })

  it('fires once on subscribe if data already present', () => {
    const reg = new HarnessRegistry()
    const a = new FakeAdapter('claude')
    reg.add(a)
    a.emit([row('claude', 'q1')])

    const fn = vi.fn()
    reg.onChange(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0]![0]).toHaveLength(1)
  })

  it('start/stop propagates to every adapter', () => {
    const reg = new HarnessRegistry()
    const a = new FakeAdapter('claude')
    const b = new FakeAdapter('codex')
    reg.addAll([a, b])
    reg.start()
    expect(a.started).toBe(true)
    expect(b.started).toBe(true)
    reg.stop()
    expect(a.stopped).toBe(true)
    expect(b.stopped).toBe(true)
  })

  it('exposes registered harness ids in registration order', () => {
    const reg = new HarnessRegistry()
    reg.add(new FakeAdapter('claude'))
    reg.add(new FakeAdapter('codex'))
    reg.add(new FakeAdapter('hermes'))
    expect(reg.harnessIds).toEqual(['claude', 'codex', 'hermes'])
  })
})
