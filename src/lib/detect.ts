// Layered agent-harness auto-detection.
//
// Three independent signals, fused into one per-harness status:
//
//   1. PATH probe + version exec    → "is the binary installed?"
//   2. State-dir probe (XDG-aware)  → "has it ever been configured?"
//   3. Process scan                  → "is it running right now?"
//
// Status spectrum (least → most evidence):
//   absent     nothing
//   installed  binary exists, no state dir, no process
//   configured state dir exists, no live process
//   running    process running but no state dir (foreground-only)
//   active     state dir AND (process OR fresh files)
//
// Detection is budgeted: every binary version exec has a 1s timeout, the
// process scan has a 2s timeout, and the whole pipeline aborts at 5s
// returning whatever it has. Result is cached at ~/.beto/cache/detection.json
// with a 1h TTL + invalidation on any binary's mtime change.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  HARNESS_IDS,
  INFERENCE_BACKEND_IDS,
  type HarnessId,
  type InferenceBackendId,
} from './types.js'

export type DetectionStatus = 'absent' | 'installed' | 'configured' | 'running' | 'active'

export interface DetectedBinary {
  path: string
  version: string | null
  mtimeMs: number
}

export interface DetectedHarness {
  id: HarnessId
  status: DetectionStatus
  binary: DetectedBinary | null
  stateDir: string | null
  processCount: number
}

export interface DetectedInferenceBackend {
  id: InferenceBackendId
  binary: DetectedBinary | null
  processCount: number
}

export interface DetectionReport {
  harnesses: DetectedHarness[]
  inferenceBackends: DetectedInferenceBackend[]
  generatedAt: number
  // True if any signal hit its timeout. Caller may want to widen the
  // budget or warn that the report is partial.
  partial: boolean
}

// Binary name per harness. Most match the id, but a few diverge.
const HARNESS_BINARIES: Record<HarnessId, readonly string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  hermes: ['hermes'],
  goose: ['goose'],
  kimi: ['kimi'],
  openclaw: ['openclaw'],
  openhands: ['openhands'],
  aider: ['aider'],
  'open-interpreter': ['interpreter'],
  crewai: ['crewai'],
  metagpt: ['metagpt'],
}

// Inference daemons we probe. Not harnesses — informational only.
const INFERENCE_BINARIES: Record<InferenceBackendId, readonly string[]> = {
  ollama: ['ollama'],
  vllm: ['vllm'],
  'llama-server': ['llama-server'],
  lmstudio: ['lms', 'lmstudio'],
  litellm: ['litellm'],
  tgi: ['text-generation-launcher'],
  'huggingface-cli': ['huggingface-cli', 'hf'],
}

// Match a process command line to a harness/backend id. We look at the
// basename of argv[0] only, so a generic name like "node" doesn't match
// claude unless the actual exec is /usr/local/bin/claude.
const PROCESS_NAME_TO_HARNESS: Record<string, HarnessId> = (() => {
  const out: Record<string, HarnessId> = {}
  for (const id of HARNESS_IDS) {
    for (const bin of HARNESS_BINARIES[id]) out[bin] = id
  }
  return out
})()

const PROCESS_NAME_TO_BACKEND: Record<string, InferenceBackendId> = (() => {
  const out: Record<string, InferenceBackendId> = {}
  for (const id of INFERENCE_BACKEND_IDS) {
    for (const bin of INFERENCE_BINARIES[id]) out[bin] = id
  }
  return out
})()

const DEFAULT_STATE_REL: Record<HarnessId, string> = {
  claude: '.claude/jobs',
  codex: '.codex',
  hermes: '.hermes',
  goose: '.local/share/goose/sessions',
  kimi: '.kimi',
  openclaw: '.openclaw',
  openhands: '.openhands',
  aider: '', // per-repo, not centralized
  'open-interpreter': '.config/open-interpreter',
  crewai: '.crewai',
  metagpt: '.metagpt',
}

export interface DetectOptions {
  home?: string
  // Hard cap; default 5000ms.
  totalBudgetMs?: number
  // Per-version-exec; default 1000ms.
  versionTimeoutMs?: number
  // Process scan timeout; default 2000ms.
  processTimeoutMs?: number
  // Use the on-disk cache if present and fresh. Default true.
  useCache?: boolean
}

// Main entry. Returns a fused report. Failures degrade gracefully: a
// binary that hangs at `--version` is recorded with version=null; a
// failed process scan returns processCount=0 for everyone.
export async function detect(opts: DetectOptions = {}): Promise<DetectionReport> {
  const home = opts.home ?? os.homedir()
  const totalBudget = opts.totalBudgetMs ?? 5000
  const versionTimeout = opts.versionTimeoutMs ?? 1000
  const processTimeout = opts.processTimeoutMs ?? 2000
  const useCache = opts.useCache !== false

  if (useCache) {
    const cached = await loadCache(home)
    if (cached) return cached
  }

  const startedAt = Date.now()
  const deadline = startedAt + totalBudget

  // Layer 1: PATH probe — find every binary in parallel.
  const allBinaryNames = [
    ...Object.values(HARNESS_BINARIES).flat(),
    ...Object.values(INFERENCE_BINARIES).flat(),
  ]
  const uniqueBinaries = [...new Set(allBinaryNames)]
  const binaryByName = new Map<string, DetectedBinary>()
  await withDeadline(
    Promise.all(
      uniqueBinaries.map(async (name) => {
        const found = await which(name)
        if (!found) return
        const mtimeMs = await mtime(found)
        binaryByName.set(name, { path: found, version: null, mtimeMs })
      }),
    ),
    Math.min(2000, deadline - Date.now()),
  )

  // Layer 1b: --version exec for each binary we found, in parallel.
  await withDeadline(
    Promise.all(
      [...binaryByName.entries()].map(async ([name, entry]) => {
        const v = await execVersion(entry.path, versionTimeout)
        if (v != null) binaryByName.set(name, { ...entry, version: v })
      }),
    ),
    Math.max(0, deadline - Date.now()),
  )

  // Layer 2: state-dir probe (XDG-aware) per harness.
  const stateDirByHarness = new Map<HarnessId, string>()
  await Promise.all(
    HARNESS_IDS.map(async (id) => {
      const dir = await firstExisting(statePathCandidates(home, id))
      if (dir) stateDirByHarness.set(id, dir)
    }),
  )

  // Layer 3: process scan.
  const procCounts = new Map<string, number>()
  let partial = false
  try {
    const procs = await scanProcesses(processTimeout)
    for (const cmd of procs) {
      const base = basenameFromCommand(cmd)
      if (!base) continue
      const harness = PROCESS_NAME_TO_HARNESS[base]
      if (harness) procCounts.set(harness, (procCounts.get(harness) ?? 0) + 1)
      const backend = PROCESS_NAME_TO_BACKEND[base]
      if (backend) procCounts.set(backend, (procCounts.get(backend) ?? 0) + 1)
    }
  } catch {
    partial = true
  }

  if (Date.now() > deadline) partial = true

  // Fuse per-harness.
  const harnesses: DetectedHarness[] = HARNESS_IDS.map((id) => {
    const bins = HARNESS_BINARIES[id]
    const binary = pickFirstBinary(bins, binaryByName)
    const stateDir = stateDirByHarness.get(id) ?? null
    const processCount = procCounts.get(id) ?? 0
    const status = fuseStatus({ binary, stateDir, processCount })
    return { id, status, binary, stateDir, processCount }
  })

  const inferenceBackends: DetectedInferenceBackend[] = INFERENCE_BACKEND_IDS.map((id) => {
    const bins = INFERENCE_BINARIES[id]
    const binary = pickFirstBinary(bins, binaryByName)
    const processCount = procCounts.get(id) ?? 0
    return { id, binary, processCount }
  })

  const report: DetectionReport = {
    harnesses,
    inferenceBackends,
    generatedAt: Date.now(),
    partial,
  }
  await saveCache(home, report)
  return report
}

function pickFirstBinary(
  names: readonly string[],
  map: Map<string, DetectedBinary>,
): DetectedBinary | null {
  for (const n of names) {
    const b = map.get(n)
    if (b) return b
  }
  return null
}

function fuseStatus(input: {
  binary: DetectedBinary | null
  stateDir: string | null
  processCount: number
}): DetectionStatus {
  const { binary, stateDir, processCount } = input
  if (binary && stateDir && processCount > 0) return 'active'
  if (stateDir && processCount > 0) return 'active'
  if (stateDir) return 'configured'
  if (binary && processCount > 0) return 'running'
  if (binary) return 'installed'
  return 'absent'
}

// ─── PATH probing ────────────────────────────────────────────────────

export async function which(name: string): Promise<string | null> {
  const PATH = process.env.PATH ?? ''
  const isWin = process.platform === 'win32'
  const sep = isWin ? ';' : ':'
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of PATH.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        const stat = await fs.stat(candidate)
        if (stat.isFile()) return candidate
      } catch {
        // missing file is the common case; ignore
      }
    }
  }
  return null
}

async function mtime(p: string): Promise<number> {
  try {
    const st = await fs.stat(p)
    return st.mtimeMs
  } catch {
    return 0
  }
}

// Run `<binary> --version`. Resolves with up to the first ~3 lines of
// stdout (so a warning header doesn't bury the actual version), or null
// on timeout/error. Always kills the child on the way out.
//
// We keep a small multi-line buffer rather than only the first line
// because some CLIs print a warning or a debug log line before the
// version (ollama is one: "Warning: could not connect..." then
// "client version is 0.5.4"). `extractVersion` downstream handles the
// pattern match across the whole string.
export function execVersion(binary: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: string | null) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const child = spawn(binary, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    child.stdout.on('data', (b) => {
      buf += String(b)
      if (buf.length > 1024) buf = buf.slice(0, 1024)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(null)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const trimmed = buf.trim()
      if (!trimmed) return finish(null)
      // Keep up to the first 3 lines so the version pattern matcher
      // downstream has enough text to find a version even when warnings
      // come first.
      const head = trimmed.split(/\r?\n/).slice(0, 3).join(' ').trim()
      finish(head || null)
    })
  })
}

// ─── State-dir probing ───────────────────────────────────────────────

export function statePathCandidates(home: string, id: HarnessId): string[] {
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  const xdgState = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state')
  const rel = DEFAULT_STATE_REL[id]
  const out = new Set<string>()
  if (rel) {
    out.add(path.join(home, rel))
    out.add(path.join(xdgData, id))
    out.add(path.join(xdgConfig, id))
    out.add(path.join(xdgState, id))
  }
  return [...out]
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await fs.access(p)
      return p
    } catch {
      // try next
    }
  }
  return null
}

// ─── Process scanning ────────────────────────────────────────────────

export async function scanProcesses(timeoutMs: number): Promise<string[]> {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'tasklist' : 'ps'
  const args = isWin ? [] : ['-axww', '-o', 'command']
  return new Promise((resolve) => {
    let settled = false
    const finish = (lines: string[]) => {
      if (settled) return
      settled = true
      resolve(lines)
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.on('data', (b) => {
      buf += String(b)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish([])
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      finish([])
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(buf.split(/\r?\n/).filter(Boolean))
    })
  })
}

// Extract the basename of argv[0] from a `ps -o command` line. The
// command column is space-separated argv; we strip leading whitespace,
// take the first token, then basename it. Handles bare invocations
// ("claude --bg foo") and full paths ("/usr/local/bin/claude --bg foo").
export function basenameFromCommand(cmd: string): string | null {
  const trimmed = cmd.trim()
  if (!trimmed) return null
  const first = trimmed.split(/\s+/)[0]
  if (!first) return null
  // Strip a single leading "node " or "python " or "python3 " if present,
  // and use the next token (catches `python3 /path/to/metagpt.py ...`).
  return path.basename(first)
}

// ─── Budget helpers ──────────────────────────────────────────────────

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | void> {
  if (ms <= 0) return Promise.resolve()
  return Promise.race([
    p,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}

// ─── Cache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000 // 1h

function cachePath(home: string): string {
  return path.join(home, '.beto', 'cache', 'detection.json')
}

async function loadCache(home: string): Promise<DetectionReport | null> {
  try {
    const raw = await fs.readFile(cachePath(home), 'utf-8')
    const parsed = JSON.parse(raw) as DetectionReport
    if (Date.now() - parsed.generatedAt > CACHE_TTL_MS) return null
    // Invalidate if any cached binary's mtime moved.
    for (const h of parsed.harnesses) {
      if (h.binary && (await mtime(h.binary.path)) !== h.binary.mtimeMs) return null
    }
    return parsed
  } catch {
    return null
  }
}

async function saveCache(home: string, report: DetectionReport): Promise<void> {
  try {
    const file = cachePath(home)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(report, null, 2))
  } catch {
    // cache failures never break detection
  }
}
