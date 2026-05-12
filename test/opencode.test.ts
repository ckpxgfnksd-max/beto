import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SqliteSessionsTableAdapter } from '../src/sources/kinds/sqliteSessionsTable.js'
import { loadPlugins } from '../src/lib/plugins.js'

// Fixture: a real opencode.db produced by `opencode --version` (which
// runs the one-time sqlx migrations), with one synthetic row inserted
// via SQL so the adapter's read path is exercised. Schema confirmed
// against opencode-ai v1.14.48 on 2026-05-12.
const FIXTURE_DB = path.resolve(__dirname, 'fixtures/opencode/opencode.db')

describe('opencode.json (verified manifest)', () => {
  it('loads via the plugin loader', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-home-'))
    const repoManifests = path.resolve(__dirname, '..', 'manifests')
    const result = await loadPlugins({ home, extraDirs: [repoManifests] })
    const opencode = result.loaded.find((p) => p.manifest.id === 'opencode')
    expect(opencode).toBeDefined()
    expect(opencode!.manifest.adapter.kind).toBe('sqlite-sessions-table')
    expect(result.failures).toEqual([])
  })
})

describe('SqliteSessionsTableAdapter against OpenCode fixture', () => {
  // Skip if the sqlite3 CLI isn't on the runner. The adapter shells out
  // to it; without it, this test can't run. CI runners (Ubuntu) have
  // sqlite3 by default; macOS does too.
  it('reads sessions from the OpenCode fixture db', async () => {
    const adapter = new SqliteSessionsTableAdapter({
      id: 'opencode',
      displayName: 'OpenCode',
      config: {
        dbPath: FIXTURE_DB,
        table: 'session',
        fieldMap: {
          sessionId: 'id',
          name: 'title',
          lastTransitionAt: 'time_updated',
          cwd: 'directory',
        },
        where: 'time_archived IS NULL',
        limit: 100,
      },
    })
    const rows = await adapter.scan()
    // Fixture has at least one row (the synthetic insert).
    expect(rows.length).toBeGreaterThan(0)
    const seeded = rows.find((r) => r.sessionId === 'sess-test-1')
    expect(seeded).toBeDefined()
    expect(seeded!.harness).toBe('opencode')
    expect(seeded!.name).toBe('Build OpenCode adapter for beto')
    expect(seeded!.cwd).toBe('/tmp/test-proj')
    // time_updated is epoch ms — adapter normalizes to number directly.
    expect(seeded!.lastTransitionAt).toBeGreaterThan(1_700_000_000_000)
  })
})
