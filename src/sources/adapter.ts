// Harness-agnostic data source contract.
//
// Each AI agent CLI (Claude Code, Codex, Hermes, Goose, etc.) provides its
// own session state through some mechanism — usually a directory of files
// under `~/.<provider>/`. An `Adapter` wraps one such mechanism and emits
// a normalized `SessionSnapshot[]` stream.
//
// The `HarnessRegistry` owns N adapters, holds each one's most recent
// emission as its slice of state, and fans the merged flat list to
// subscribers. Adding a new harness is one new adapter file + one
// registration call.

import type { HarnessId, SessionSnapshot } from '../lib/types.js'

export interface Adapter {
  readonly id: HarnessId
  readonly displayName: string
  // Begin watching/polling. Idempotent.
  start(): void
  // Stop watching/polling. After this, no more onChange callbacks fire.
  stop(): void
  // Subscribe to emissions. Returns an unsubscribe function. Implementations
  // should fire once immediately if they already have data so late
  // subscribers don't sit empty until the next change.
  onChange(fn: (rows: SessionSnapshot[]) => void): () => void
}

// Holds N adapters; merges their per-harness emissions into one flat list;
// fans the merged list to its own subscribers.
//
// Per-harness slices are stored by `id`, so a fresh emit from adapter X
// replaces only X's rows. Adapters are independent — Hermes being slow
// doesn't block Claude refreshes.
export class HarnessRegistry {
  private readonly adapters: Adapter[] = []
  private readonly slices = new Map<HarnessId, SessionSnapshot[]>()
  private readonly listeners = new Set<(rows: SessionSnapshot[]) => void>()
  private readonly unsubs: Array<() => void> = []
  private started = false

  add(adapter: Adapter): void {
    this.adapters.push(adapter)
    // Wire up the per-adapter subscription now so emissions start
    // populating slices the moment start() runs.
    const unsub = adapter.onChange((rows) => {
      this.slices.set(adapter.id, rows)
      this.fan()
    })
    this.unsubs.push(unsub)
  }

  // Convenience for registering many adapters at once.
  addAll(adapters: readonly Adapter[]): void {
    for (const a of adapters) this.add(a)
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const a of this.adapters) a.start()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    for (const a of this.adapters) a.stop()
    for (const u of this.unsubs) u()
    this.unsubs.length = 0
  }

  // Subscribe to the merged flat-row list. Fires once immediately with the
  // current merged state so late subscribers don't miss the most recent
  // snapshot.
  onChange(fn: (rows: SessionSnapshot[]) => void): () => void {
    this.listeners.add(fn)
    if (this.slices.size > 0) fn(this.flatten())
    return () => {
      this.listeners.delete(fn)
    }
  }

  // The list of registered harness ids — useful for the UI filter and the
  // header tally. Order matches adapter registration order.
  get harnessIds(): HarnessId[] {
    return this.adapters.map((a) => a.id)
  }

  // Per-harness row count. Used by the header for "8 (4C 2X 1H 1G)".
  countByHarness(): Record<HarnessId, number> {
    const out: Partial<Record<HarnessId, number>> = {}
    for (const [id, rows] of this.slices) out[id] = rows.length
    return out as Record<HarnessId, number>
  }

  private flatten(): SessionSnapshot[] {
    const all: SessionSnapshot[] = []
    for (const rows of this.slices.values()) all.push(...rows)
    // Stable: lastTransitionAt desc, then sessionId for tiebreak.
    all.sort((a, b) => {
      if (a.lastTransitionAt !== b.lastTransitionAt) {
        return b.lastTransitionAt - a.lastTransitionAt
      }
      return a.sessionId.localeCompare(b.sessionId)
    })
    return all
  }

  private fan(): void {
    const merged = this.flatten()
    for (const fn of this.listeners) fn(merged)
  }
}
