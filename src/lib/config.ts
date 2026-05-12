// beto config: ~/.beto/config.json.
//
// Per-harness enable flag + optional path override. On first run we
// auto-detect by checking for the canonical directory each harness writes
// to (`~/.claude/`, `~/.codex/`, etc.) — present → enabled, absent →
// disabled. Disabled harnesses do not instantiate their adapter, so
// importing a SQLite adapter does no work if you don't have Codex.
//
// The config is intentionally tiny and JSON. Edit it by hand for now;
// future v0.3 lifts to a `beto config` CLI subcommand.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { HARNESS_IDS, type HarnessId } from './types.js'
import { detect, type DetectionReport } from './detect.js'

export interface HarnessConfig {
  enabled: boolean
  // Override the default path. Useful for testing or for users who put
  // ~/.<provider>/ somewhere non-standard (XDG_DATA_HOME etc).
  path?: string
}

export interface NotificationsConfig {
  // Master switch. When unset, defaults to true on macOS/Linux.
  enabled: boolean
  // Audible cue on each notification. Default false.
  sound: boolean
}

export interface BetoConfig {
  harnesses: Record<HarnessId, HarnessConfig>
  notifications?: NotificationsConfig
  version: 1
}

const CONFIG_VERSION: 1 = 1

// Canonical home-relative path each adapter looks at by default. v0.2 only
// reads `~/.claude/`; the other entries are presence-probes for the
// auto-detect logic. v0.2.1 prefers the richer detect.ts probe (PATH +
// state-dir + process scan), but keeps these as a fallback for cases
// where detect.ts can't run (e.g., no PATH).
const DEFAULT_PATHS: Record<HarnessId, string> = {
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

export interface ConfigPaths {
  // Override $HOME for testing.
  home?: string
}

function homeDir(p?: ConfigPaths): string {
  return p?.home ?? os.homedir()
}

export function configPath(p?: ConfigPaths): string {
  return path.join(homeDir(p), '.beto', 'config.json')
}

// Load config from disk. On first run, write a config built from
// auto-detect probes and return that. Failures (parse errors etc.) emit
// a stderr warning and return a safe default (claude on, everything else
// off).
export async function loadOrInitConfig(p?: ConfigPaths): Promise<BetoConfig> {
  const file = configPath(p)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as BetoConfig
    return mergeWithDefaults(parsed)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      const cfg = await autoDetect(p)
      await writeConfig(cfg, p)
      return cfg
    }
    process.stderr.write(`beto: config ${file} unreadable (${String(e)}); using defaults\n`)
    return mergeWithDefaults({})
  }
}

export async function writeConfig(cfg: BetoConfig, p?: ConfigPaths): Promise<void> {
  const file = configPath(p)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n')
}

// Build a config by probing for each harness. v0.2.1: prefers the rich
// layered detector (PATH + state-dir + process scan) and falls back to
// the simple state-dir probe if detection fails. A harness is enabled
// when status is anything except 'absent' — installed-but-no-state still
// counts so the row sigil is reserved and the user sees the slot.
export async function autoDetect(p?: ConfigPaths): Promise<BetoConfig> {
  const home = homeDir(p)
  const harnesses: Partial<Record<HarnessId, HarnessConfig>> = {}

  let report: DetectionReport | null = null
  try {
    report = await detect({ home })
  } catch {
    // Detection is best-effort; fall through to the simple probe below.
  }

  for (const id of HARNESS_IDS) {
    if (report) {
      const detected = report.harnesses.find((h) => h.id === id)
      const enabled = !!detected && detected.status !== 'absent'
      const cfg: HarnessConfig = { enabled }
      if (detected?.stateDir) cfg.path = detected.stateDir
      harnesses[id] = cfg
    } else {
      const rel = DEFAULT_PATHS[id]
      const candidate = rel ? path.join(home, rel) : ''
      const exists = rel ? await pathExists(candidate) : false
      harnesses[id] = { enabled: exists }
    }
  }
  return {
    version: CONFIG_VERSION,
    harnesses: harnesses as Record<HarnessId, HarnessConfig>,
    notifications: defaultNotifications(),
  }
}

function mergeWithDefaults(cfg: Partial<BetoConfig>): BetoConfig {
  const harnesses: Partial<Record<HarnessId, HarnessConfig>> = {}
  for (const id of HARNESS_IDS) {
    harnesses[id] = cfg.harnesses?.[id] ?? { enabled: id === 'claude' }
  }
  return {
    version: CONFIG_VERSION,
    harnesses: harnesses as Record<HarnessId, HarnessConfig>,
    notifications: cfg.notifications ?? defaultNotifications(),
  }
}

function defaultNotifications(): NotificationsConfig {
  // Enable on platforms where the OS notification path exists; let
  // users on Windows opt-in via config edit when they want it.
  return {
    enabled: process.platform === 'darwin' || process.platform === 'linux',
    sound: false,
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
