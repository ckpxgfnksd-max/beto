// Color tokens for the terminal UI. Picked for legibility on both dark
// and light terminals — no background colors, just foreground hue + dim.
//
// The gold/yellow needs-input hue is the WoW-soul kept after dropping the
// HUD: aggro's three-tier needs-input ramp (awaiting → escalated → abandoned)
// maps onto color intensity (yellow → bright yellow → red), not animation
// (TUIs don't blink reliably across terminals).

import type { EscalationTier, HarnessId, SessionState } from '../lib/types.js'

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

// Single-character sigil per harness. Picked for visual distinctness and
// no false-friends with state glyphs. Mono-width on all terminals.
export const HARNESS_SIGIL: Record<HarnessId, string> = {
  claude: 'C',
  codex: 'X',
  hermes: 'H',
  goose: 'G',
  kimi: 'K',
  openclaw: 'O',
  openhands: 'D',
  aider: 'A',
}

// Display name per harness — header tooltip + peek panel.
export const HARNESS_NAME: Record<HarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  goose: 'Goose',
  kimi: 'Kimi',
  openclaw: 'OpenClaw',
  openhands: 'OpenHands',
  aider: 'Aider',
}

// Per-harness accent color. Used to tint the sigil so the eye can scan
// harness-mix at a glance without reading the letter.
export const HARNESS_COLOR: Record<HarnessId, string> = {
  claude: 'magentaBright', // Anthropic accent
  codex: 'green', // OpenAI green
  hermes: 'blueBright', // Nous Hermes
  goose: 'cyan', // Block Goose
  kimi: 'yellowBright', // Moonshot Kimi
  openclaw: 'red', // OpenClaw
  openhands: 'whiteBright', // OpenHands
  aider: 'gray', // Aider
}

// Layout-mode breakpoints (terminal columns).
//   < ULTRA → ultra-compact single line, no summary
//   < SIDEBAR → sidebar (2-line, summary truncated to width)
//   ≥ SIDEBAR → wide v0.1 layout
export const WIDTH_ULTRA = 50
export const WIDTH_SIDEBAR = 80
export type LayoutMode = 'ultra' | 'sidebar' | 'wide'
export function pickLayout(cols: number): LayoutMode {
  if (cols < WIDTH_ULTRA) return 'ultra'
  if (cols < WIDTH_SIDEBAR) return 'sidebar'
  return 'wide'
}
