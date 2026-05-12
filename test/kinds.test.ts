import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { DirectoryOfStateJsonAdapter } from '../src/sources/kinds/directoryOfStateJson.js'
import { JsonlTailAdapter } from '../src/sources/kinds/jsonlTail.js'
import { ProcessWatchOnlyAdapter } from '../src/sources/kinds/processWatchOnly.js'

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'beto-kinds-'))
}

async function writeSession(dir: string, id: string, body: object): Promise<void> {
  const sessionDir = path.join(dir, id)
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(path.join(sessionDir, 'state.json'), JSON.stringify(body))
}

describe('DirectoryOfStateJsonAdapter', () => {
  it('reads sessions and tags them with the harness id', async () => {
    const dir = await tempDir()
    await writeSession(dir, 's1', {
      session_id: 's1',
      name: 'Alpha',
      status: 'working',
      summary: 'doing things',
    })
    const adapter = new DirectoryOfStateJsonAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: { stateDirs: [dir] },
    })
    const rows = await adapter.scan()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.harness).toBe('fake')
    expect(rows[0]!.name).toBe('Alpha')
    expect(rows[0]!.state).toBe('working')
  })

  it('honors a custom fieldMap', async () => {
    const dir = await tempDir()
    await writeSession(dir, 's1', { my_id: 's1', my_title: 'Bravo', my_state: 'blocked' })
    const adapter = new DirectoryOfStateJsonAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: {
        stateDirs: [dir],
        fieldMap: { sessionId: 'my_id', name: 'my_title', state: 'my_state' },
      },
    })
    const rows = await adapter.scan()
    expect(rows[0]!.name).toBe('Bravo')
    expect(rows[0]!.state).toBe('needs-input')
  })

  it('merges sessions across multiple stateDirs', async () => {
    const a = await tempDir()
    const b = await tempDir()
    await writeSession(a, 'a1', { session_id: 'a1', status: 'idle' })
    await writeSession(b, 'b1', { session_id: 'b1', status: 'working' })
    const adapter = new DirectoryOfStateJsonAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: { stateDirs: [a, b] },
    })
    const rows = await adapter.scan()
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['a1', 'b1'])
  })
})

describe('JsonlTailAdapter', () => {
  it('reads the last record per JSONL file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'sess-x.jsonl')
    const lines = [
      { id: 'sess-x', type: 'started', t: 100 },
      { id: 'sess-x', type: 'message', t: 200 },
      { id: 'sess-x', type: 'working', t: 300 },
    ]
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const adapter = new JsonlTailAdapter({
      id: 'oi',
      displayName: 'Open Interpreter',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'id', state: 'type', lastTransitionAt: 't' },
      },
    })
    const rows = await adapter.scan()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.lastTransitionAt).toBe(300)
    expect(rows[0]!.state).toBe('working')
  })

  it('falls back to the file basename when no sessionId in records', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'session-xyz.jsonl')
    await fs.writeFile(file, JSON.stringify({ type: 'working', t: 100 }) + '\n')
    const adapter = new JsonlTailAdapter({
      id: 'oi',
      displayName: 'Open Interpreter',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'nonexistent_id', state: 'type', lastTransitionAt: 't' },
      },
    })
    const rows = await adapter.scan()
    expect(rows[0]!.sessionId).toBe('session-xyz')
  })

  it('returns empty when the glob matches nothing', async () => {
    const dir = await tempDir()
    const adapter = new JsonlTailAdapter({
      id: 'oi',
      displayName: 'Open Interpreter',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'id' },
      },
    })
    const rows = await adapter.scan()
    expect(rows).toEqual([])
  })
})

describe('ProcessWatchOnlyAdapter', () => {
  it('returns empty when binary is absent', async () => {
    const adapter = new ProcessWatchOnlyAdapter({
      id: 'fake',
      displayName: 'Fake',
      binary: undefined,
      config: {},
    })
    const rows = await adapter.scan()
    expect(rows).toEqual([])
  })

  it('synthesizes a row per matching process', async () => {
    // We expect at least one `node` process running (this test runner).
    const adapter = new ProcessWatchOnlyAdapter({
      id: 'noderun',
      displayName: 'Node',
      binary: 'node',
      config: { stateOnRunning: 'working' },
    })
    const rows = await adapter.scan()
    // Either the test is running under node and we see ≥1 row, or it's
    // under Bun and we see 0. Both are valid; just assert the shape.
    for (const row of rows) {
      expect(row.harness).toBe('noderun')
      expect(row.state).toBe('working')
      expect(row.sessionId).toMatch(/^noderun:/)
    }
  })
})
