// Cross-compile beto into single-file binaries for each release target.
//
// Run by GitHub Actions on tag push (.github/workflows/release.yml) and
// by developers manually via:
//   bun scripts/build-release.ts [target1 target2 ...]
// where targets default to all three of:
//   bun-darwin-arm64, bun-darwin-x64, bun-linux-x64
//
// The output is a directory of self-contained binaries that need no
// Bun installation to run. The companion install.sh installer fetches
// these from GitHub Releases.
//
// Why a programmatic Bun.build instead of `bun build --compile` CLI:
// the CLI's --external flag is honored in bundle mode but NOT in
// compile mode — a compiled binary must be self-contained. The same
// react-devtools-core stub plugin used by scripts/build.ts is needed
// here too. Hence the programmatic API + plugin.

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, 'dist-release')

const DEFAULT_TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64'] as const
type CompileTarget = (typeof DEFAULT_TARGETS)[number]

const requested = process.argv.slice(2)
const targets: readonly string[] =
  requested.length > 0 ? requested : (DEFAULT_TARGETS as readonly string[])

await fs.mkdir(outDir, { recursive: true })

const stubPlugin = {
  name: 'stub-ink-devtools',
  setup(build: import('bun').PluginBuilder) {
    // react-devtools-core: replace with no-op so Ink's optional dev
    // import doesn't pull in a 10MB package we never ship.
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'stub:react-devtools-core',
      namespace: 'stub',
    }))
    // Ink's ./devtools.js entry imports react-devtools-core at top
    // level. Alias the whole file to a stub.
    build.onResolve({ filter: /\/ink\/build\/devtools\.js$/ }, () => ({
      path: 'stub:ink-devtools',
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args: { path: string }) => {
      if (args.path === 'stub:react-devtools-core') {
        return {
          contents: `export default { connectToDevTools() {} };\n`,
          loader: 'js' as const,
        }
      }
      return { contents: `export {};\n`, loader: 'js' as const }
    })
  },
} satisfies import('bun').BunPlugin

interface Built {
  target: string
  outfile: string
  sizeBytes: number
  sha256: string
}

const built: Built[] = []

for (const target of targets) {
  const outName = target.replace(/^bun-/, 'beto-')
  const outfile = path.join(outDir, outName)
  process.stdout.write(`compiling ${target} → ${path.relative(root, outfile)}\n`)

  const result = await Bun.build({
    entrypoints: [path.join(root, 'src/cli.tsx')],
    target: 'bun',
    compile: { target: target as CompileTarget, outfile },
    plugins: [stubPlugin],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  // sha256 + size for the SHA256SUMS file the installer can verify.
  const bytes = await Bun.file(outfile).arrayBuffer()
  const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  built.push({
    target,
    outfile,
    sizeBytes: bytes.byteLength,
    sha256,
  })
  process.stdout.write(`  ${sha256.slice(0, 12)}…  ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB\n`)
}

// Write SHA256SUMS in the standard format consumed by `shasum -c`.
const sumsPath = path.join(outDir, 'SHA256SUMS')
const sumsBody = built
  .map(({ sha256, outfile }) => `${sha256}  ${path.basename(outfile)}`)
  .join('\n') + '\n'
await fs.writeFile(sumsPath, sumsBody)

process.stdout.write(`\n${built.length} binaries built in ${outDir}\n`)
for (const b of built) {
  process.stdout.write(`  ${path.basename(b.outfile)}  ${(b.sizeBytes / 1024 / 1024).toFixed(1)} MiB\n`)
}
process.stdout.write(`  SHA256SUMS  (${built.length} entries)\n`)
