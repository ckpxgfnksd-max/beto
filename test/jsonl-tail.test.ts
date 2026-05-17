import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { JsonlTailAdapter } from '../src/sources/kinds/jsonlTail.js'
import { loadPlugins } from '../src/lib/plugins.js'

async function tempDir(prefix = 'beto-jsonl-tail-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFileWithMtime(p: string, body: string, mtimeMs: number): Promise<void> {
  await fs.writeFile(p, body)
  const t = new Date(mtimeMs)
  await fs.utimes(p, t, t)
}

describe('JsonlTailAdapter — Codex rollout shape', () => {
  it('reads sessionId + cwd + name from head record (dotted paths)', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'rollout-2026-05-17T10-29-50-019e350e-4f09-71e3-b0ea-c48f4903cb50.jsonl')
    const lines = [
      // session_meta — head record carries the static metadata.
      {
        timestamp: '2026-05-17T08:29:50.000Z',
        type: 'session_meta',
        payload: {
          id: '019e350e-4f09-71e3-b0ea-c48f4903cb50',
          cwd: '/Users/foo/Projects/widget',
          originator: 'Codex Desktop',
          thread_source: 'user',
        },
      },
      // event_msg — tail record only has timestamp.
      { timestamp: '2026-05-17T08:30:12.500Z', type: 'event_msg', payload: { type: 'task_started' } },
    ]
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const adapter = new JsonlTailAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'payload.id', lastTransitionAt: 'timestamp' },
        headFieldMap: {
          sessionId: 'payload.id',
          cwd: 'payload.cwd',
          name: 'payload.originator',
        },
      },
    })
    const rows = await adapter.scan()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('019e350e-4f09-71e3-b0ea-c48f4903cb50')
    expect(rows[0]!.cwd).toBe('/Users/foo/Projects/widget')
    expect(rows[0]!.name).toBe('Codex Desktop')
    expect(rows[0]!.lastTransitionAt).toBe(Date.parse('2026-05-17T08:30:12.500Z'))
  })

  it('excludes files whose head record matches the exclude predicate', async () => {
    const dir = await tempDir()
    const guardian = path.join(dir, 'rollout-2026-05-17T10-33-23-019e3511-8ea7-7cb3-9ae1-a4426936d3ed.jsonl')
    const user = path.join(dir, 'rollout-2026-05-17T10-29-50-019e350e-4f09-71e3-b0ea-c48f4903cb50.jsonl')

    await fs.writeFile(
      guardian,
      JSON.stringify({
        timestamp: '2026-05-17T08:33:23Z',
        type: 'session_meta',
        payload: { id: 'guard-1', thread_source: 'subagent' },
      }) + '\n' +
        JSON.stringify({ timestamp: '2026-05-17T08:33:50Z', type: 'event_msg', payload: {} }),
    )
    await fs.writeFile(
      user,
      JSON.stringify({
        timestamp: '2026-05-17T08:29:50Z',
        type: 'session_meta',
        payload: { id: 'user-1', thread_source: 'user', cwd: '/x' },
      }) + '\n' +
        JSON.stringify({ timestamp: '2026-05-17T08:30:00Z', type: 'event_msg', payload: {} }),
    )

    const adapter = new JsonlTailAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'payload.id', lastTransitionAt: 'timestamp' },
        headFieldMap: { sessionId: 'payload.id' },
        exclude: { field: 'payload.thread_source', equals: 'subagent' },
      },
    })
    const rows = await adapter.scan()
    expect(rows.map((r) => r.sessionId)).toEqual(['user-1'])
  })

  it('infers state from age when no state field is mapped', async () => {
    const dir = await tempDir()
    const NOW = 1_800_000_000_000

    const fresh = path.join(dir, 'rollout-fresh-019e0001-0000-0000-0000-000000000001.jsonl')
    const recent = path.join(dir, 'rollout-recent-019e0002-0000-0000-0000-000000000002.jsonl')
    const old = path.join(dir, 'rollout-old-019e0003-0000-0000-0000-000000000003.jsonl')

    await writeFileWithMtime(
      fresh,
      JSON.stringify({ timestamp: new Date(NOW - 10_000).toISOString(), payload: { id: 'a' } }),
      NOW - 10_000,
    )
    await writeFileWithMtime(
      recent,
      JSON.stringify({ timestamp: new Date(NOW - 120_000).toISOString(), payload: { id: 'b' } }),
      NOW - 120_000,
    )
    await writeFileWithMtime(
      old,
      JSON.stringify({ timestamp: new Date(NOW - 3_600_000).toISOString(), payload: { id: 'c' } }),
      NOW - 3_600_000,
    )

    const adapter = new JsonlTailAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'payload.id', lastTransitionAt: 'timestamp' },
      },
      now: () => NOW,
    })
    const rows = await adapter.scan()
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))
    expect(byId['a']!.state).toBe('working')
    expect(byId['b']!.state).toBe('idle')
    expect(byId['c']!.state).toBe('completed')
  })

  it('flips processAlive false for completed rows, true for working/idle', async () => {
    const dir = await tempDir()
    const NOW = 1_800_000_000_000
    const old = path.join(dir, 'rollout-old-019e0003-0000-0000-0000-000000000003.jsonl')
    const fresh = path.join(dir, 'rollout-fresh-019e0001-0000-0000-0000-000000000001.jsonl')
    await writeFileWithMtime(
      old,
      JSON.stringify({ timestamp: new Date(NOW - 3_600_000).toISOString(), payload: { id: 'c' } }),
      NOW - 3_600_000,
    )
    await writeFileWithMtime(
      fresh,
      JSON.stringify({ timestamp: new Date(NOW - 10_000).toISOString(), payload: { id: 'a' } }),
      NOW - 10_000,
    )

    const adapter = new JsonlTailAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'payload.id', lastTransitionAt: 'timestamp' },
      },
      now: () => NOW,
    })
    const rows = await adapter.scan()
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))
    expect(byId['a']!.processAlive).toBe(true)
    expect(byId['c']!.processAlive).toBe(false)
  })

  it('extracts UUID from rollout filename when sessionId is unresolved', async () => {
    const dir = await tempDir()
    const file = path.join(
      dir,
      'rollout-2026-05-17T10-29-50-019e350e-4f09-71e3-b0ea-c48f4903cb50.jsonl',
    )
    await fs.writeFile(file, JSON.stringify({ timestamp: '2026-05-17T08:30:00Z', payload: {} }))

    const adapter = new JsonlTailAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        // No `payload.id` in this record + headFieldMap absent → fallback chain.
        fieldMap: { sessionId: 'payload.id' },
      },
    })
    const rows = await adapter.scan()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('019e350e-4f09-71e3-b0ea-c48f4903cb50')
  })

  it('walks ** recursively to find rollouts nested by date', async () => {
    const dir = await tempDir()
    const nested = path.join(dir, '2026', '05', '17')
    await fs.mkdir(nested, { recursive: true })
    const file = path.join(nested, 'rollout-019e0001-0000-0000-0000-000000000001.jsonl')
    await fs.writeFile(
      file,
      JSON.stringify({ timestamp: '2026-05-17T08:00:00Z', payload: { id: 'nested' } }),
    )

    const adapter = new JsonlTailAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        fileGlob: path.join(dir, '**', 'rollout-*.jsonl'),
        fieldMap: { sessionId: 'payload.id' },
      },
    })
    const rows = await adapter.scan()
    expect(rows.map((r) => r.sessionId)).toEqual(['nested'])
  })

  it('drops files with no parseable lines but never throws', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'a.jsonl'), 'not json\n{also broken\n')
    const adapter = new JsonlTailAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'id' },
      },
    })
    const rows = await adapter.scan()
    expect(rows).toEqual([])
  })
})

describe('codex.json (integration with bundled manifest)', () => {
  it('produces a JsonlTail adapter over rollout-*.jsonl when fixture exists', async () => {
    const dir = await tempDir('beto-codex-int-')
    // Mock the rollout layout.
    const sessionDir = path.join(dir, 'sessions', '2026', '05', '17')
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, 'rollout-2026-05-17T10-29-50-019e350e-4f09-71e3-b0ea-c48f4903cb50.jsonl'),
      JSON.stringify({
        timestamp: '2026-05-17T08:29:50Z',
        type: 'session_meta',
        payload: {
          id: '019e350e-4f09-71e3-b0ea-c48f4903cb50',
          cwd: '/Users/foo/proj',
          originator: 'Codex Desktop',
          thread_source: 'user',
        },
      }) + '\n' +
        JSON.stringify({ timestamp: '2026-05-17T08:30:00Z', payload: {} }) + '\n',
    )

    // We can't easily redirect ~ → dir without env juggling, so instead
    // verify the bundled manifest validates and the loader instantiates it.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-home-'))
    const repoManifests = path.resolve(__dirname, '..', 'manifests')
    const result = await loadPlugins({ home, extraDirs: [repoManifests] })
    const codex = result.loaded.find((p) => p.manifest.id === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.manifest.adapter.kind).toBe('jsonl-tail')
    expect(result.failures).toEqual([])
  })
})
