// Headless preview: renders ONE frame of the inbox against the seeded
// jobs dir, prints the last frame to stdout, and exits.
//
// Usage:
//   bun scripts/seed-mock-jobs.ts
//   bun scripts/preview-frame.tsx
//
// Useful for confirming layout/visual changes from a non-TTY context (CI,
// agent verification). Not part of the shipped CLI.

import React, { useEffect } from 'react'
import { render } from 'ink-testing-library'
import { Inbox } from '../src/ui/Inbox.js'
import { StateReader } from '../src/sources/state.js'
import * as path from 'node:path'
import type { SessionSnapshot } from '../src/lib/types.js'

const jobsDir = path.resolve(process.cwd(), '.tmp/jobs')

const reader = new StateReader({ jobsDir })
const rows = await reader.scan()

if (rows.length === 0) {
  process.stderr.write(
    `No state.json files in ${jobsDir}.\nRun: bun scripts/seed-mock-jobs.ts\n`,
  )
  process.exit(1)
}

const now = Date.now()

function Frame({ rows }: { rows: SessionSnapshot[] }) {
  return <Inbox rows={rows} now={now} cursorId={rows[0]?.sessionId ?? null} />
}

const { lastFrame, unmount } = render(<Frame rows={rows} />)
// One render tick to let effects (none here) settle.
await new Promise((r) => setTimeout(r, 50))
process.stdout.write(lastFrame() + '\n')
unmount()
