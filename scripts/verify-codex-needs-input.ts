// One-shot verification: load the bundled codex.json manifest, run
// JsonlTailAdapter once against the developer's real
// ~/.codex/sessions/, and print state distribution. If the new
// stateInference rules work, at least some recent rollouts (the most
// recent `task_complete` events) should land in `needs-input` instead
// of the old age-based `idle` / `completed` heuristic.
//
// Usage: bun scripts/verify-codex-needs-input.ts

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../src/lib/manifest.js'
import { JsonlTailAdapter } from '../src/sources/kinds/jsonlTail.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.resolve(__dirname, '..', 'manifests', 'codex.json')

async function main() {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
  const result = validateManifest(raw)
  if (!result.ok) {
    process.stderr.write(`manifest invalid:\n${JSON.stringify(result.errors, null, 2)}\n`)
    process.exit(1)
  }
  const m = result.manifest!
  if (m.adapter.kind !== 'jsonl-tail') throw new Error('expected jsonl-tail')
  const adapter = new JsonlTailAdapter({
    id: m.id,
    displayName: m.displayName,
    config: m.adapter.config,
  })
  const rows = await adapter.scan()
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1
  console.log(`Codex sessions found: ${rows.length}`)
  console.log('State distribution:')
  for (const [state, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${state.padEnd(12)} ${n}`)
  }
  console.log('\nMost recent 10 sessions:')
  for (const r of rows.slice(0, 10)) {
    const age = Math.round((Date.now() - r.lastTransitionAt) / 1000)
    console.log(
      `  ${r.state.padEnd(12)} ${r.sessionId.slice(0, 16)}… ${age}s ago — ${r.name?.slice(0, 30) ?? ''}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
