// MockAdapter: a synthetic adapter that wraps a directory of state-shaped
// JSON files and emits them under a given harness id. Used by:
//
//   - scripts/seed-mock-jobs.ts (seeds per-harness directories)
//   - scripts/preview-frame.tsx (renders multi-harness rows at three widths)
//   - test/render.test.tsx (multi-harness UI tests without real harnesses)
//
// Production adapters (CodexAdapter, HermesAdapter, ...) will each read
// their own native format. This mock only exists so the UI layer can be
// developed and verified before those adapters ship.

import { ClaudeAdapter } from './state.js'
import type { Adapter } from './adapter.js'
import type { HarnessId, SessionSnapshot } from '../lib/types.js'

export interface MockAdapterOptions {
  id: HarnessId
  // Directory of `<sessionId>/state.json` files in the same shape as
  // Claude's. The state.json parser is reused; only the emitted harness
  // id changes.
  dir: string
  // Poll cadence; default 2s.
  pollMs?: number
  // Override the clock for tests.
  now?: () => number
}

// Wraps ClaudeAdapter and rewrites the harness id on emit. The parser is
// shared because Claude's state.json schema is permissive enough to serve
// as the lingua franca for mock data.
export class MockAdapter implements Adapter {
  readonly id: HarnessId
  readonly displayName: string
  private readonly inner: ClaudeAdapter
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private unsubInner: (() => void) | null = null

  constructor(opts: MockAdapterOptions) {
    this.id = opts.id
    this.displayName = `mock:${opts.id}`
    this.inner = new ClaudeAdapter({
      jobsDir: opts.dir,
      pollMs: opts.pollMs,
      now: opts.now,
    })
  }

  start(): void {
    this.unsubInner = this.inner.onChange((rows) => {
      const tagged = rows.map((r) => ({ ...r, harness: this.id }))
      for (const fn of this.listeners) fn(tagged)
    })
    this.inner.start()
  }

  stop(): void {
    if (this.unsubInner) this.unsubInner()
    this.unsubInner = null
    this.inner.stop()
  }

  onChange(fn: (rows: SessionSnapshot[]) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // Manual scan trigger — useful for tests/preview where the polling loop
  // is overkill.
  async scan(): Promise<SessionSnapshot[]> {
    const rows = await this.inner.scan()
    return rows.map((r) => ({ ...r, harness: this.id }))
  }
}
