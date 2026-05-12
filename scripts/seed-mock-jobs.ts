// Multi-harness mock seeder. Writes state.json files into per-harness
// directories so the preview/dev gauntlet exercises every UI branch:
// every state, all three escalation tiers, mixed harness colors.
//
//   bun scripts/seed-mock-jobs.ts                  → writes .tmp/jobs-<harness>/
//   bun scripts/preview-frame.tsx                  → renders three widths
//   bun src/cli.tsx --jobs-dir "$(pwd)/.tmp/jobs-claude" → run Claude-only

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { HarnessId } from '../src/lib/types.js'

const ROOT = path.resolve(process.cwd(), '.tmp')

interface Spec {
  harness: HarnessId
  id: string
  name: string
  state: string
  summary: string
  ageMs?: number
  prUrl?: string
  prCheckStatus?: string
  cwd?: string
  processAlive?: boolean
}

const NOW = Date.now()

const specs: Spec[] = [
  // ── Claude Code sessions ─────────────────────────────────────────
  {
    harness: 'claude',
    id: 'sess-quasar-001',
    name: 'Quasar',
    state: 'needs-input',
    summary: 'asking whether to keep both auth migrations or squash',
    ageMs: 8 * 60 * 1000, // abandoned
    cwd: '/Users/chasewang/repos/checkout-redo',
  },
  {
    harness: 'claude',
    id: 'sess-vega-004',
    name: 'Vega',
    state: 'working',
    summary: 'refactoring useAuth into a useSession context provider',
    ageMs: 15 * 1000,
    cwd: '/Users/chasewang/repos/web',
  },
  {
    harness: 'claude',
    id: 'sess-lyra-006',
    name: 'Lyra',
    state: 'idle',
    summary: 'finished planning; waiting for approval on PR description',
    ageMs: 90 * 1000,
    cwd: '/Users/chasewang/repos/docs-site',
  },
  {
    harness: 'claude',
    id: 'sess-cygnus-007',
    name: 'Cygnus',
    state: 'completed',
    summary: 'opened PR for the analytics-event schema migration',
    ageMs: 4 * 60 * 1000,
    prUrl: 'https://github.com/ckpxgfnksd-max/sample/pull/142',
    prCheckStatus: 'success',
    cwd: '/Users/chasewang/repos/analytics',
  },

  // ── Codex sessions ───────────────────────────────────────────────
  {
    harness: 'codex',
    id: 'cx-nebula-002',
    name: 'Nebula',
    state: 'needs-input',
    summary: 'confirming the dependency upgrade scope before continuing',
    ageMs: 2 * 60 * 1000, // escalated
    cwd: '/Users/chasewang/repos/api-gateway',
  },
  {
    harness: 'codex',
    id: 'cx-rigel-005',
    name: 'Rigel',
    state: 'working',
    summary: 'iterating on the failing integration test in payments-svc',
    ageMs: 5 * 1000,
    cwd: '/Users/chasewang/repos/payments-svc',
  },

  // ── Hermes Agent sessions ────────────────────────────────────────
  {
    harness: 'hermes',
    id: 'hx-pulsar-003',
    name: 'Pulsar',
    state: 'needs-input',
    summary: 'awaiting approval to delete the legacy /v1 endpoints',
    ageMs: 25 * 1000, // awaiting
    cwd: '/Users/chasewang/repos/api-gateway',
  },
  {
    harness: 'hermes',
    id: 'hx-orion-008',
    name: 'Orion',
    state: 'failed',
    summary: 'crashed: missing OPENAI_API_KEY in the test environment',
    ageMs: 10 * 60 * 1000,
    cwd: '/Users/chasewang/repos/sandbox',
  },

  // ── Goose sessions ───────────────────────────────────────────────
  {
    harness: 'goose',
    id: 'gs-altair-009',
    name: 'Altair',
    state: 'working',
    summary: 'running MCP tool: file-search across the monorepo',
    ageMs: 8 * 1000,
    cwd: '/Users/chasewang/repos/mono',
  },
]

async function main() {
  await fs.mkdir(ROOT, { recursive: true })

  // Group by harness so each harness gets its own dir.
  const byHarness = new Map<HarnessId, Spec[]>()
  for (const s of specs) {
    const arr = byHarness.get(s.harness) ?? []
    arr.push(s)
    byHarness.set(s.harness, arr)
  }

  let totalFiles = 0
  for (const [harness, group] of byHarness) {
    const dir = path.join(ROOT, `jobs-${harness}`)
    await fs.mkdir(dir, { recursive: true })
    for (const spec of group) {
      const sessDir = path.join(dir, spec.id)
      await fs.mkdir(sessDir, { recursive: true })
      const file = path.join(sessDir, 'state.json')
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
      const t = new Date(updatedAt)
      await fs.utimes(file, t, t)
      totalFiles++
    }
    process.stdout.write(`  ${harness}: ${group.length} sessions → ${dir}\n`)
  }

  process.stdout.write(
    `\nseeded ${totalFiles} state.json files across ${byHarness.size} harnesses\n` +
      `run: bun scripts/preview-frame.tsx\n`,
  )
}

await main()
