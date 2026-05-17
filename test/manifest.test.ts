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

  // ── stateInference ─────────────────────────────────────────────────

  it('accepts jsonl-tail with stateInference rules (Codex shape)', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.codex/sessions/**/rollout-*.jsonl',
            fieldMap: { sessionId: 'payload.id', lastTransitionAt: 'timestamp' },
            stateInference: [
              {
                name: 'task complete → user turn',
                mapsTo: 'needs-input',
                when: {
                  equals: { type: 'event_msg', 'payload.type': 'task_complete' },
                  against: 'tail',
                },
              },
              {
                mapsTo: 'stopped',
                when: { equals: { 'payload.type': 'turn_aborted' } },
              },
            ],
          },
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.manifest?.adapter.kind).toBe('jsonl-tail')
    if (r.manifest?.adapter.kind === 'jsonl-tail') {
      expect(r.manifest.adapter.config.stateInference).toHaveLength(2)
      expect(r.manifest.adapter.config.stateInference?.[0]?.mapsTo).toBe('needs-input')
    }
  })

  it('rejects stateInference rule with unknown mapsTo', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.foo/*.jsonl',
            fieldMap: { sessionId: 'id' },
            stateInference: [{ mapsTo: 'made-up', when: { equals: { t: 'x' } } }],
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path.endsWith('mapsTo'))).toBe(true)
  })

  it('rejects stateInference rule without when block', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.foo/*.jsonl',
            fieldMap: { sessionId: 'id' },
            stateInference: [{ mapsTo: 'needs-input' }],
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path.endsWith('.when'))).toBe(true)
  })

  it('rejects stateInference rule with non-string equals value', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'jsonl-tail',
          config: {
            fileGlob: '~/.foo/*.jsonl',
            fieldMap: { sessionId: 'id' },
            stateInference: [
              { mapsTo: 'needs-input', when: { equals: { 'payload.type': 42 } } },
            ],
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path.includes('equals'))).toBe(true)
  })

  // ── joinLatest (sqlite) ────────────────────────────────────────────

  it('accepts sqlite-sessions-table with joinLatest + stateInference (OpenCode shape)', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'sqlite-sessions-table',
          config: {
            dbPath: '~/.local/share/opencode/opencode.db',
            table: 'session',
            fieldMap: { sessionId: 'id', name: 'title', lastTransitionAt: 'time_updated' },
            joinLatest: {
              as: 'latestMessage',
              sql:
                "SELECT type, session_id, json_extract(data,'$.time.completed') AS completed_at " +
                'FROM session_message WHERE session_id IN (:sessionIds) ' +
                'GROUP BY session_id ORDER BY time_created DESC',
            },
            stateInference: [
              {
                mapsTo: 'needs-input',
                when: {
                  equals: { 'latestMessage.type': 'assistant' },
                  present: ['latestMessage.completed_at'],
                },
              },
            ],
          },
        },
      }),
    )
    expect(r.ok).toBe(true)
    if (r.manifest?.adapter.kind === 'sqlite-sessions-table') {
      expect(r.manifest.adapter.config.joinLatest?.as).toBe('latestMessage')
      expect(r.manifest.adapter.config.stateInference).toHaveLength(1)
    }
  })

  it('rejects joinLatest without :sessionIds placeholder', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'sqlite-sessions-table',
          config: {
            dbPath: '~/.x.db',
            table: 'session',
            fieldMap: { sessionId: 'id' },
            joinLatest: {
              as: 'latestMessage',
              sql: 'SELECT * FROM session_message',
            },
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes(':sessionIds'))).toBe(true)
  })

  it('rejects joinLatest with embedded semicolon (multi-statement attempt)', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'sqlite-sessions-table',
          config: {
            dbPath: '~/.x.db',
            table: 'session',
            fieldMap: { sessionId: 'id' },
            joinLatest: {
              as: 'latestMessage',
              sql:
                'SELECT * FROM session_message WHERE session_id IN (:sessionIds); DROP TABLE session',
            },
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes('single statement'))).toBe(true)
  })

  it('rejects joinLatest that is not a SELECT', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'sqlite-sessions-table',
          config: {
            dbPath: '~/.x.db',
            table: 'session',
            fieldMap: { sessionId: 'id' },
            joinLatest: {
              as: 'latestMessage',
              sql: 'DELETE FROM session_message WHERE session_id IN (:sessionIds)',
            },
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes('SELECT'))).toBe(true)
  })

  it('rejects joinLatest with bad `as` identifier', () => {
    const r = validateManifest(
      valid({
        adapter: {
          kind: 'sqlite-sessions-table',
          config: {
            dbPath: '~/.x.db',
            table: 'session',
            fieldMap: { sessionId: 'id' },
            joinLatest: {
              as: 'Bad Name!',
              sql: 'SELECT * FROM session_message WHERE session_id IN (:sessionIds)',
            },
          },
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path.endsWith('.as'))).toBe(true)
  })
})
