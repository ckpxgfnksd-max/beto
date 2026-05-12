// beto CLI entry. Wires the HarnessRegistry to the App and starts Ink.
//
// Flags:
//   --jobs-dir <path>    Override ~/.claude/jobs for the Claude adapter
//                        (testing / dev seeding). Forces single-harness
//                        mode.
//   --mock-dir <path>    Mount .tmp/jobs-<harness>/ subdirectories under
//                        the given root and start one MockAdapter per
//                        subdirectory. For multi-harness preview without
//                        any real harness installed.
//   --harness <id>       Restrict to one specific adapter id regardless
//                        of config (claude, codex, hermes, goose, kimi,
//                        openclaw, openhands, aider).
//   --poll <ms>          Override the 2000ms poll cadence
//   --help               Print usage
//   --version            Print version

import React from 'react'
import { render } from 'ink'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { App } from './ui/App.js'
import { ClaudeAdapter } from './sources/state.js'
import { MockAdapter } from './sources/mockAdapter.js'
import { HarnessRegistry } from './sources/adapter.js'
import { loadOrInitConfig } from './lib/config.js'
import { detect } from './lib/detect.js'
import { printBanner, printDoctor } from './lib/doctor.js'
import { HARNESS_IDS, type HarnessId } from './lib/types.js'

const args = process.argv.slice(2)

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i < 0 || i === args.length - 1) return undefined
  return args[i + 1]
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(usage())
  process.exit(0)
}
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write('beto 0.2.1\n')
  process.exit(0)
}

// Subcommand: `beto doctor` prints the detection matrix and exits.
// Accepts --no-cache to force a fresh probe.
if (args[0] === 'doctor') {
  const useCache = !args.includes('--no-cache')
  const report = await detect({ useCache })
  printDoctor(report)
  process.exit(0)
}

const jobsDir = arg('jobs-dir')
const mockDir = arg('mock-dir')
const harnessOverride = arg('harness') as HarnessId | undefined
const pollMs = arg('poll') ? Number(arg('poll')) : undefined

if (harnessOverride && !HARNESS_IDS.includes(harnessOverride)) {
  process.stderr.write(`beto: unknown harness '${harnessOverride}'. valid: ${HARNESS_IDS.join(', ')}\n`)
  process.exit(2)
}

const registry = new HarnessRegistry()

if (mockDir) {
  // Multi-harness mock mode: one MockAdapter per .tmp/jobs-<harness>/
  // subdirectory present. Doesn't touch ~/.beto/config.json.
  const entries = await fs.readdir(mockDir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith('jobs-')) continue
    const id = ent.name.slice(5) as HarnessId
    if (!HARNESS_IDS.includes(id)) continue
    registry.add(
      new MockAdapter({
        id,
        dir: path.join(mockDir, ent.name),
        pollMs: pollMs && pollMs > 0 ? pollMs : undefined,
      }),
    )
  }
  if (registry.harnessIds.length === 0) {
    process.stderr.write(
      `beto: no jobs-<harness>/ directories under ${mockDir}. Run: bun scripts/seed-mock-jobs.ts\n`,
    )
    process.exit(2)
  }
} else if (jobsDir) {
  // Single-harness override: only the claude adapter against the given
  // jobs dir. Backwards compatible with v0.1 dev-and-test recipes.
  registry.add(
    new ClaudeAdapter({
      jobsDir,
      pollMs: pollMs && pollMs > 0 ? pollMs : undefined,
    }),
  )
} else {
  // Normal launch: load (or initialize) ~/.beto/config.json (which now
  // uses the layered detector internally), then start every enabled
  // adapter. v0.2.1 only the claude adapter actually reads a path; the
  // rest are reserved slots until v0.3 lands the manifest schema.
  const cfg = await loadOrInitConfig()

  // Re-run detect.ts for the startup banner (option b: explicit). Cheap
  // because the loadOrInitConfig call above primed the cache.
  const detectionReport = await detect()
  printBanner(detectionReport)

  const enabled = (Object.entries(cfg.harnesses) as Array<[HarnessId, { enabled: boolean; path?: string }]>)
    .filter(([id, h]) => h.enabled && (!harnessOverride || id === harnessOverride))

  for (const [id, h] of enabled) {
    if (id === 'claude') {
      registry.add(
        new ClaudeAdapter({
          jobsDir: h.path,
          pollMs: pollMs && pollMs > 0 ? pollMs : undefined,
        }),
      )
    }
    // Other harnesses fall through silently in v0.2.1 — the slot is
    // reserved but the adapter lands in v0.3+ via the plugin manifest.
  }
}

const { waitUntilExit } = render(<App registry={registry} />, {
  exitOnCtrlC: true,
})

await waitUntilExit()
registry.stop()

function usage(): string {
  return `beto — universal terminal sidebar for AI agent sessions

Usage:
  beto                          launch (reads ~/.beto/config.json)
  beto doctor [--no-cache]      print the detection matrix and exit
  beto --jobs-dir <path>        single-harness, Claude jobs dir override
  beto --mock-dir <path>        multi-harness mock mode (.tmp/jobs-*/)
  beto --harness <id>           restrict to one adapter (claude|codex|...)
  beto --poll <ms>              poll cadence (default 2000)
  beto --version                print version
  beto --help                   this message

Keyboard:
  1-9    peek the Nth session
  d      dispatch a new Claude session (\`claude --bg "<prompt>"\`)
  a      (in peek) attach via Terminal — Claude only in v0.2.x
  r      (in peek) reply via clipboard — Claude only in v0.2.x
  f      cycle the harness filter (all → claude → codex → ...)
  Esc    back / close overlay
  q      quit

Harnesses (v0.2.1):
  ${HARNESS_IDS.join(' · ')}
  Only \`claude\` has a real adapter today. The rest are reserved slots
  detected by PATH + state-dir + process scan. v0.3 lands a plugin
  manifest schema (\`~/.beto/plugins/*.json\`) so anyone can register a
  harness without a TypeScript PR.

Source: https://github.com/ckpxgfnksd-max/beto
`
}
