// Color tokens for the terminal UI. Picked for legibility on both dark
// and light terminals — no background colors, just foreground hue + dim.
//
// The gold/yellow needs-input hue is the WoW-soul kept after dropping the
// HUD: aggro's three-tier needs-input ramp (awaiting → escalated → abandoned)
// maps onto color intensity (yellow → bright yellow → red), not animation
// (TUIs don't blink reliably across terminals).

import type { EscalationTier, SessionState } from '../lib/types.js'

// Ink color names (chalk-style). 'yellow' renders as a warm amber on
// most palettes; 'redBright' is reserved for danger/dead.
export const STATE_COLOR: Record<SessionState, string> = {
  working: 'cyan',
  'needs-input': 'yellow',
  idle: 'gray',
  completed: 'green',
  failed: 'red',
  stopped: 'gray',
  unknown: 'gray',
}

export const STATE_GLYPH: Record<SessionState, string> = {
  working: '●',
  'needs-input': '◉',
  idle: '○',
  completed: '✓',
  failed: '✗',
  stopped: '⊘',
  unknown: '?',
}

// Tier escalation ramp. None means not blocked.
export const TIER_COLOR: Record<EscalationTier, string> = {
  none: 'gray',
  awaiting: 'yellow',
  escalated: 'yellowBright',
  abandoned: 'redBright',
}

// Human label for tier — used on the row tail when blocked.
export const TIER_LABEL: Record<EscalationTier, string> = {
  none: '',
  awaiting: 'awaiting',
  escalated: 'escalated',
  abandoned: 'abandoned',
}
