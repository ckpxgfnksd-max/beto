// Plugin loader. Reads every `*.json` under ~/.beto/plugins/ (and an
// optional bundled-manifests directory shipped with the repo), validates
// each, and constructs an Adapter for each valid one.
//
// Failure mode: a broken manifest emits a stderr warning and is skipped.
// The rest of the inbox keeps working. This is the "open with timeouts"
// posture — anyone can drop a manifest, no curation gate.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Adapter } from '../sources/adapter.js'
import {
  validateManifest,
  type PluginManifest,
  type ValidationError,
} from './manifest.js'
import { DirectoryOfStateJsonAdapter } from '../sources/kinds/directoryOfStateJson.js'
import { SqliteSessionsTableAdapter } from '../sources/kinds/sqliteSessionsTable.js'
import { JsonlTailAdapter } from '../sources/kinds/jsonlTail.js'
import { ProcessWatchOnlyAdapter } from '../sources/kinds/processWatchOnly.js'
import { registerHarnessTheme } from '../ui/theme.js'

export interface LoadedPlugin {
  manifest: PluginManifest
  adapter: Adapter
  sourcePath: string
}

export interface LoadFailure {
  sourcePath: string
  errors: ValidationError[] | string
}

export interface LoadResult {
  loaded: LoadedPlugin[]
  failures: LoadFailure[]
}

export interface LoadOptions {
  home?: string
  // Additional directories to scan after ~/.beto/plugins/. Used for
  // `manifests/` shipped with the repo so first-time users get reference
  // adapters without a separate install step.
  extraDirs?: string[]
}

export async function loadPlugins(opts: LoadOptions = {}): Promise<LoadResult> {
  const home = opts.home ?? os.homedir()
  const dirs = [path.join(home, '.beto', 'plugins'), ...(opts.extraDirs ?? [])]
  const loaded: LoadedPlugin[] = []
  const failures: LoadFailure[] = []
  const seenIds = new Set<string>()

  for (const dir of dirs) {
    const entries = await readManifestFiles(dir)
    for (const file of entries) {
      let raw: unknown
      try {
        const text = await fs.readFile(file, 'utf-8')
        raw = JSON.parse(text)
      } catch (e) {
        failures.push({ sourcePath: file, errors: `parse: ${String(e)}` })
        continue
      }
      const result = validateManifest(raw)
      if (!result.ok || !result.manifest) {
        failures.push({ sourcePath: file, errors: result.errors })
        continue
      }
      // First manifest wins — user's ~/.beto/plugins/ overrides shipped
      // defaults. We scan user dirs first.
      if (seenIds.has(result.manifest.id)) continue
      seenIds.add(result.manifest.id)
      try {
        const adapter = buildAdapter(result.manifest)
        registerHarnessTheme({
          id: result.manifest.id,
          sigil: result.manifest.sigil,
          color: result.manifest.color,
          displayName: result.manifest.displayName,
        })
        loaded.push({ manifest: result.manifest, adapter, sourcePath: file })
      } catch (e) {
        failures.push({ sourcePath: file, errors: `instantiate: ${String(e)}` })
      }
    }
  }
  return { loaded, failures }
}

async function readManifestFiles(dir: string): Promise<string[]> {
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => path.join(dir, n))
    .sort()
}

// Instantiate the right adapter class for a validated manifest. This is
// the only place the manifest-kind → adapter-class mapping lives.
export function buildAdapter(manifest: PluginManifest): Adapter {
  const common = {
    id: manifest.id,
    displayName: manifest.displayName,
    pollMs: manifest.pollMs,
    readBudgetMs: manifest.readBudgetMs,
  }
  switch (manifest.adapter.kind) {
    case 'directory-of-state-json':
      return new DirectoryOfStateJsonAdapter({
        ...common,
        config: manifest.adapter.config,
      })
    case 'sqlite-sessions-table':
      return new SqliteSessionsTableAdapter({
        ...common,
        config: manifest.adapter.config,
      })
    case 'jsonl-tail':
      return new JsonlTailAdapter({
        ...common,
        config: manifest.adapter.config,
      })
    case 'process-watch-only':
      return new ProcessWatchOnlyAdapter({
        ...common,
        binary: manifest.binary,
        config: manifest.adapter.config,
      })
  }
}
