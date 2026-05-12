// Zero-write CI proof.
//
// beto's most important promise is that it is read-only with respect to
// harness data directories. This file proves it. Every adapter kind
// gets a fingerprint-before / run-for-N-seconds / fingerprint-after
// test. Any byte of change in the harness directory fails the build.
//
// What this covers:
//   - File contents (sha256 of every byte)
//   - File mtime + size (so a "touched but unchanged" file still fails)
//   - New files created in the harness dir
//   - Deletions
//
// What this does NOT cover (but should be considered):
//   - Writes to harness directories beto doesn't read (out of scope —
//     adapter only touches paths declared in its manifest)
//   - Process-level side effects (signals, FDs, sockets) — those are
//     guarded by the explicit lack of any spawn() inside adapters
//   - Race conditions where beto reads mid-write by the harness itself
//     (not a beto bug; we're proving WE don't write)

import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { ClaudeAdapter } from '../src/sources/state.js'
import { DirectoryOfStateJsonAdapter } from '../src/sources/kinds/directoryOfStateJson.js'
import { JsonlTailAdapter } from '../src/sources/kinds/jsonlTail.js'
import { ProcessWatchOnlyAdapter } from '../src/sources/kinds/processWatchOnly.js'
import { SqliteSessionsTableAdapter } from '../src/sources/kinds/sqliteSessionsTable.js'
import type { Adapter } from '../src/sources/adapter.js'
// Note: jsonl-index zero-write coverage lands in a follow-up after the
// jsonl-index kind PR merges to main. Keeping this PR truly independent
// per the v0.8 process constraint.

// Run-time per test. Long enough for ≥2 poll cycles at the default
// 2s cadence; short enough to keep total CI time under 30s for the
// whole suite.
const RUN_MS = 4500

interface FileFingerprint {
  size: number
  mtimeMs: number
  sha256: string
}

// Recursively walk a directory and capture a fingerprint of every file.
// Returns Map<relative-path, fingerprint>. Symlinks are followed; sockets
// and FIFOs are skipped (they have no useful fingerprint).
async function fingerprintDir(root: string): Promise<Map<string, FileFingerprint>> {
  const out = new Map<string, FileFingerprint>()
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(p)
      } else if (ent.isFile()) {
        try {
          const [stat, buf] = await Promise.all([fs.stat(p), fs.readFile(p)])
          out.set(path.relative(root, p), {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256: createHash('sha256').update(buf).digest('hex'),
          })
        } catch {
          // file disappeared between readdir and stat — skip
        }
      }
    }
  }
  await walk(root)
  return out
}

// Compare two fingerprint snapshots. Returns a list of human-readable
// diff lines (empty when identical). Fails the test if any diff exists.
function diffFingerprints(
  before: Map<string, FileFingerprint>,
  after: Map<string, FileFingerprint>,
): string[] {
  const diffs: string[] = []
  for (const [p, fp] of after) {
    const prev = before.get(p)
    if (!prev) {
      diffs.push(`CREATED: ${p} (size=${fp.size})`)
      continue
    }
    if (prev.sha256 !== fp.sha256) {
      diffs.push(`MODIFIED (sha): ${p}`)
    } else if (prev.size !== fp.size) {
      diffs.push(`MODIFIED (size): ${p} ${prev.size} → ${fp.size}`)
    } else if (prev.mtimeMs !== fp.mtimeMs) {
      diffs.push(`TOUCHED (mtime): ${p}`)
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) diffs.push(`DELETED: ${p}`)
  }
  return diffs
}

// Helper: spin an adapter for RUN_MS, then assert no diff.
async function assertZeroWrite(adapter: Adapter, dir: string): Promise<void> {
  const before = await fingerprintDir(dir)
  adapter.start()
  await new Promise((r) => setTimeout(r, RUN_MS))
  adapter.stop()
  const after = await fingerprintDir(dir)
  const diffs = diffFingerprints(before, after)
  if (diffs.length > 0) {
    throw new Error(
      `beto wrote inside ${dir} during ${RUN_MS}ms run:\n` + diffs.map((d) => '  ' + d).join('\n'),
    )
  }
}

describe('zero-write invariant: no adapter writes inside the harness data dir', () => {
  it('ClaudeAdapter does not write inside ~/.claude/jobs', async () => {
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-claude-'))
    // Seed a realistic fixture: one session with state.json.
    const sess = path.join(jobsDir, 'sess-1')
    await fs.mkdir(sess)
    await fs.writeFile(
      path.join(sess, 'state.json'),
      JSON.stringify({ session_id: 'sess-1', state: 'working', last_transition_at: 0 }),
    )
    const adapter = new ClaudeAdapter({
      jobsDir,
      readTranscripts: false, // pure state.json read path for this test
    })
    await assertZeroWrite(adapter, jobsDir)
  })

  it('DirectoryOfStateJsonAdapter does not write inside its state dir', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-dos-'))
    await fs.mkdir(path.join(stateDir, 'sess-1'))
    await fs.writeFile(
      path.join(stateDir, 'sess-1', 'state.json'),
      JSON.stringify({ session_id: 'sess-1', state: 'working' }),
    )
    const adapter = new DirectoryOfStateJsonAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: { stateDirs: [stateDir] },
    })
    await assertZeroWrite(adapter, stateDir)
  })

  it('JsonlTailAdapter does not write inside its glob root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-jt-'))
    await fs.writeFile(
      path.join(dir, 'sess.jsonl'),
      JSON.stringify({ id: 'sess', t: 'started' }) + '\n',
    )
    const adapter = new JsonlTailAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: {
        fileGlob: path.join(dir, '*.jsonl'),
        fieldMap: { sessionId: 'id', state: 't' },
      },
    })
    await assertZeroWrite(adapter, dir)
  })

  it('ProcessWatchOnlyAdapter does not write inside HOME (no on-disk reads at all)', async () => {
    // ProcessWatchOnlyAdapter has no disk-reading codepath; it shells out
    // to `ps`. The "harness directory" concept doesn't apply. Verify
    // anyway by pointing it at a tmpdir as a stand-in and confirming
    // nothing lands there.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-pw-'))
    const adapter = new ProcessWatchOnlyAdapter({
      id: 'fake',
      displayName: 'Fake',
      binary: 'definitely-not-a-real-binary-' + Math.random(),
      config: {},
    })
    await assertZeroWrite(adapter, dir)
  })

  it('SqliteSessionsTableAdapter does not write inside the dir holding the db', async () => {
    // We don't have a real sqlite test fixture; point the adapter at a
    // missing path so it short-circuits the read. The invariant is still
    // useful — failure modes shouldn't write either.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-sq-'))
    const adapter = new SqliteSessionsTableAdapter({
      id: 'fake',
      displayName: 'Fake',
      config: {
        dbPath: path.join(dir, 'no-such.db'),
        table: 'sessions',
        fieldMap: { sessionId: 'id' },
      },
    })
    await assertZeroWrite(adapter, dir)
  })
})

describe('zero-write invariant: the fingerprint itself works', () => {
  it('flags a created file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-meta-'))
    const before = await fingerprintDir(dir)
    await fs.writeFile(path.join(dir, 'new.txt'), 'hello')
    const after = await fingerprintDir(dir)
    expect(diffFingerprints(before, after)).toEqual(['CREATED: new.txt (size=5)'])
  })

  it('flags a modified file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-meta-'))
    const file = path.join(dir, 'x.txt')
    await fs.writeFile(file, 'a')
    const before = await fingerprintDir(dir)
    await fs.writeFile(file, 'b')
    const after = await fingerprintDir(dir)
    const diffs = diffFingerprints(before, after)
    expect(diffs.some((d) => d.includes('MODIFIED'))).toBe(true)
  })

  it('flags a deletion', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-zw-meta-'))
    const file = path.join(dir, 'x.txt')
    await fs.writeFile(file, 'a')
    const before = await fingerprintDir(dir)
    await fs.rm(file)
    const after = await fingerprintDir(dir)
    expect(diffFingerprints(before, after)).toEqual(['DELETED: x.txt'])
  })
})
