// Declarative state inference engine.
//
// Adapters that read raw events / rows pass a set of `scopes` (named
// records, e.g. `{tail: {...}, head: {...}}` for jsonl-tail or
// `{session: {...}, latestMessage: {...}}` for sqlite-sessions-table)
// plus a list of StateInferenceRule from the manifest. The first
// matching rule's `mapsTo` wins. Returns null when no rule matches —
// the caller then falls back to its default heuristic.
//
// Predicate vocabulary (all keys in `when` are AND-combined):
//   equals:   dotted-path → required string value (String() coerced)
//   present:  dotted-path must resolve to a non-empty value
//   absent:   dotted-path must resolve to nothing / empty
//   minAgeMs: (now - lastTransitionAt) ≥ this many ms
//   against:  jsonl-tail scope selector (default 'tail')
//
// Dotted paths may be scoped (`latestMessage.completed_at`) or
// unscoped (`payload.type`). The first segment is matched against
// scope names; if no match, the default scope is used. The default is
// the rule's `against` (when present, jsonl-tail) or the only scope
// supplied (sqlite case).

import type { SessionState } from '../lib/types.js'
import type { StateInferenceRule } from '../lib/manifest.js'
import { readDotted, isPresent, toStringOrEmpty } from './dotted.js'

export type Scopes = Record<string, Record<string, unknown> | null | undefined>

export interface ApplyOptions {
  // Wall clock for minAgeMs comparisons. Defaults to Date.now().
  now?: number
  // Baseline time used for `now - lastTransitionAt`.
  lastTransitionAt?: number
  // Scope to use when a dotted path's first segment isn't a known
  // scope name. For jsonl-tail this is the rule's `against` value (or
  // 'tail'). For sqlite this is whatever the adapter passes (usually
  // 'session').
  defaultScope?: string
}

export function applyStateInference(
  rules: readonly StateInferenceRule[] | undefined,
  scopes: Scopes,
  opts: ApplyOptions = {},
): SessionState | null {
  if (!rules || rules.length === 0) return null
  for (const rule of rules) {
    if (matches(rule, scopes, opts)) return rule.mapsTo
  }
  return null
}

function matches(
  rule: StateInferenceRule,
  scopes: Scopes,
  opts: ApplyOptions,
): boolean {
  const w = rule.when
  const scope = rule.when.against ?? opts.defaultScope
  const resolve = (path: string): unknown =>
    resolveScoped(scopes, path, scope)

  if (w.equals) {
    for (const [path, expected] of Object.entries(w.equals)) {
      const actual = toStringOrEmpty(resolve(path))
      if (actual !== expected) return false
    }
  }
  if (w.present) {
    for (const path of w.present) {
      if (!isPresent(resolve(path))) return false
    }
  }
  if (w.absent) {
    for (const path of w.absent) {
      if (isPresent(resolve(path))) return false
    }
  }
  if (w.minAgeMs != null) {
    const now = opts.now ?? Date.now()
    const last = opts.lastTransitionAt ?? 0
    // If we have no baseline, treat as "age = infinity" so minAgeMs
    // rules can still fire. This is what jsonl-tail wants for "stale
    // file with no terminator → idle" cases.
    const age = last > 0 ? now - last : Number.POSITIVE_INFINITY
    if (age < w.minAgeMs) return false
  }
  return true
}

// Resolve a possibly-scoped dotted path.
// If the first segment matches a scope name, descend into that record.
// Otherwise fall back to the default scope.
function resolveScoped(
  scopes: Scopes,
  path: string,
  defaultScope: string | undefined,
): unknown {
  if (!path) return undefined
  const dot = path.indexOf('.')
  const head = dot === -1 ? path : path.slice(0, dot)
  const rest = dot === -1 ? '' : path.slice(dot + 1)
  if (head in scopes) {
    if (!rest) return scopes[head]
    return readDotted(scopes[head], rest)
  }
  if (defaultScope && defaultScope in scopes) {
    return readDotted(scopes[defaultScope], path)
  }
  // No scope matched and no default: try the single scope if there's
  // exactly one. Convenient for sqlite where most paths are flat
  // column names.
  const scopeNames = Object.keys(scopes)
  if (scopeNames.length === 1) {
    return readDotted(scopes[scopeNames[0]!], path)
  }
  return undefined
}
