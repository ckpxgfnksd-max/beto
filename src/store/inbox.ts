// Inbox store. v0 carries one data source — state.json — and groups rows
// for the inbox UI. Three-source precedence (state.json + hooks + transcript)
// from aggro is preserved as a future extension surface: when the hooks
// adapter ports in, it joins as a per-session enrichment layer.

import { create } from 'zustand'
import type { EscalationTier, SessionSnapshot } from '../lib/types.js'
import { deriveTier } from '../lib/needsInput.js'

export type InboxView = 'inbox' | 'peek' | 'dispatch'

export interface InboxState {
  rows: SessionSnapshot[]
  // ms-epoch tick that drives escalation timing. Refreshed every 5s so the
  // UI advances awaiting → escalated → abandoned without the data source
  // emitting anything new.
  now: number
  view: InboxView
  // sessionId currently peeked, or null. Used by the peek panel + reply.
  peekId: string | null
  // Transient status banner: dispatch success, attach error, etc. Cleared
  // on next view change.
  flash: { kind: 'ok' | 'err'; text: string } | null

  // Mutators.
  setRows(rows: SessionSnapshot[]): void
  tick(): void
  peek(id: string | null): void
  openDispatch(): void
  closeOverlay(): void
  setFlash(f: InboxState['flash']): void
}

export const useInbox = create<InboxState>((set) => ({
  rows: [],
  now: Date.now(),
  view: 'inbox',
  peekId: null,
  flash: null,
  setRows: (rows) => set({ rows }),
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
}))

// Derived: rows split into the four list buckets the inbox renders.
// 'needs you' is sorted by escalation tier (abandoned first), then by
// lastTransitionAt. Active is sorted by lastTransitionAt desc. Recent
// (completed / failed / stopped) is capped to 8 rows so the inbox doesn't
// grow unbounded.
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
      // completed / failed / stopped / unknown
      recent.push(row)
    }
  }
  needsYou.sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    if (t !== 0) return t
    return a.row.lastTransitionAt - b.row.lastTransitionAt // older first
  })
  active.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
  recent.sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
  return { needsYou, active, recent: recent.slice(0, 8) }
}
