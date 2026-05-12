import type { EscalationTier, SessionSnapshot } from './types.js'

// Ported verbatim from aggro/src/state/needsInput.ts. The escalation
// thresholds are aggro's deep-research finding: equal-weight blocked
// rows bury urgent asks under stale ones. The ramp surfaces older
// "needs you" rows louder over time.
//
//   awaiting   (0–60s)    fresh; user will notice naturally
//   escalated  (1m–5m)    actively waiting on you
//   abandoned  (5m+)      demands intervention
export function deriveTier(s: SessionSnapshot, now: number): EscalationTier {
  if (s.state !== 'needs-input') return 'none'
  if (!s.lastTransitionAt) return 'awaiting'
  const elapsed = now - s.lastTransitionAt
  if (elapsed >= 5 * 60 * 1000) return 'abandoned'
  if (elapsed >= 60 * 1000) return 'escalated'
  return 'awaiting'
}

// Human-readable "blocked for 2m 14s" — only used for needs-input rows.
// Returns empty string for rows that aren't blocked or have no timestamp.
export function formatBlockedFor(s: SessionSnapshot, now: number): string {
  if (s.state !== 'needs-input' || !s.lastTransitionAt) return ''
  const elapsed = Math.max(0, now - s.lastTransitionAt)
  const total = Math.floor(elapsed / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s_ = total % 60
  if (m < 60) return s_ === 0 ? `${m}m` : `${m}m ${s_}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
