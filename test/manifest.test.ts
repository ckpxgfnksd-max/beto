import { describe, it, expect } from 'vitest'
import { validateManifest } from '../src/lib/manifest.js'

describe('validateManifest', () => {
  function valid(over: Record<string, unknown> = {}): unknown {
    return {
      id: 'fakeharness',
      displayName: 'Fake Harness',
      binary: 'fakeharness',
      adapter: {
        kind: 'directory-of-state-json',
        config: {
          stateDirs: ['~/.fakeharness/sessions'],
        },
      },
      ...over,
    }
  }

  it('accepts a minimal valid manifest', () => {
    const res = validateManifest(valid())
    expect(res.ok).toBe(true)
    expect(res.manifest?.id).toBe('fakeharness')
  })

  it('rejects non-object input', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('hello').ok).toBe(false)
    expect(validateManifest([]).ok).toBe(false)
  })

  it('rejects bad id slugs', () => {
    const r = validateManifest({ ...(valid() as object), id: 'Bad-Name' })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.path).toBe('id')
  })

  it('rejects unknown adapter kind', () => {
    const r = validateManifest(valid({ adapter: { kind: 'made-up', config: {} } }))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path === 'adapter.kind')).toBe(true)
  })

  it('rejects sqlite-sessions-table without fieldMap.sessionId', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'sqlite-sessions-table',
          config: { dbPath: '~/.x/db', table: 'sessions', fieldMap: {} },
        },
      }),
    )
    expect(r.ok).toBe(false)
  })

  it('accepts a valid jsonl-tail manifest', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.foo/*.jsonl',
            fieldMap: { sessionId: 'id' },
            tailLines: 20,
          },
        },
      }),
    )
    expect(r.ok).toBe(true)
  })

  it('accepts jsonl-tail with headFieldMap and exclude (Codex shape)', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.codex/sessions/**/rollout-*.jsonl',
            fieldMap: { sessionId: 'payload.id', lastTransitionAt: 'timestamp' },
            headFieldMap: {
              sessionId: 'payload.id',
              cwd: 'payload.cwd',
              name: 'payload.originator',
            },
            exclude: { field: 'payload.thread_source', equals: 'subagent' },
          },
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.manifest?.adapter.kind).toBe('jsonl-tail')
  })

  it('rejects jsonl-tail exclude missing required fields', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.foo/*.jsonl',
            fieldMap: { sessionId: 'id' },
            exclude: { field: 'thread_source' },
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path.includes('exclude.equals'))).toBe(true)
  })

  it('accepts a valid jsonl-index manifest', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-index',
          config: {
            filePath: '~/.codex/session_index.jsonl',
            fieldMap: {
              sessionId: 'id',
              name: 'thread_name',
              lastTransitionAt: 'updated_at',
            },
          },
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.manifest?.adapter.kind).toBe('jsonl-index')
  })

  it('rejects jsonl-index manifest with no filePath', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-index',
          config: { fieldMap: { sessionId: 'id' } },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path.includes('filePath'))).toBe(true)
  })

  it('accepts process-watch-only with no config keys', () => {
    const r = validateManifest(
      valid({ adapter: { kind: 'process-watch-only', config: {} } }),
    )
    expect(r.ok).toBe(true)
  })

  it('rejects pollMs out of range', () => {
    const r = validateManifest(valid({ pollMs: 5 }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.path).toBe('pollMs')
  })

  it('preserves optional fields when set', () => {
    const r = validateManifest(
      valid({ sigil: 'F', color: 'magenta', versionFlag: '-V' }),
    )
    expect(r.manifest?.sigil).toBe('F')
    expect(r.manifest?.color).toBe('magenta')
    expect(r.manifest?.versionFlag).toBe('-V')
  })
})
