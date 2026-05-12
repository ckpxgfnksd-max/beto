// beto CLI entry. Wires the StateReader to the App and starts Ink.
//
// Flags:
//   --jobs-dir <path>   Override ~/.claude/jobs (testing / dev seeding)
//   --poll <ms>         Override the 2000ms poll cadence
//   --help              Print usage and exit
//   --version           Print version and exit
//
// Everything else lives inside the TUI.

import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { StateReader } from './sources/state.js'

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
  process.stdout.write('beto 0.1.0\n')
  process.exit(0)
}

const jobsDir = arg('jobs-dir')
const pollMs = arg('poll') ? Number(arg('poll')) : undefined

const reader = new StateReader({
  jobsDir,
  pollMs: pollMs && pollMs > 0 ? pollMs : undefined,
})

const { waitUntilExit } = render(<App reader={reader} />, {
  exitOnCtrlC: true,
})

await waitUntilExit()
reader.stop()

function usage(): string {
  return `beto — terminal inbox for Claude Code sessions

Usage:
  beto                       launch the inbox
  beto --jobs-dir <path>     read state.json files from <path> instead of ~/.claude/jobs
  beto --poll <ms>           poll cadence (default 2000)
  beto --version             print version
  beto --help                this message

Keyboard:
  1-9    peek the Nth session
  d      dispatch a new session (\`claude --bg "<prompt>"\`)
  a      (in peek) attach via Terminal
  r      (in peek) reply (macOS only)
  Esc    back / close overlay
  q      quit

Source: https://github.com/ckpxgfnksd-max/beto
`
}
