import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadPlugins } from '../src/lib/plugins.js'

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'beto-plugins-'))
}

async function writePlugin(home: string, name: string, body: object): Promise<void> {
  const dir = path.join(home, '.beto', 'plugins')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), JSON.stringify(body))
}

describe('loadPlugins', () => {
  it('returns empty when ~/.beto/plugins is missing', async () => {
    const home = await tempHome()
    const result = await loadPlugins({ home })
    expect(result.loaded).toHaveLength(0)
    expect(result.failures).toHaveLength(0)
  })

  it('loads a valid manifest and instantiates an adapter', async () => {
    const home = await tempHome()
    await writePlugin(home, 'fake.json', {
      id: 'fake',
      displayName: 'Fake',
      binary: 'fake',
      adapter: {
        kind: 'process-watch-only',
        config: {},
      },
    })
    const result = await loadPlugins({ home })
    expect(result.loaded).toHaveLength(1)
    expect(result.loaded[0]!.manifest.id).toBe('fake')
    expect(result.loaded[0]!.adapter.id).toBe('fake')
    expect(result.failures).toHaveLength(0)
  })

  it('reports a failure for invalid JSON without crashing', async () => {
    const home = await tempHome()
    const dir = path.join(home, '.beto', 'plugins')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'bad.json'), '{not-json')
    const result = await loadPlugins({ home })
    expect(result.loaded).toHaveLength(0)
    expect(result.failures).toHaveLength(1)
  })

  it('reports a failure for a manifest with validation errors', async () => {
    const home = await tempHome()
    await writePlugin(home, 'broken.json', { id: 'fake' /* missing everything else */ })
    const result = await loadPlugins({ home })
    expect(result.loaded).toHaveLength(0)
    expect(result.failures).toHaveLength(1)
    expect(Array.isArray(result.failures[0]?.errors)).toBe(true)
  })

  it('user manifest overrides bundled one with same id', async () => {
    const home = await tempHome()
    const bundled = await tempHome()
    // bundled "extra dir" contains a plugin
    const bundledDir = path.join(bundled, 'manifests')
    await fs.mkdir(bundledDir, { recursive: true })
    await fs.writeFile(
      path.join(bundledDir, 'fake.json'),
      JSON.stringify({
        id: 'fake',
        displayName: 'Fake (bundled)',
        binary: 'fake',
        adapter: { kind: 'process-watch-only', config: {} },
      }),
    )
    // user dir overrides with a different displayName
    await writePlugin(home, 'fake.json', {
      id: 'fake',
      displayName: 'Fake (user)',
      binary: 'fake',
      adapter: { kind: 'process-watch-only', config: {} },
    })
    const result = await loadPlugins({ home, extraDirs: [bundledDir] })
    expect(result.loaded).toHaveLength(1)
    expect(result.loaded[0]!.manifest.displayName).toBe('Fake (user)')
  })

  it('loads multiple manifests in sorted order', async () => {
    const home = await tempHome()
    await writePlugin(home, 'b.json', {
      id: 'beta',
      displayName: 'Beta',
      binary: 'b',
      adapter: { kind: 'process-watch-only', config: {} },
    })
    await writePlugin(home, 'a.json', {
      id: 'alpha',
      displayName: 'Alpha',
      binary: 'a',
      adapter: { kind: 'process-watch-only', config: {} },
    })
    const result = await loadPlugins({ home })
    expect(result.loaded.map((p) => p.manifest.id)).toEqual(['alpha', 'beta'])
  })
})
