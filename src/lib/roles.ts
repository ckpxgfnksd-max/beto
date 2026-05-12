import type { Role } from './types.js'

// Deterministic role inference from name. Stable across runs (same name
// always gets the same role) so the row glyph doesn't flicker. Inherited
// from aggro's flavor system — the WoW-soul that survives the HUD-drop.
const ROLES: Role[] = ['executor', 'planner', 'validator', 'researcher']

export function inferRole(name: string): Role {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return ROLES[h % ROLES.length]!
}

// Compact glyph for the role column. Mono-width on all terminals; no
// emoji surprises in font fallback hell.
export const ROLE_GLYPH: Record<Role, string> = {
  executor: '⚔',
  planner: '◈',
  validator: '◇',
  researcher: '✦',
}

// Three-letter short role label for the per-row badge.
export const ROLE_SHORT: Record<Role, string> = {
  executor: 'EXE',
  planner: 'PLN',
  validator: 'VAL',
  researcher: 'RSR',
}
