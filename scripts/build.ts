// Custom build script.
//
// Bun's CLI bundler statically resolves Ink's `react-devtools-core`
// dynamic import even though Ink guards it behind `process.env.DEV ===
// 'true'`. That balloons the dist with a 10MB dev-only dependency we
// never ship. This script aliases the import to an empty stub so the
// dist runs anywhere — including machines that never installed the
// devtools package.
//
// Also aliases `./devtools.js` (Ink's internal devtools entry) to a
// stub so the static analyzer can't pull it in transitively.

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const result = await Bun.build({
  entrypoints: [path.join(root, 'src/cli.tsx')],
  outdir: path.join(root, 'dist'),
  naming: 'cli.js',
  target: 'node',
  banner: '#!/usr/bin/env node',
  plugins: [
    {
      name: 'stub-ink-devtools',
      setup(build) {
        // react-devtools-core: replace with no-op so the static import
        // in Ink's devtools.js resolves to nothing at runtime.
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'stub:react-devtools-core',
          namespace: 'stub',
        }))
        // Ink's devtools.js itself imports react-devtools-core at the
        // top level. Alias the whole file to a stub so the runtime
        // never even tries to call connectToDevTools.
        build.onResolve({ filter: /\/ink\/build\/devtools\.js$/ }, () => ({
          path: 'stub:ink-devtools',
          namespace: 'stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'stub:react-devtools-core') {
            return {
              contents: `export default { connectToDevTools() {} };\n`,
              loader: 'js',
            }
          }
          // stub:ink-devtools — Ink calls connectToDevTools() at module
          // load via `import './devtools.js'`. Render a no-op default
          // import so the optional path stays optional.
          return { contents: `export {};\n`, loader: 'js' }
        })
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// chmod +x so the shebang is honored when the bin is invoked directly.
const outPath = path.join(root, 'dist', 'cli.js')
const { chmodSync } = await import('node:fs')
chmodSync(outPath, 0o755)

const stat = await Bun.file(outPath).stat()
process.stdout.write(`built ${outPath} (${(stat.size / 1024).toFixed(0)} KB)\n`)
