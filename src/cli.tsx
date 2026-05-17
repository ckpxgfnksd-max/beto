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
import { loadPlugins } from './lib/plugins.js'
import { NotificationManager } from './lib/notifications.js'
import { renderSwiftBar } from './lib/swiftbar.js'
import { fileURLToPath } from 'node:url'
import { HARNESS_IDS, type HarnessId, type SessionSnapshot } from './lib/types.js'

const args = process.argv.slice(2)

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i < 0 || i === args.length - 1) return undefined
  return args[i + 1]
}

// One-shot scan helper. Builds the registry from config + plugin
// manifests, lets each adapter complete its first scan, then resolves
// with the merged rows. Used by `beto bar` (SwiftBar) and any future
// scriptable subcommand that doesn't want the long-running Ink app.
async function scanOnce(timeoutMs = 1500): Promise<SessionSnapshot[]> {
  const cfg = await loadOrInitConfig()
  const reg = new HarnessRegistry()

  const bundledDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'manifests',
  )
  const pluginResult = await loadPlugins({ extraDirs: [bundledDir] })
  for (const plugin of pluginResult.loaded) reg.add(plugin.adapter)
  if (cfg.harnesses.claude?.enabled) {
    reg.add(new ClaudeAdapter({ jobsDir: cfg.harnesses.claude.path }))
  }

  return new Promise<SessionSnapshot[]>((resolve) => {
    let latest: SessionSnapshot[] = []
    const unsub = reg.onChange((rows) => {
      latest = rows
    })
    reg.start()
    setTimeout(() => {
      unsub()
      reg.stop()
      resolve(latest)
    }, timeoutMs)
  })
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(usage())
  process.exit(0)
}
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write('beto 0.8.0\n')
  process.exit(0)
}

// --no-notifications disables OS notifications for the session. Useful
// for screen-recording, screencasts, focused work blocks, etc.
const notificationsDisabledByFlag = args.includes('--no-notifications')

// Subcommand: `beto doctor` prints the detection matrix and exits.
// Accepts --no-cache to force a fresh probe.
if (args[0] === 'doctor') {
  const useCache = !args.includes('--no-cache')
  const report = await detect({ useCache })
  printDoctor(report)
  process.exit(0)
}

// Subcommand: `beto bar` prints SwiftBar-format markdown to stdout and
// exits. The SwiftBar plugin file (bin/beto.30s.sh) shells into this.
//
// Builds the registry from ~/.beto/config.json + bundled manifests, runs
// every adapter for ~1.5s so they emit their first snapshot, formats,
// exits. No Ink, no polling — pure scan-and-print.
if (args[0] === 'bar') {
  const rows = await scanOnce()
  // Path used in the dropdown's "Open inbox" / "Open doctor" actions.
  // Default to the bare command name (assumes `beto` is on PATH after
  // `bun link` / `bun add -g`). $BETO_PATH overrides when users have
  // an unusual install layout.
  const betoPath = process.env.BETO_PATH ?? 'beto'
  process.stdout.write(renderSwiftBar(rows, { betoPath }))
  process.exit(0)
}

const jobsDir = arg('jobs-dir')
const mockDir = arg('mock-dir')
const harnessOverride = arg('harness') as HarnessId | undefined
const pollMs = arg('poll') ? Number(arg('poll')) : undefined

if (harnessOverride && !(HARNESS_IDS as readonly string[]).includes(harnessOverride)) {
  // Could still be a valid plugin-registered id. Warn but proceed.
  process.stderr.write(
    `beto: '${harnessOverride}' not a built-in harness; assuming it's a plugin id\n`,
  )
}

const registry = new HarnessRegistry()
// Build the notifier eagerly so both mock-dir and normal paths get it.
// The actual enabled state is resolved below — config can override.
let notifierEnabled = !notificationsDisabledByFlag
let notifierSound = false

if (mockDir) {
  // Multi-harness mock mode: one MockAdapter per .tmp/jobs-<harness>/
  // subdirectory present. Doesn't touch ~/.beto/config.json.
  const entries = await fs.readdir(mockDir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith('jobs-')) continue
    const id = ent.name.slice(5) as HarnessId
    if (!(HARNESS_IDS as readonly string[]).includes(id)) continue
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
  // Normal launch: detect → banner → config → plugins → built-in Claude.
  const cfg = await loadOrInitConfig()
  const detectionReport = await detect()
  printBanner(detectionReport)

  // Load plugins from ~/.beto/plugins/ + the manifests/ directory shipped
  // with this repo (so first-time users get reference adapters without a
  // separate install). User-installed manifests take precedence on id
  // collisions.
  const bundledDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'manifests',
  )
  const pluginResult = await loadPlugins({ extraDirs: [bundledDir] })
  for (const plugin of pluginResult.loaded) {
    // If a non-Claude harness is plugin-backed and the user explicitly
    // restricted via --harness, respect that filter.
    if (harnessOverride && plugin.manifest.id !== harnessOverride) continue
    registry.add(plugin.adapter)
  }
  if (pluginResult.failures.length > 0) {
    for (const f of pluginResult.failures) {
      process.stderr.write(`beto: skipped manifest ${f.sourcePath}: `)
      if (typeof f.errors === 'string') {
        process.stderr.write(f.errors + '\n')
      } else {
        process.stderr.write(f.errors.map((e) => `${e.path}: ${e.message}`).join('; ') + '\n')
      }
    }
  }

  // The built-in Claude adapter still wires up directly (not via
  // manifest) — it's the canonical first-party harness and the only one
  // with a working dispatch/attach/reply commander layer in v0.3.
  if (cfg.harnesses.claude?.enabled && (!harnessOverride || harnessOverride === 'claude')) {
    registry.add(
      new ClaudeAdapter({
        jobsDir: cfg.harnesses.claude.path,
        pollMs: pollMs && pollMs > 0 ? pollMs : undefined,
      }),
    )
  }

  // Notifications config from ~/.beto/config.json. CLI flag wins if set.
  if (cfg.notifications) {
    if (!notificationsDisabledByFlag) notifierEnabled = cfg.notifications.enabled
    notifierSound = cfg.notifications.sound
  }
}

const notifier = new NotificationManager({
  enabled: notifierEnabled,
  sound: notifierSound,
})

const { waitUntilExit } = render(<App registry={registry} notifier={notifier} />, {
  exitOnCtrlC: true,
})

await waitUntilExit()
registry.stop()
await notifier.flush()

function usage(): string {
  return `beto — universal terminal sidebar for AI agent sessions

Usage:
  beto                          launch (reads ~/.beto/config.json)
  beto bar                      emit SwiftBar markdown to stdout (and exit)
  beto doctor [--no-cache]      print the detection matrix and exit
  beto --jobs-dir <path>        single-harness, Claude jobs dir override
  beto --mock-dir <path>        multi-harness mock mode (.tmp/jobs-*/)
  beto --harness <id>           restrict to one adapter (claude|codex|...)
  beto --poll <ms>              poll cadence (default 2000)
  beto --no-notifications       disable OS notifications for this run
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

Harnesses (built-in detection):
  ${HARNESS_IDS.join(' · ')}

Adapters (v0.3):
  Claude has its built-in adapter; everything else loads via plugin
  manifests at ~/.beto/plugins/*.json. Four built-in adapter kinds:
    - directory-of-state-json   (Claude / Codex)
    - sqlite-sessions-table     (Hermes / Goose)
    - jsonl-tail                (Open Interpreter / Aider variants)
    - process-watch-only        (Aider / any process-only CLI)
  Reference manifests ship in manifests/. Drop your own into
  ~/.beto/plugins/ — they override the bundled ones by id.

Source: https://github.com/ckpxgfnksd-max/beto
`
}
