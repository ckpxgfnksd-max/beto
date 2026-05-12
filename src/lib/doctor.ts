// `beto doctor` — print the full detection matrix to stdout and exit.
// `printBanner` — one-or-two-line summary on every normal launch.
//
// Both consume a DetectionReport. The matrix view is human-diagnostic;
// the banner is glanceable.

import {
  HARNESS_NAME,
} from '../ui/theme.js'
import type {
  DetectedHarness,
  DetectedInferenceBackend,
  DetectionReport,
  DetectionStatus,
} from './detect.js'
import { HARNESS_IDS, INFERENCE_BACKEND_IDS } from './types.js'

// ANSI helpers — kept tiny so doctor stays a self-contained printer
// (no Ink mount, exits cleanly on completion).
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const STATUS_COLOR: Record<DetectionStatus, keyof typeof C> = {
  absent: 'gray',
  installed: 'cyan',
  configured: 'blue',
  running: 'yellow',
  active: 'green',
}

const STATUS_LABEL: Record<DetectionStatus, string> = {
  absent: 'absent',
  installed: 'installed',
  configured: 'configured',
  running: 'running',
  active: 'active',
}

// One- or two-line summary printed on normal launch (option b: explicit).
// Only lists harnesses with status > absent; otherwise prints nothing.
export function printBanner(report: DetectionReport, out: NodeJS.WriteStream = process.stderr): void {
  const present = report.harnesses.filter((h) => h.status !== 'absent')
  if (present.length === 0 && report.inferenceBackends.every((b) => !b.binary && !b.processCount)) {
    return
  }
  const parts: string[] = []
  for (const h of present) {
    const color = C[STATUS_COLOR[h.status]]
    const v = h.binary?.version ? ' ' + extractVersion(h.binary.version) : ''
    const dot = h.processCount > 0 ? '●' : '○'
    parts.push(`${color}${dot} ${HARNESS_NAME[h.id]}${v}${C.reset}`)
  }
  const inference = report.inferenceBackends.filter((b) => b.binary || b.processCount > 0)
  if (inference.length > 0) {
    parts.push(C.dim + 'backends: ' + inference.map((b) => b.id).join(', ') + C.reset)
  }
  out.write(`${C.bold}beto${C.reset} ${C.dim}detected:${C.reset} ${parts.join(C.dim + ' · ' + C.reset)}\n`)
  if (report.partial) {
    out.write(`${C.dim}  (partial — some probes hit a timeout; run \`beto doctor\` for detail)${C.reset}\n`)
  }
}

// Full diagnostic matrix. Tabular, no Ink, exits when done.
export function printDoctor(report: DetectionReport, out: NodeJS.WriteStream = process.stdout): void {
  out.write(`${C.bold}beto doctor${C.reset}\n`)
  out.write(`${C.dim}Generated ${new Date(report.generatedAt).toISOString()}${report.partial ? ' · partial' : ''}${C.reset}\n\n`)

  out.write(`${C.bold}Agent harnesses${C.reset}\n`)
  out.write(harnessTable(report.harnesses))
  out.write('\n')

  out.write(`${C.bold}Local inference backends${C.reset}\n`)
  out.write(backendTable(report.inferenceBackends))
  out.write('\n')

  out.write(`${C.dim}Legend: ${C.green}active${C.reset}${C.dim} (state + process) · ${C.blue}configured${C.reset}${C.dim} · ${C.yellow}running${C.reset}${C.dim} (no state) · ${C.cyan}installed${C.reset}${C.dim} · ${C.gray}absent${C.reset}${C.dim}\n`)
  out.write(`${C.dim}Plugin manifests at ~/.beto/plugins/*.json (v0.3+) extend this list.${C.reset}\n`)
}

function harnessTable(rows: DetectedHarness[]): string {
  // 4 columns: id · binary+version · state dir · procs+status
  const header = ['harness', 'binary', 'state dir', 'procs / status']
  const data: string[][] = rows.map((r) => {
    const bin = r.binary
      ? `${shortPath(r.binary.path)} ${C.dim}${extractVersion(r.binary.version ?? '')}${C.reset}`.trim()
      : `${C.gray}(not found)${C.reset}`
    const state = r.stateDir ? shortPath(r.stateDir) : `${C.gray}—${C.reset}`
    const color = C[STATUS_COLOR[r.status]]
    const procs = r.processCount > 0 ? `${r.processCount} ` : ''
    const status = `${procs}${color}${STATUS_LABEL[r.status]}${C.reset}`
    return [r.id, bin, state, status]
  })
  return renderTable(header, data) + '\n'
}

function backendTable(rows: DetectedInferenceBackend[]): string {
  const header = ['backend', 'binary', 'procs']
  const data: string[][] = rows.map((r) => {
    const bin = r.binary
      ? `${shortPath(r.binary.path)} ${C.dim}${extractVersion(r.binary.version ?? '')}${C.reset}`.trim()
      : `${C.gray}(not found)${C.reset}`
    const procs = r.processCount > 0 ? `${C.yellow}${r.processCount} running${C.reset}` : `${C.gray}—${C.reset}`
    return [r.id, bin, procs]
  })
  return renderTable(header, data) + '\n'
}

// Tiny ASCII table renderer. We compute visible widths ignoring ANSI
// escapes so the padding math doesn't go sideways on colored cells.
function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  )
  const sep = '  '
  const head = header.map((h, i) => `${C.dim}${pad(h, widths[i]!)}${C.reset}`).join(sep)
  const body = rows
    .map((r) => r.map((cell, i) => pad(cell, widths[i]!)).join(sep))
    .join('\n')
  return `${head}\n${body}`
}

function pad(s: string, w: number): string {
  const visible = visibleWidth(s)
  if (visible >= w) return s
  return s + ' '.repeat(w - visible)
}

// Strip ANSI to get the visible char count for padding.
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

function shortPath(p: string): string {
  const home = process.env.HOME
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

// Many CLIs print "claude version 2.1.139" or "v1.4.0\n(c) 2026..." or
// just "1.33.1". Pull the first version-shaped substring.
export function extractVersion(raw: string): string {
  const m = raw.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/)
  return m ? m[1]! : raw.slice(0, 12)
}

// Silence the unused-import lint for HARNESS_IDS / INFERENCE_BACKEND_IDS
// — they're useful if doctor ever wants to list "configured but not
// implemented" slots in a follow-up.
export const _imports = { HARNESS_IDS, INFERENCE_BACKEND_IDS }
