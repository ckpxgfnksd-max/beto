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
import {
  FileNotificationLedger,
  type NotificationLedger,
} from './notificationLedger.js'

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
  // Persistent ledger of (harness, sessionId) keys we've already
  // notified the user about. When omitted, a FileNotificationLedger
  // backed by ~/.beto/state/notifications.json is created — that's
  // the production path. Tests pass MemoryNotificationLedger.
  ledger?: NotificationLedger
  // Called exactly once on the first observe() when the ledger was
  // cold (no prior file). Receives the number of already-blocked
  // sessions that were silently seeded. UI subscribes to surface a
  // "Seeded N pre-existing blocked sessions" hint in the status bar.
  onColdStart?: (seededCount: number) => void
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
  private readonly ledger: NotificationLedger
  private readonly onColdStart?: (seededCount: number) => void

  // Session state at last emission. Absent → never seen. Used to detect
  // transitions: only ID + state are tracked.
  private readonly lastState = new Map<string, SessionState>()
  // True until the first observe() consumes the cold-start case (i.e.
  // ledger was missing on disk). On that first call we silently seed
  // the ledger with currently-blocked sessions instead of firing.
  private coldStartPending: boolean

  constructor(opts: NotificationOptions = {}) {
    this.enabled = opts.enabled ?? defaultEnabled()
    this.sound = opts.sound ?? false
    this.throttleMs = opts.throttleMs ?? 30_000
    this.dispatch = opts.dispatcher ?? platformDispatcher()
    this.now = opts.now ?? (() => Date.now())
    this.ledger = opts.ledger ?? new FileNotificationLedger()
    this.coldStartPending = this.ledger.coldStart
    if (opts.onColdStart) this.onColdStart = opts.onColdStart
  }

  // Subscribe to the cold-start event. If the seed already happened
  // before subscription, the subscriber is invoked immediately with the
  // count we seeded. Returns an unsubscribe function.
  subscribeColdStart(fn: (seededCount: number) => void): () => void {
    if (this.coldStartFired) {
      fn(this.coldStartSeededCount)
      return () => {}
    }
    this.coldStartSubscribers.add(fn)
    return () => {
      this.coldStartSubscribers.delete(fn)
    }
  }

  private coldStartFired = false
  private coldStartSeededCount = 0
  private readonly coldStartSubscribers = new Set<(n: number) => void>()

  // Call this with every merged registry emission. Returns the list of
  // notifications that were dispatched, mainly for testing.
  observe(rows: readonly SessionSnapshot[]): NotificationPayload[] {
    const now = this.now()

    // Cold-start path: ledger file didn't exist when beto launched.
    // Silently seed the ledger with currently-needs-input sessions and
    // emit one onColdStart event. We DO record prev state so the next
    // tick's transitions can be detected normally.
    if (this.coldStartPending) {
      this.coldStartPending = false
      let seeded = 0
      for (const row of rows) {
        const k = this.key(row)
        this.lastState.set(k, row.state)
        if (row.state === 'needs-input') {
          this.ledger.markNotified(k, now)
          this.ledger.markObserved(k, now)
          seeded += 1
        }
      }
      this.coldStartFired = true
      this.coldStartSeededCount = seeded
      if (this.onColdStart) this.onColdStart(seeded)
      for (const fn of this.coldStartSubscribers) fn(seeded)
      this.coldStartSubscribers.clear()
      // Cold-start tick fires no real notifications.
      return []
    }

    if (!this.enabled) {
      // Still track state so flipping enabled mid-run doesn't re-fire
      // for sessions we already saw.
      for (const row of rows) {
        const k = this.key(row)
        this.lastState.set(k, row.state)
        this.ledger.markObserved(k, now)
      }
      return []
    }

    const fired: NotificationPayload[] = []

    for (const row of rows) {
      const k = this.key(row)
      const prev = this.lastState.get(k)
      this.lastState.set(k, row.state)
      this.ledger.markObserved(k, now)

      // Leaving needs-input clears the ledger entry so the NEXT
      // re-block fires a fresh notification.
      if (row.state !== 'needs-input') {
        if (this.ledger.hasNotified(k)) this.ledger.clearNotified(k)
        continue
      }

      // row.state === 'needs-input'. Fire if either:
      //   (a) live transition: we saw a non-needs-input prev state
      //       this same process and now it flipped to needs-input.
      //   (b) startup-discovery: prev is undefined (first time seeing
      //       this session in-process) AND the ledger doesn't already
      //       know about it. This catches sessions that transitioned
      //       while beto was off — the gap the cold-start ledger fix
      //       closes.
      const isLiveTransition = prev !== undefined && prev !== 'needs-input'
      const isFreshStartupDiscovery = prev === undefined && !this.ledger.hasNotified(k)
      if (!isLiveTransition && !isFreshStartupDiscovery) continue

      // Throttle: don't re-fire for the same key within throttleMs.
      // Use ledger.lastFiredMs proxied via hasNotified + an inline
      // sentinel: we rely on clearNotified/markNotified for the
      // happy paths, so the only remaining throttle case is "lived
      // through a flicker faster than throttleMs." Track in-process
      // via lastFiredInProc to avoid persisting noise.
      const lastInProc = this.lastFiredInProc.get(k)
      if (lastInProc !== undefined && now - lastInProc < this.throttleMs) continue
      this.lastFiredInProc.set(k, now)

      this.ledger.markNotified(k, now)
      const payload = this.build(row)
      fired.push(payload)
      // Dispatch async; don't await — beto's render loop must not block
      // on osascript. Errors are swallowed by the dispatcher.
      void this.dispatch(payload)
    }

    // GC ledger on every tick — cheap, keeps the file bounded.
    this.ledger.gc(now)

    return fired
  }

  // In-process throttle state (separate from the on-disk ledger,
  // which only knows "we've ever told the user about this"). This
  // map handles the flicker case: blocked→working→blocked within
  // 30s shouldn't double-notify even though clearNotified() emptied
  // the ledger entry.
  private readonly lastFiredInProc = new Map<string, number>()

  // Flush any pending ledger writes. Call from process shutdown.
  async flush(): Promise<void> {
    await this.ledger.flush()
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
