// Desktop notifications on `needs-input` transitions.
//
// Watches the registry's flat row stream, tracks the previous state of
// every session, and fires one OS notification per transition into
// `needs-input`. Throttled per session so a session that flickers
// blocked → working → blocked → working doesn't spam.
//
// Platform:
//   macOS  → osascript display notification
//   Linux  → notify-send (if available; silently no-ops if missing)
//   Windows → no-op in v0.5 (PowerShell BurntToast adds too much weight)
//
// The notification *is the entire surface* for users who don't keep beto
// visible in a pane. v0.5's main job is making that case useful.

import { spawn } from 'node:child_process'
import type { SessionSnapshot, SessionState } from './types.js'

export interface NotificationOptions {
  // Master switch. Default: true on macOS/Linux, false on Windows.
  enabled?: boolean
  // Audible cue alongside the visual one. Default false — these fire
  // every time something needs you, and an audible alert per blocked
  // session every two seconds gets old fast. Sound is an opt-in.
  sound?: boolean
  // Per-session throttle. We never fire more than once per session in
  // this window, even if the state oscillates. Default 30s.
  throttleMs?: number
  // Injected for tests so we can assert without invoking osascript.
  dispatcher?: NotificationDispatcher
  // Override for tests / "first emission shouldn't trigger" semantics.
  now?: () => number
}

export interface NotificationPayload {
  title: string
  message: string
  sound: boolean
}

export type NotificationDispatcher = (payload: NotificationPayload) => Promise<void>

export class NotificationManager {
  private readonly enabled: boolean
  private readonly sound: boolean
  private readonly throttleMs: number
  private readonly dispatch: NotificationDispatcher
  private readonly now: () => number

  // Session state at last emission. Absent → never seen. Used to detect
  // transitions: only ID + state are tracked.
  private readonly lastState = new Map<string, SessionState>()
  // When we last fired a notification for a given session, for throttling.
  private readonly lastFiredAt = new Map<string, number>()

  constructor(opts: NotificationOptions = {}) {
    this.enabled = opts.enabled ?? defaultEnabled()
    this.sound = opts.sound ?? false
    this.throttleMs = opts.throttleMs ?? 30_000
    this.dispatch = opts.dispatcher ?? platformDispatcher()
    this.now = opts.now ?? (() => Date.now())
  }

  // Call this with every merged registry emission. Returns the list of
  // notifications that were dispatched, mainly for testing.
  observe(rows: readonly SessionSnapshot[]): NotificationPayload[] {
    if (!this.enabled) {
      // Still track state so flipping enabled mid-run doesn't re-fire
      // for sessions we already saw.
      for (const row of rows) {
        this.lastState.set(this.key(row), row.state)
      }
      return []
    }

    const fired: NotificationPayload[] = []
    const now = this.now()

    for (const row of rows) {
      const k = this.key(row)
      const prev = this.lastState.get(k)
      this.lastState.set(k, row.state)

      // Only fire on a real transition INTO needs-input. The first time
      // we see a session counts as "no prior state" — we don't fire on
      // already-blocked sessions when beto launches, only on fresh
      // transitions thereafter.
      const isFreshTransition =
        row.state === 'needs-input' && prev !== undefined && prev !== 'needs-input'
      if (!isFreshTransition) continue

      const lastTime = this.lastFiredAt.get(k)
      if (lastTime !== undefined && now - lastTime < this.throttleMs) continue
      this.lastFiredAt.set(k, now)

      const payload = this.build(row)
      fired.push(payload)
      // Dispatch async; don't await — beto's render loop must not block
      // on osascript. Errors are swallowed by the dispatcher.
      void this.dispatch(payload)
    }

    return fired
  }

  private key(row: SessionSnapshot): string {
    return `${row.harness}:${row.sessionId}`
  }

  private build(row: SessionSnapshot): NotificationPayload {
    // Title always carries the session name — keeps the harness/session
    // identifiable at a glance in OS notification centers that crop
    // body text. Message is the Haiku summary (the legibility win) when
    // present; otherwise a fallback that names the harness.
    const title = `${row.name} needs you`
    const message = row.summary || `${row.name} (${row.harness}) is blocked.`
    return { title, message, sound: this.sound }
  }
}

// ─── Platform dispatchers ────────────────────────────────────────────

export function platformDispatcher(): NotificationDispatcher {
  switch (process.platform) {
    case 'darwin':
      return macDispatch
    case 'linux':
      return linuxDispatch
    default:
      return noopDispatch
  }
}

function defaultEnabled(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}

async function noopDispatch(_payload: NotificationPayload): Promise<void> {
  // Windows + others: do nothing for v0.5. Inbox still shows the row.
}

// macOS uses osascript -e 'display notification ...'. We escape quotes
// in the payload by replacing " with \" and stripping line breaks.
async function macDispatch(payload: NotificationPayload): Promise<void> {
  const title = sanitize(payload.title)
  const message = sanitize(payload.message)
  const soundClause = payload.sound ? ' sound name "default"' : ''
  const script = `display notification "${message}" with title "${title}"${soundClause}`
  return spawnDetached('osascript', ['-e', script])
}

// Linux: notify-send is by far the most portable option. If absent
// (some container/server distros), we no-op silently — beto doesn't
// crash, the user just doesn't get a popup.
async function linuxDispatch(payload: NotificationPayload): Promise<void> {
  return spawnDetached('notify-send', [payload.title, payload.message])
}

function sanitize(s: string): string {
  return s.replace(/[\r\n]/g, ' ').replace(/"/g, '\\"').slice(0, 240)
}

// Fire-and-forget subprocess. We deliberately don't await the child or
// surface errors: a missing notify-send shouldn't bubble into the inbox.
function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
      // Cap the wait at 2s so a hung osascript can't pile up.
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already gone
        }
        resolve()
      }, 2000)
    } catch {
      resolve()
    }
  })
}
