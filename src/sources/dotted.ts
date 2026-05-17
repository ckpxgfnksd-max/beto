// Dotted-path readers, shared by adapters that map nested JSON fields
// declaratively (jsonl-tail, sqlite-sessions-table state inference).
//
// `readDotted` walks `payload.cwd` style paths through nested objects.
// Flat keys (no dot) still resolve normally because split('.') yields
// [key]. Returns undefined on any missing segment. Never throws.

export function readDotted(
  obj: Record<string, unknown> | null | undefined,
  dottedKey: string,
): unknown {
  if (!obj || !dottedKey) return undefined
  const parts = dottedKey.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

export function readDottedString(
  obj: Record<string, unknown> | null | undefined,
  dottedKey: string,
): string {
  return toStringOrEmpty(readDotted(obj, dottedKey))
}

export function toStringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

// Timestamps may be ISO 8601 strings or numeric ms-since-epoch.
// Normalize either form to ms. Returns 0 when the value is missing or
// unparseable — callers treat 0 as "unknown."
export function readDottedTimestamp(
  obj: Record<string, unknown> | null | undefined,
  dottedKey: string,
): number {
  const v = readDotted(obj, dottedKey)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const parsed = Date.parse(v)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

// Is a value "present and non-empty" for predicate purposes?
// - undefined / null → absent
// - empty string → absent
// - 0 → absent (matches the SQL "value not set" intuition)
// - false → absent (same)
// - anything else → present
export function isPresent(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string' && v.length === 0) return false
  if (typeof v === 'number' && v === 0) return false
  if (typeof v === 'boolean' && v === false) return false
  return true
}
