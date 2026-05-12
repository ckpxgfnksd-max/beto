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

export interface HarnessConfig {
  enabled: boolean
  // Override the default path. Useful for testing or for users who put
  // ~/.<provider>/ somewhere non-standard (XDG_DATA_HOME etc).
  path?: string
}

export interface BetoConfig {
  harnesses: Record<HarnessId, HarnessConfig>
  version: 1
}

const CONFIG_VERSION: 1 = 1

// Canonical home-relative path each adapter looks at by default. v0.2 only
// reads `~/.claude/`; the other entries are presence-probes for the
// auto-detect logic.
const DEFAULT_PATHS: Record<HarnessId, string> = {
  claude: '.claude/jobs',
  codex: '.codex',
  hermes: '.hermes',
  goose: '.local/share/goose/sessions',
  kimi: '.kimi',
  openclaw: '.openclaw',
  openhands: '.openhands',
  aider: '', // per-repo, not centralized
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
    return mergeWithDefaults({ harnesses: { claude: { enabled: true } } } as BetoConfig)
  }
}

export async function writeConfig(cfg: BetoConfig, p?: ConfigPaths): Promise<void> {
  const file = configPath(p)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n')
}

// Build a config by probing for each harness's home directory. Present →
// enabled, absent → disabled. Aider always disabled in auto-detect because
// it's per-repo and has no central state to read in v0.2.
export async function autoDetect(p?: ConfigPaths): Promise<BetoConfig> {
  const home = homeDir(p)
  const harnesses: Partial<Record<HarnessId, HarnessConfig>> = {}
  for (const id of HARNESS_IDS) {
    const rel = DEFAULT_PATHS[id]
    if (!rel) {
      harnesses[id] = { enabled: false }
      continue
    }
    const candidate = path.join(home, rel)
    const exists = await pathExists(candidate)
    // v0.2 only the claude adapter actually reads a path. For others, the
    // 'enabled' flag is reserved for v0.3+; until then, even an enabled
    // codex entry simply means "I'd want it on, no adapter yet."
    harnesses[id] = { enabled: exists }
  }
  return { version: CONFIG_VERSION, harnesses: harnesses as Record<HarnessId, HarnessConfig> }
}

function mergeWithDefaults(cfg: Partial<BetoConfig>): BetoConfig {
  const harnesses: Partial<Record<HarnessId, HarnessConfig>> = {}
  for (const id of HARNESS_IDS) {
    harnesses[id] = cfg.harnesses?.[id] ?? { enabled: id === 'claude' }
  }
  return { version: CONFIG_VERSION, harnesses: harnesses as Record<HarnessId, HarnessConfig> }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
