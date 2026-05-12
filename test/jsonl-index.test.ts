import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { JsonlIndexAdapter } from '../src/sources/kinds/jsonlIndex.js'
import { loadPlugins } from '../src/lib/plugins.js'

// The fixture is a verbatim snapshot of `~/.codex/session_index.jsonl`
// captured 2026-05-12. 16 sessions; ISO-string `updated_at`. Regression
// tests guard against the field map drifting away from the real schema.
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/codex/session_index.jsonl')

describe('JsonlIndexAdapter (Codex shape)', () => {
  it('reads all sessions from the fixture', async () => {
    const adapter = new JsonlIndexAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        filePath: FIXTURE_PATH,
        fieldMap: {
          sessionId: 'id',
          name: 'thread_name',
          lastTransitionAt: 'updated_at',
        },
      },
    })
    const rows = await adapter.scan()
    // Match the fixture: 16 lines, 16 sessions.
    expect(rows).toHaveLength(16)
    expect(rows[0]!.harness).toBe('codex')
  })

  it('parses ISO-8601 timestamps from updated_at', async () => {
    const adapter = new JsonlIndexAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        filePath: FIXTURE_PATH,
        fieldMap: { sessionId: 'id', name: 'thread_name', lastTransitionAt: 'updated_at' },
      },
    })
    const rows = await adapter.scan()
    // The fixture has timestamps in 2026; spot-check a known one.
    const first = rows.find((r) => r.sessionId === '019dd8f4-6b9b-7911-8a13-f96c5a8693d8')
    expect(first).toBeDefined()
    expect(first!.lastTransitionAt).toBe(Date.parse('2026-04-29T11:16:37.130813Z'))
    expect(first!.name).toBe('Inspect gpt-image2-ecommerce')
  })

  it('sorts most-recently-updated first', async () => {
    const adapter = new JsonlIndexAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        filePath: FIXTURE_PATH,
        fieldMap: { sessionId: 'id', name: 'thread_name', lastTransitionAt: 'updated_at' },
      },
    })
    const rows = await adapter.scan()
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.lastTransitionAt).toBeGreaterThanOrEqual(
        rows[i]!.lastTransitionAt,
      )
    }
  })

  it('returns empty when the file is absent', async () => {
    const adapter = new JsonlIndexAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        filePath: '/definitely/not/a/file/' + Math.random(),
        fieldMap: { sessionId: 'id' },
      },
    })
    const rows = await adapter.scan()
    expect(rows).toEqual([])
  })

  it('infers state from age when no state field is mapped (working/idle/completed)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-jsonl-idx-state-'))
    const file = path.join(dir, 'index.jsonl')
    const NOW = 1_700_000_000_000
    await fs.writeFile(
      file,
      [
        // 10s ago → working
        JSON.stringify({ id: 'fresh', updated_at: new Date(NOW - 10_000).toISOString() }),
        // 2 min ago → idle
        JSON.stringify({ id: 'recent', updated_at: new Date(NOW - 120_000).toISOString() }),
        // 1 hour ago → completed
        JSON.stringify({ id: 'old', updated_at: new Date(NOW - 3600_000).toISOString() }),
      ].join('\n'),
    )
    const adapter = new JsonlIndexAdapter({
      id: 'codex',
      displayName: 'Codex',
      config: {
        filePath: file,
        fieldMap: { sessionId: 'id', lastTransitionAt: 'updated_at' },
      },
      now: () => NOW,
    })
    const rows = await adapter.scan()
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))
    expect(byId['fresh']!.state).toBe('working')
    expect(byId['recent']!.state).toBe('idle')
    expect(byId['old']!.state).toBe('completed')
  })

  it('honors an explicit state field when mapped', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-jsonl-idx-state-'))
    const file = path.join(dir, 'index.jsonl')
    await fs.writeFile(
      file,
      JSON.stringify({ id: 'a', status: 'failed', updated_at: '2026-01-01T00:00:00Z' }),
    )
    const adapter = new JsonlIndexAdapter({
      id: 'foo',
      displayName: 'Foo',
      config: {
        filePath: file,
        fieldMap: { sessionId: 'id', state: 'status', lastTransitionAt: 'updated_at' },
      },
    })
    const rows = await adapter.scan()
    expect(rows[0]!.state).toBe('failed')
  })

  it('survives malformed lines without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-jsonl-idx-'))
    const file = path.join(dir, 'index.jsonl')
    await fs.writeFile(
      file,
      [
        '{not valid',
        JSON.stringify({ id: 'ok-1', thread_name: 'Real session' }),
        '',
        '{partially: "borked"',
        JSON.stringify({ id: 'ok-2', thread_name: 'Another real one' }),
      ].join('\n'),
    )
    const adapter = new JsonlIndexAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: { filePath: file, fieldMap: { sessionId: 'id', name: 'thread_name' } },
    })
    const rows = await adapter.scan()
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['ok-1', 'ok-2'])
  })
})

describe('codex.json (verified manifest)', () => {
  it('loads via the plugin loader and produces a working adapter', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-home-'))
    const repoManifests = path.resolve(__dirname, '..', 'manifests')
    const result = await loadPlugins({ home, extraDirs: [repoManifests] })
    const codex = result.loaded.find((p) => p.manifest.id === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.manifest.adapter.kind).toBe('jsonl-index')
    expect(result.failures).toEqual([])
  })

  it('does NOT load experimental manifests by default', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-home-'))
    const repoManifests = path.resolve(__dirname, '..', 'manifests')
    const result = await loadPlugins({ home, extraDirs: [repoManifests] })
    const ids = result.loaded.map((p) => p.manifest.id)
    expect(ids).not.toContain('hermes')
    expect(ids).not.toContain('goose')
    expect(ids).not.toContain('aider')
    expect(ids).not.toContain('open-interpreter')
  })
})
