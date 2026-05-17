import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import { SqliteSessionsTableAdapter } from '../src/sources/kinds/sqliteSessionsTable.js'
import { loadPlugins } from '../src/lib/plugins.js'

// Fixture: a real opencode.db produced by `opencode --version` (which
// runs the one-time sqlx migrations), with one synthetic row inserted
// via SQL so the adapter's read path is exercised. Schema confirmed
// against opencode-ai v1.14.48 on 2026-05-12.
const FIXTURE_DB = path.resolve(__dirname, 'fixtures/opencode/opencode.db')

// Copy the read-only fixture into a tempdir and apply a custom SQL
// script. Returns the path to the writable copy. Lets state-inference
// tests insert message rows without mutating the shared fixture.
async function cloneFixtureWith(sql: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-oc-'))
  const dst = path.join(dir, 'opencode.db')
  await fs.copyFile(FIXTURE_DB, dst)
  const res = spawnSync('sqlite3', [dst], { input: sql, encoding: 'utf-8' })
  if (res.status !== 0) {
    throw new Error(`sqlite3 setup failed: ${res.stderr}`)
  }
  return dst
}

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

  it('infers needs-input / working / failed via joinLatest + stateInference', async () => {
    // Build four scenarios as separate sessions, each with the
    // appropriate trailing message data.
    const db = await cloneFixtureWith(`
      INSERT INTO session(id, project_id, slug, directory, title, version,
                          time_created, time_updated)
      VALUES
        ('sess-needs', 'proj-1', 's', '/tmp/p', 'Assistant done',     '1', 1, 100),
        ('sess-work',  'proj-1', 's', '/tmp/p', 'Assistant streaming','1', 1, 100),
        ('sess-fail',  'proj-1', 'f', '/tmp/p', 'Assistant errored',  '1', 1, 100),
        ('sess-user',  'proj-1', 'u', '/tmp/p', 'User prompt latest', '1', 1, 100);

      INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES
        ('m-needs-a', 'sess-needs', 50, 50,
         '{"role":"user","time":{"created":50}}'),
        ('m-needs-b', 'sess-needs', 60, 60,
         '{"role":"assistant","time":{"created":55,"completed":60}}'),

        ('m-work-a', 'sess-work', 50, 50,
         '{"role":"user","time":{"created":50}}'),
        ('m-work-b', 'sess-work', 60, 60,
         '{"role":"assistant","time":{"created":55}}'),

        ('m-fail-a', 'sess-fail', 50, 50,
         '{"role":"user","time":{"created":50}}'),
        ('m-fail-b', 'sess-fail', 60, 60,
         '{"role":"assistant","time":{"created":55,"completed":60},"error":{"name":"ModelTimeout"}}'),

        ('m-user-a', 'sess-user', 60, 60,
         '{"role":"user","time":{"created":60}}');
    `)

    const adapter = new SqliteSessionsTableAdapter({
      id: 'opencode',
      displayName: 'OpenCode',
      config: {
        dbPath: db,
        table: 'session',
        fieldMap: {
          sessionId: 'id',
          name: 'title',
          lastTransitionAt: 'time_updated',
          cwd: 'directory',
        },
        where: 'time_archived IS NULL AND time_compacting IS NULL',
        limit: 100,
        joinLatest: {
          as: 'latestMessage',
          sql:
            "SELECT m.session_id, " +
            "json_extract(m.data,'$.role') AS role, " +
            "json_extract(m.data,'$.time.completed') AS completed_at, " +
            "json_extract(m.data,'$.error.name') AS error_name " +
            'FROM message m ' +
            'WHERE m.session_id IN (:sessionIds) ' +
            'ORDER BY m.time_created DESC',
        },
        stateInference: [
          {
            name: 'assistant errored',
            mapsTo: 'failed',
            when: {
              equals: { 'latestMessage.role': 'assistant' },
              present: ['latestMessage.error_name'],
            },
          },
          {
            name: 'assistant completed cleanly',
            mapsTo: 'needs-input',
            when: {
              equals: { 'latestMessage.role': 'assistant' },
              present: ['latestMessage.completed_at'],
              absent: ['latestMessage.error_name'],
            },
          },
          {
            name: 'assistant streaming',
            mapsTo: 'working',
            when: {
              equals: { 'latestMessage.role': 'assistant' },
              absent: ['latestMessage.completed_at'],
            },
          },
          {
            name: 'user prompted',
            mapsTo: 'working',
            when: { equals: { 'latestMessage.role': 'user' } },
          },
        ],
      },
    })

    const rows = await adapter.scan()
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))
    expect(byId['sess-needs']!.state).toBe('needs-input')
    expect(byId['sess-work']!.state).toBe('working')
    expect(byId['sess-fail']!.state).toBe('failed')
    expect(byId['sess-user']!.state).toBe('working')
  })

  it('falls back to unknown when no stateInference rule matches and no joined row', async () => {
    const db = await cloneFixtureWith(`
      INSERT INTO session(id, project_id, slug, directory, title, version,
                          time_created, time_updated)
      VALUES ('sess-bare', 'proj-1', 'b', '/tmp/p', 'No messages', '1', 1, 100);
    `)
    const adapter = new SqliteSessionsTableAdapter({
      id: 'opencode',
      displayName: 'OpenCode',
      config: {
        dbPath: db,
        table: 'session',
        fieldMap: { sessionId: 'id', name: 'title', lastTransitionAt: 'time_updated' },
        where: "id = 'sess-bare'",
        joinLatest: {
          as: 'latestMessage',
          sql:
            "SELECT session_id, json_extract(data,'$.role') AS role " +
            'FROM message WHERE session_id IN (:sessionIds) ORDER BY time_created DESC',
        },
        stateInference: [
          {
            mapsTo: 'needs-input',
            when: { equals: { 'latestMessage.role': 'assistant' } },
          },
        ],
      },
    })
    const rows = await adapter.scan()
    expect(rows.map((r) => [r.sessionId, r.state])).toEqual([['sess-bare', 'unknown']])
  })
})
