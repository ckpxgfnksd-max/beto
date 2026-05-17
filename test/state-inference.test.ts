import { describe, it, expect } from 'vitest'
import { applyStateInference } from '../src/sources/stateInference.js'
import type { StateInferenceRule } from '../src/lib/manifest.js'

describe('applyStateInference', () => {
  it('returns null when no rules are supplied', () => {
    expect(applyStateInference(undefined, {})).toBeNull()
    expect(applyStateInference([], {})).toBeNull()
  })

  it('returns null when no rule matches', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'needs-input', when: { equals: { 'payload.type': 'task_complete' } } },
    ]
    expect(
      applyStateInference(rules, { tail: { payload: { type: 'task_started' } } }, {
        defaultScope: 'tail',
      }),
    ).toBeNull()
  })

  it('matches a single equals predicate (Codex task_complete shape)', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'needs-input',
        when: { equals: { type: 'event_msg', 'payload.type': 'task_complete' } },
      },
    ]
    const tail = { type: 'event_msg', payload: { type: 'task_complete', completed_at: 'x' } }
    expect(applyStateInference(rules, { tail }, { defaultScope: 'tail' })).toBe('needs-input')
  })

  it('AND-combines multiple equals keys (one failure breaks the match)', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'needs-input',
        when: { equals: { type: 'event_msg', 'payload.type': 'task_complete' } },
      },
    ]
    const tail = { type: 'event_msg', payload: { type: 'turn_aborted' } }
    expect(applyStateInference(rules, { tail }, { defaultScope: 'tail' })).toBeNull()
  })

  it('uses first-matching-rule-wins ordering', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'failed', when: { equals: { 'payload.type': 'task_complete' } } },
      { mapsTo: 'needs-input', when: { equals: { 'payload.type': 'task_complete' } } },
    ]
    const tail = { payload: { type: 'task_complete' } }
    expect(applyStateInference(rules, { tail }, { defaultScope: 'tail' })).toBe('failed')
  })

  it('matches `present` predicate (assistant with completed timestamp)', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'needs-input',
        when: {
          equals: { 'latestMessage.type': 'assistant' },
          present: ['latestMessage.completed_at'],
        },
      },
    ]
    const latestMessage = { type: 'assistant', completed_at: '2026-05-17T10:00:00Z' }
    expect(
      applyStateInference(rules, { session: {}, latestMessage }),
    ).toBe('needs-input')
  })

  it('rejects `present` when the path is empty / null', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'needs-input',
        when: {
          equals: { 'latestMessage.type': 'assistant' },
          present: ['latestMessage.completed_at'],
        },
      },
    ]
    const latestMessage = { type: 'assistant', completed_at: null }
    expect(
      applyStateInference(rules, { session: {}, latestMessage }),
    ).toBeNull()
  })

  it('matches `absent` predicate (assistant streaming = no error)', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'working',
        when: {
          equals: { 'latestMessage.type': 'assistant' },
          absent: ['latestMessage.completed_at'],
        },
      },
    ]
    const latestMessage = { type: 'assistant', completed_at: null }
    expect(applyStateInference(rules, { latestMessage })).toBe('working')
  })

  it('matches minAgeMs when lastTransitionAt is old enough', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'idle', when: { minAgeMs: 300_000 } },
    ]
    const now = 1_000_000
    expect(
      applyStateInference(rules, { tail: {} }, { now, lastTransitionAt: now - 600_000 }),
    ).toBe('idle')
  })

  it('rejects minAgeMs when too fresh', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'idle', when: { minAgeMs: 300_000 } },
    ]
    const now = 1_000_000
    expect(
      applyStateInference(rules, { tail: {} }, { now, lastTransitionAt: now - 1000 }),
    ).toBeNull()
  })

  it('treats missing lastTransitionAt as infinitely old', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'idle', when: { minAgeMs: 300_000 } },
    ]
    // No lastTransitionAt → infinite age → minAgeMs always satisfied.
    expect(applyStateInference(rules, { tail: {} }, { now: 100 })).toBe('idle')
  })

  it("honors against:'head' so head-scoped predicates resolve against the head record", () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'stopped',
        when: { equals: { 'payload.source': 'reaper' }, against: 'head' },
      },
    ]
    const head = { payload: { source: 'reaper' } }
    const tail = { payload: { source: 'agent' } }
    expect(applyStateInference(rules, { head, tail })).toBe('stopped')
  })

  it('resolves explicit scope prefixes regardless of defaultScope', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'failed',
        when: { equals: { 'session.error_kind': 'oom' } },
      },
    ]
    const session = { error_kind: 'oom' }
    expect(
      applyStateInference(rules, { session, latestMessage: { type: 'assistant' } }, {
        defaultScope: 'latestMessage',
      }),
    ).toBe('failed')
  })

  it('combines equals + present + minAgeMs in one rule', () => {
    const rules: StateInferenceRule[] = [
      {
        mapsTo: 'needs-input',
        when: {
          equals: { 'payload.type': 'task_complete' },
          present: ['payload.id'],
          minAgeMs: 1000,
        },
      },
    ]
    const now = 10_000
    const tail = { payload: { type: 'task_complete', id: 'abc' } }
    expect(
      applyStateInference(rules, { tail }, {
        defaultScope: 'tail',
        now,
        lastTransitionAt: now - 5000,
      }),
    ).toBe('needs-input')
  })

  it('handles numeric values in equals via String() coercion', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'failed', when: { equals: { 'session.exit_code': '1' } } },
    ]
    const session = { exit_code: 1 }
    expect(applyStateInference(rules, { session }, { defaultScope: 'session' })).toBe('failed')
  })

  it('treats explicit-scope path with no rest as the whole record', () => {
    const rules: StateInferenceRule[] = [
      { mapsTo: 'completed', when: { absent: ['session'] } },
    ]
    // Empty session → absent → matches.
    expect(applyStateInference(rules, { session: undefined })).toBe('completed')
  })
})
