// Inbox store. v0.2 holds rows per harness so a fresh adapter emit only
// replaces its own slice; rows from other adapters survive.
//
// `harnessFilter` is a transient UI filter — when non-null, only rows whose
// `harness` is in the set are surfaced. Cleared on each run; future v0.3
// may persist to ~/.beto/config.json.

import { create } from 'zustand'
import type {
  EscalationTier,
  HarnessId,
  SessionSnapshot,
} from '../lib/types.js'
import { deriveTier } from '../lib/needsInput.js'

export type InboxView = 'inbox' | 'peek' | 'dispatch'

export interface InboxState {
  // Per-harness row slices. Adapter emissions replace whole slices keyed
  // by their harness id. Derived flat list is computed by `flatRows()`.
  rowsByHarness: Record<HarnessId, SessionSnapshot[]>
  // Active filter — null means "all harnesses." A non-null set with N ids
  // surfaces only rows whose harness is in the set.
  harnessFilter: Set<HarnessId> | null
  // ms-epoch tick driving escalation timing. Refreshed every 5s so awaiting
  // → escalated → abandoned advances without source emissions.
  now: number
  view: InboxView
  peekId: string | null
  flash: { kind: 'ok' | 'err'; text: string } | null

  setHarnessRows(harness: HarnessId, rows: SessionSnapshot[]): void
  tick(): void
  peek(id: string | null): void
  openDispatch(): void
  closeOverlay(): void
  setFlash(f: InboxState['flash']): void
  // Cycle the harness filter through (all → first registered → ... → all).
  // `available` is the harness list from the registry, in registration
  // order, so the cycle is deterministic.
  cycleHarnessFilter(available: HarnessId[]): void
}

export const useInbox = create<InboxState>((set) => ({
  rowsByHarness: {} as Record<HarnessId, SessionSnapshot[]>,
  harnessFilter: null,
  now: Date.now(),
  view: 'inbox',
  peekId: null,
  flash: null,

  setHarnessRows: (harness, rows) =>
    set((s) => ({
      rowsByHarness: { ...s.rowsByHarness, [harness]: rows },
    })),

  tick: () => set({ now: Date.now() }),

  peek: (id) =>
    set({
      view: id ? 'peek' : 'inbox',
      peekId: id,
      flash: null,
    }),

  openDispatch: () => set({ view: 'dispatch', flash: null }),
  closeOverlay: () => set({ view: 'inbox', peekId: null, flash: null }),
  setFlash: (f) => set({ flash: f }),

  cycleHarnessFilter: (available) =>
    set((s) => {
      // Cycle: null (all) → {available[0]} → {available[1]} → ... → null.
      if (s.harnessFilter === null) {
        return available[0]
          ? { harnessFilter: new Set([available[0]]) }
          : { harnessFilter: null }
      }
      // Single-id filter: advance to the next id in `available`, or back to
      // null after the last one.
      const current = [...s.harnessFilter][0]
      const idx = current ? available.indexOf(current) : -1
      const next = available[idx + 1]
      return { harnessFilter: next ? new Set([next]) : null }
    }),
}))

// Flat list of all rows respecting the active filter. Cheap selector —
// flattens then optionally filters. Use this from React components.
export function flatRows(
  rowsByHarness: Record<HarnessId, SessionSnapshot[]>,
  filter: Set<HarnessId> | null,
): SessionSnapshot[] {
  const out: SessionSnapshot[] = []
  for (const rows of Object.values(rowsByHarness)) {
    if (!rows) continue
    for (const row of rows) {
      if (filter && !filter.has(row.harness)) continue
      out.push(row)
    }
  }
  out.sort((a, b) => {
    if (a.lastTransitionAt !== b.lastTransitionAt) {
      return b.lastTransitionAt - a.lastTransitionAt
    }
    return a.sessionId.localeCompare(b.sessionId)
  })
  return out
}

export interface InboxGroups {
  needsYou: Array<{ row: SessionSnapshot; tier: EscalationTier }>
  active: SessionSnapshot[]
  recent: SessionSnapshot[]
}

const TIER_ORDER: Record<EscalationTier, number> = {
  abandoned: 0,
  escalated: 1,
  awaiting: 2,
  none: 3,
}

export function groupRows(rows: SessionSnapshot[], now: number): InboxGroups {
  const needsYou: Array<{ row: SessionSnapshot; tier: EscalationTier }> = []
  const active: SessionSnapshot[] = []
  const recent: SessionSnapshot[] = []
  for (const row of rows) {
    if (row.state === 'needs-input') {
      needsYou.push({ row, tier: deriveTier(row, now) })
    } else if (row.state === 'working' || row.state === 'idle') {
      active.push(row)
    } else {
      recent.push(row)
    }
  }
  needsYou.sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    if (t !== 0) return t
    return a.row.lastTransitionAt - b.row.lastTransitionAt
  })
  active.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
  recent.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
  return { needsYou, active, recent: recent.slice(0, 8) }
}

// Per-harness row counts — drives the header tally "8 (4C 2X 1H 1G)".
export function countByHarness(
  rowsByHarness: Record<HarnessId, SessionSnapshot[]>,
): Record<HarnessId, number> {
  const out: Partial<Record<HarnessId, number>> = {}
  for (const [id, rows] of Object.entries(rowsByHarness)) {
    if (rows) out[id as HarnessId] = rows.length
  }
  return out as Record<HarnessId, number>
}
