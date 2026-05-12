// Multi-harness, multi-width headless preview.
//
// Renders the inbox at three widths (45 / 65 / 100 cols) so the ultra /
// sidebar / wide layout modes can all be visually verified in one
// command. Reads .tmp/jobs-<harness>/ produced by seed-mock-jobs.ts.
//
//   bun scripts/seed-mock-jobs.ts && bun scripts/preview-frame.tsx

import React from 'react'
import { render } from 'ink-testing-library'
import * as path from 'node:path'
import { Inbox } from '../src/ui/Inbox.js'
import { MockAdapter } from '../src/sources/mockAdapter.js'
import { flatRows, countByHarness } from '../src/store/inbox.js'
import type { HarnessId, SessionSnapshot } from '../src/lib/types.js'

const ROOT = path.resolve(process.cwd(), '.tmp')

const HARNESSES: HarnessId[] = ['claude', 'codex', 'hermes', 'goose']

const adapters = HARNESSES.map(
  (id) => new MockAdapter({ id, dir: path.join(ROOT, `jobs-${id}`) }),
)

// Manual scan-and-collect — bypass the polling loop for a one-shot render.
// Each adapter's scan returns its harness-tagged rows.
const rowsByHarness: Record<HarnessId, SessionSnapshot[]> = {} as Record<HarnessId, SessionSnapshot[]>
for (const adapter of adapters) {
  rowsByHarness[adapter.id] = await adapter.scan()
}

const merged = flatRows(rowsByHarness, null)
if (merged.length === 0) {
  process.stderr.write(`No mock state.json files in ${ROOT}/jobs-*. Run: bun scripts/seed-mock-jobs.ts\n`)
  process.exit(1)
}

const counts = countByHarness(rowsByHarness)
const now = Date.now()

function Frame({ rows, width }: { rows: SessionSnapshot[]; width: number }) {
  return (
    <Inbox
      rows={rows}
      now={now}
      cursorId={rows[0]?.sessionId ?? null}
      harnessCounts={counts}
      harnessFilter={null}
      width={width}
    />
  )
}

const widths = [
  { label: 'ultra-compact (45 cols)', width: 45 },
  { label: 'sidebar (65 cols)', width: 65 },
  { label: 'wide (100 cols)', width: 100 },
]

for (const { label, width } of widths) {
  process.stdout.write(`\n${'─'.repeat(width)}\n${label}\n${'─'.repeat(width)}\n`)
  const { lastFrame, unmount } = render(<Frame rows={merged} width={width} />)
  await new Promise((r) => setTimeout(r, 30))
  process.stdout.write((lastFrame() ?? '') + '\n')
  unmount()
}
