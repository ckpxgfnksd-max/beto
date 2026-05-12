// Color tokens for the terminal UI. Picked for legibility on both dark
// and light terminals — no background colors, just foreground hue + dim.
//
// The gold/yellow needs-input hue is the WoW-soul kept after dropping the
// HUD: aggro's three-tier needs-input ramp (awaiting → escalated → abandoned)
// maps onto color intensity (yellow → bright yellow → red), not animation
// (TUIs don't blink reliably across terminals).

import type { BuiltInHarnessId, EscalationTier, HarnessId, SessionState } from '../lib/types.js'

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
export const HARNESS_SIGIL: Record<BuiltInHarnessId, string> = {
  claude: 'C',
  codex: 'X',
  hermes: 'H',
  goose: 'G',
  kimi: 'K',
  openclaw: 'O',
  openhands: 'D',
  aider: 'A',
  'open-interpreter': 'I',
  crewai: 'W', // creW
  metagpt: 'M',
}

// Display name per harness — header tooltip + peek panel.
export const HARNESS_NAME: Record<BuiltInHarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  goose: 'Goose',
  kimi: 'Kimi',
  openclaw: 'OpenClaw',
  openhands: 'OpenHands',
  aider: 'Aider',
  'open-interpreter': 'Open Interpreter',
  crewai: 'Crew AI',
  metagpt: 'MetaGPT',
}

// Per-harness accent color. Used to tint the sigil so the eye can scan
// harness-mix at a glance without reading the letter.
export const HARNESS_COLOR: Record<BuiltInHarnessId, string> = {
  claude: 'magentaBright',
  codex: 'green',
  hermes: 'blueBright',
  goose: 'cyan',
  kimi: 'yellowBright',
  openclaw: 'red',
  openhands: 'whiteBright',
  aider: 'gray',
  'open-interpreter': 'magenta',
  crewai: 'greenBright',
  metagpt: 'blue',
}

// Dynamic lookups for plugin-registered harnesses. The PluginManifest
// (src/lib/manifest.ts) carries optional sigil/color/displayName fields;
// once the registry instantiates a plugin, we shove those into these
// override maps so the UI looks up uniformly via the helpers below.
// Order of precedence: override map > built-in record > generic fallback.
const SIGIL_OVERRIDES = new Map<HarnessId, string>()
const NAME_OVERRIDES = new Map<HarnessId, string>()
const COLOR_OVERRIDES = new Map<HarnessId, string>()

export function registerHarnessTheme(theme: {
  id: HarnessId
  sigil?: string
  color?: string
  displayName?: string
}): void {
  if (theme.sigil) SIGIL_OVERRIDES.set(theme.id, theme.sigil)
  if (theme.color) COLOR_OVERRIDES.set(theme.id, theme.color)
  if (theme.displayName) NAME_OVERRIDES.set(theme.id, theme.displayName)
}

export function sigilFor(id: HarnessId): string {
  const fromOverride = SIGIL_OVERRIDES.get(id)
  if (fromOverride) return fromOverride
  const fromBuiltIn = (HARNESS_SIGIL as Record<string, string>)[id]
  if (fromBuiltIn) return fromBuiltIn
  return id.charAt(0).toUpperCase() || '?'
}

export function colorFor(id: HarnessId): string {
  return (
    COLOR_OVERRIDES.get(id) ??
    (HARNESS_COLOR as Record<string, string>)[id] ??
    'gray'
  )
}

export function nameFor(id: HarnessId): string {
  return (
    NAME_OVERRIDES.get(id) ??
    (HARNESS_NAME as Record<string, string>)[id] ??
    id
  )
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
