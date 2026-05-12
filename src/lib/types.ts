// Closed set of states. Unknown upstream spellings collapse to 'unknown' so
// a future Claude Code release that adds a new state.json status string
// never drops a row.
export type SessionState =
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unknown'

// Harness ids are open as of v0.3: built-ins below, plus any id declared
// in a user-installed manifest at ~/.beto/plugins/*.json. The closed
// `BuiltInHarnessId` union still anchors detection probes + theme defaults;
// unknown ids fall back to manifest-supplied sigil/color or generic
// defaults.
export type HarnessId = string

export type BuiltInHarnessId =
  | 'claude'
  | 'codex'
  | 'hermes'
  | 'goose'
  | 'kimi'
  | 'openclaw'
  | 'openhands'
  | 'aider'
  | 'open-interpreter'
  | 'crewai'
  | 'metagpt'

export const BUILT_IN_HARNESS_IDS: readonly BuiltInHarnessId[] = [
  'claude',
  'codex',
  'hermes',
  'goose',
  'kimi',
  'openclaw',
  'openhands',
  'aider',
  'open-interpreter',
  'crewai',
  'metagpt',
] as const

// Back-compat: code that wants the built-in list often imported HARNESS_IDS.
export const HARNESS_IDS = BUILT_IN_HARNESS_IDS

export function isBuiltInHarness(id: HarnessId): id is BuiltInHarnessId {
  return (BUILT_IN_HARNESS_IDS as readonly string[]).includes(id)
}

// Local inference daemons we detect *informationally*. Not harnesses —
// they don't host agent sessions — but their presence is a signal that
// the user runs local models, so beto doctor surfaces them with a hint
// about registering an agent that uses them via the plugin schema.
export type InferenceBackendId =
  | 'ollama'
  | 'vllm'
  | 'llama-server'
  | 'lmstudio'
  | 'litellm'
  | 'tgi'
  | 'huggingface-cli'

export const INFERENCE_BACKEND_IDS: readonly InferenceBackendId[] = [
  'ollama',
  'vllm',
  'llama-server',
  'lmstudio',
  'litellm',
  'tgi',
  'huggingface-cli',
] as const

// The minimum-viable row beto renders. Ported from aggro's StateSnapshot
// (src-tauri/src/state_tailer.rs). Every field except sessionId and state
// is best-effort: missing → empty string / 0 / false. The UI is built so a
// row with only sessionId + state still renders meaningfully.
export interface SessionSnapshot {
  // Which adapter produced this row. Defaults to 'claude' for back-compat
  // with v0.1 callers; new adapters must set this explicitly.
  harness: HarnessId
  sessionId: string
  // Display name. Falls back to a slice of sessionId when missing.
  name: string
  state: SessionState
  // Haiku one-line of what the agent is currently doing. The legibility
  // win. Italic in the UI when supported.
  summary: string
  // ms epoch of last state.json write (mtime), used for stale-mtime checks
  // and as the needs-input clock baseline.
  lastTransitionAt: number
  processAlive: boolean
  prUrl: string
  // 'pending' | 'success' | 'failure' | 'neutral' | ''
  prCheckStatus: string
  cwd: string
  // Filled in by the reader after parsing; surfaces stale-mtime overrides
  // (5min+ idle working session → forced dead).
  rawStateString: string
}

// Escalation tiers from aggro's needsInput.ts. Pure on inputs; same
// thresholds: <60s awaiting, 60s–5m escalated, 5m+ abandoned.
export type EscalationTier = 'none' | 'awaiting' | 'escalated' | 'abandoned'

// Role assignment, kept as flavor from aggro's WoW-soul: deterministic
// inference from name hash → executor / planner / validator / researcher.
// Doesn't drive logic; only used for the role glyph on each row.
export type Role = 'executor' | 'planner' | 'validator' | 'researcher'
