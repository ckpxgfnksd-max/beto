import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { autoDetect, configPath, loadOrInitConfig, writeConfig } from '../src/lib/config.js'

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'beto-cfg-'))
}

describe('config', () => {
  it('configPath puts the file under ~/.beto/', async () => {
    const home = await tempHome()
    expect(configPath({ home })).toBe(path.join(home, '.beto', 'config.json'))
  })

  it('autoDetect flags only the present harness directories', async () => {
    const home = await tempHome()
    await fs.mkdir(path.join(home, '.claude', 'jobs'), { recursive: true })
    await fs.mkdir(path.join(home, '.hermes'), { recursive: true })

    const cfg = await autoDetect({ home })
    expect(cfg.harnesses.claude.enabled).toBe(true)
    expect(cfg.harnesses.hermes.enabled).toBe(true)
    expect(cfg.harnesses.codex.enabled).toBe(false)
    expect(cfg.harnesses.goose.enabled).toBe(false)
    // Aider has no central path → always disabled in auto-detect.
    expect(cfg.harnesses.aider.enabled).toBe(false)
  })

  it('loadOrInitConfig writes a fresh config on first run', async () => {
    const home = await tempHome()
    await fs.mkdir(path.join(home, '.claude', 'jobs'), { recursive: true })

    const cfg = await loadOrInitConfig({ home })
    expect(cfg.harnesses.claude.enabled).toBe(true)

    // File should now exist on disk.
    const onDisk = await fs.readFile(configPath({ home }), 'utf-8')
    const parsed = JSON.parse(onDisk)
    expect(parsed.harnesses.claude.enabled).toBe(true)
  })

  it('loadOrInitConfig round-trips an existing config', async () => {
    const home = await tempHome()
    await writeConfig(
      {
        version: 1,
        harnesses: {
          claude: { enabled: true, path: '/custom/path' },
          codex: { enabled: true },
          hermes: { enabled: false },
          goose: { enabled: false },
          kimi: { enabled: false },
          openclaw: { enabled: false },
          openhands: { enabled: false },
          aider: { enabled: false },
          'open-interpreter': { enabled: false },
          crewai: { enabled: false },
          metagpt: { enabled: false },
        },
      },
      { home },
    )
    const cfg = await loadOrInitConfig({ home })
    expect(cfg.harnesses.claude.path).toBe('/custom/path')
    expect(cfg.harnesses.codex.enabled).toBe(true)
  })

  it('returns safe defaults when the file is unreadable JSON', async () => {
    const home = await tempHome()
    await fs.mkdir(path.join(home, '.beto'), { recursive: true })
    await fs.writeFile(configPath({ home }), '{not valid')

    const cfg = await loadOrInitConfig({ home })
    // claude default: enabled. Everything else: disabled.
    expect(cfg.harnesses.claude.enabled).toBe(true)
    expect(cfg.harnesses.codex.enabled).toBe(false)
  })
})
