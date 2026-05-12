// Seed a temporary jobs dir with realistic state.json files for dev/preview.
//
//   bun scripts/seed-mock-jobs.ts                  → writes to ./.tmp/jobs
//   bun src/cli.tsx --jobs-dir "$(pwd)/.tmp/jobs"  → run beto against the seed
//
// Designed to exercise every UI branch: needs-input across all 3 escalation
// tiers, an active working session, an idle one, a completed one with a PR,
// and a failed one.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(process.cwd(), '.tmp', 'jobs')

interface Spec {
  id: string
  name: string
  state: string
  summary: string
  ageMs?: number // how long ago the file's mtime should claim to be
  prUrl?: string
  prCheckStatus?: string
  cwd?: string
  processAlive?: boolean
}

const NOW = Date.now()

const specs: Spec[] = [
  {
    id: 'sess-quasar-001',
    name: 'Quasar',
    state: 'needs-input',
    summary: 'asking whether to keep both auth migrations or squash',
    ageMs: 8 * 60 * 1000, // abandoned (>5m)
    cwd: '/Users/chasewang/repos/checkout-redo',
  },
  {
    id: 'sess-nebula-002',
    name: 'Nebula',
    state: 'needs-input',
    summary: 'confirming the dependency upgrade scope before continuing',
    ageMs: 2 * 60 * 1000, // escalated
    cwd: '/Users/chasewang/repos/api-gateway',
  },
  {
    id: 'sess-pulsar-003',
    name: 'Pulsar',
    state: 'needs-input',
    summary: 'awaiting approval to delete the legacy /v1 endpoints',
    ageMs: 25 * 1000, // awaiting
    cwd: '/Users/chasewang/repos/api-gateway',
  },
  {
    id: 'sess-vega-004',
    name: 'Vega',
    state: 'working',
    summary: 'refactoring useAuth into a useSession context provider',
    ageMs: 15 * 1000,
    cwd: '/Users/chasewang/repos/web',
  },
  {
    id: 'sess-rigel-005',
    name: 'Rigel',
    state: 'working',
    summary: 'iterating on the failing integration test in payments-svc',
    ageMs: 5 * 1000,
    cwd: '/Users/chasewang/repos/payments-svc',
  },
  {
    id: 'sess-lyra-006',
    name: 'Lyra',
    state: 'idle',
    summary: 'finished planning; waiting for approval on PR description',
    ageMs: 90 * 1000,
    cwd: '/Users/chasewang/repos/docs-site',
  },
  {
    id: 'sess-cygnus-007',
    name: 'Cygnus',
    state: 'completed',
    summary: 'opened PR for the analytics-event schema migration',
    ageMs: 4 * 60 * 1000,
    prUrl: 'https://github.com/ckpxgfnksd-max/sample/pull/142',
    prCheckStatus: 'success',
    cwd: '/Users/chasewang/repos/analytics',
  },
  {
    id: 'sess-orion-008',
    name: 'Orion',
    state: 'failed',
    summary: 'crashed: missing OPENAI_API_KEY in the test environment',
    ageMs: 10 * 60 * 1000,
    cwd: '/Users/chasewang/repos/sandbox',
  },
]

async function main() {
  await fs.mkdir(ROOT, { recursive: true })
  for (const spec of specs) {
    const dir = path.join(ROOT, spec.id)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'state.json')
    const updatedAt = NOW - (spec.ageMs ?? 0)
    const body = {
      session_id: spec.id,
      name: spec.name,
      state: spec.state,
      summary: spec.summary,
      last_transition_at: updatedAt,
      process_alive: spec.processAlive ?? true,
      pr_url: spec.prUrl ?? '',
      pr_check_status: spec.prCheckStatus ?? '',
      cwd: spec.cwd ?? '',
    }
    await fs.writeFile(file, JSON.stringify(body, null, 2))
    // Backdate mtime so the stale-mtime override kicks in on aged rows.
    const t = new Date(updatedAt)
    await fs.utimes(file, t, t)
  }
  process.stdout.write(
    `seeded ${specs.length} state.json files at ${ROOT}\n` +
      `run: bun src/cli.tsx --jobs-dir "${ROOT}"\n`,
  )
}

await main()
