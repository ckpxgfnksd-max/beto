// Task-name summarizer.
//
// Real first user messages tend to start with filler ("I want to...",
// "Please help me...", "Can you..."). Truncating to a char budget
// leaves you with garbage like "I want to build the M…". This module
// produces a 1–2 word task label by stripping leading filler and
// taking the first content words.
//
// No LLM. Pure heuristic — strategy.md explicitly rules out AI-powered
// summarization on the read-only data path. Heuristic loses some
// nuance but stays fast, free, and predictable.

// Leading-filler prefixes. Case-insensitive. Order matters slightly:
// longer prefixes first so "I would like to" matches before "I".
const LEADING_FILLERS: readonly RegExp[] = [
  /^I would like to /i,
  /^I'?d like to /i,
  /^I'?m trying to /i,
  /^I am trying to /i,
  /^I want to /i,
  /^I need to /i,
  /^I'?ve been /i,
  /^I have been /i,
  /^I just /i,
  /^Could you please /i,
  /^Can you please /i,
  /^Please help me /i,
  /^Please /i,
  /^Could you /i,
  /^Can you /i,
  /^Help me /i,
  /^Let'?s /i,
  /^Let us /i,
  /^We need to /i,
  /^We want to /i,
  /^We should /i,
  /^How do I /i,
  /^How do you /i,
  /^How can I /i,
  /^How to /i,
  /^What is the /i,
  /^What's the /i,
  /^Why does /i,
  /^Why is /i,
  /^Hey /i,
  /^Hi /i,
  /^Hello /i,
] as const

// Articles + common stop-words we don't want to be the visible label.
// Always skipped when they'd land in the output. NOT a complete stopword
// list — only the ones that confuse a short label.
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'these',
  'those',
  'my',
  'our',
  'your',
  'their',
  'its',
  'it',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'for',
  'with',
  'on',
  'in',
  'at',
  'by',
  'from',
])

export interface SummarizeOptions {
  maxWords?: number
  // Hard char cap as a final safety net. Default 24.
  maxChars?: number
}

// Produce a short task label from a free-form first-user message.
// Returns "" when input is empty. Preserves original capitalization
// of content words (only the first character is forced uppercase).
export function summarizeTask(raw: string, opts: SummarizeOptions = {}): string {
  if (!raw) return ''
  const maxWords = opts.maxWords ?? 2
  const maxChars = opts.maxChars ?? 24

  let s = raw.trim()

  // Strip ALL leading filler phrases (some messages stack two:
  // "Hi, can you help me build..." → strip "Hi", then "can you",
  // then "help me").
  let stripped = true
  while (stripped) {
    stripped = false
    for (const f of LEADING_FILLERS) {
      if (f.test(s)) {
        s = s.replace(f, '').trim()
        stripped = true
        break
      }
    }
  }

  // If a leading punctuation-y wrapper (e.g. <scheduled-task name=...>),
  // try to pull the bare content. Limited scope — only attempt the
  // most common shape, leave more exotic strings to the word walker.
  const xmlAttrMatch = s.match(/^<[^>]*?\bname=["']?([^"'\s>]+)/i)
  if (xmlAttrMatch && xmlAttrMatch[1]) {
    return capitalizeFirst(xmlAttrMatch[1]).slice(0, maxChars)
  }

  // Token split on whitespace. Strip leading/trailing non-word punct
  // per token so "Aggro." → "Aggro" and "MVP," → "MVP".
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)

  // Walk for up to maxWords content tokens. Skip STOPWORDS when they
  // would land in the output — but always keep at least one token so
  // we never return empty for a non-empty input.
  const out: string[] = []
  for (const tok of tokens) {
    if (out.length === 0 && STOPWORDS.has(tok.toLowerCase()) && tokens.length > 1) {
      continue
    }
    if (out.length > 0 && STOPWORDS.has(tok.toLowerCase())) continue
    out.push(tok)
    if (out.length >= maxWords) break
  }
  if (out.length === 0 && tokens.length > 0) {
    out.push(tokens[0]!)
  }

  // Capitalize first character of the first word only — preserves
  // ProperCase / camelCase / SCREAMING_CASE elsewhere ("OpenCode",
  // "MVP", "OAuth" stay intact).
  if (out[0]) out[0] = capitalizeFirst(out[0])

  const joined = out.join(' ')
  if (joined.length <= maxChars) return joined
  // Hard char cap. Word boundary preferred but accept mid-word cut if
  // a single word exceeds the budget on its own.
  const idx = joined.lastIndexOf(' ', maxChars - 1)
  return idx > maxChars / 2 ? joined.slice(0, idx) : joined.slice(0, maxChars - 1) + '…'
}

function capitalizeFirst(s: string): string {
  if (!s) return ''
  // Don't uppercase if the first character is already uppercase or a
  // digit (e.g. "OpenCode", "MVP", "3x growth").
  if (/^[A-Z0-9]/.test(s)) return s
  // Don't uppercase identifier-shaped words (snake_case, kebab-case).
  // These are clearly programmatic names; capitalizing them looks wrong
  // ("Daily_brief" reads worse than "daily_brief").
  if (/[_-]/.test(s)) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
