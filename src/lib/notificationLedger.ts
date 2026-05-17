// Persistent ledger of which (harness, sessionId) keys we've already
// pinged the user about. Closes the gap where a session already in
// needs-input at beto startup never produced a notification:
// notifications.ts asks the ledger "have I told the user about this
// key?" and fires if not.
//
// File: ~/.beto/state/notifications.json (sibling to ~/.beto/config.json).
// Synchronous reads on construction (file is tiny — <100KB even at
// max capacity). Writes are debounced to ~once per 5s with an atomic
// rewrite via writeFile + rename.
//
// Eviction:
//   - TTL: entries older than 30 days at firstSeenMs are dropped on hydrate.
//   - Cap: 1000 entries; oldest by lastFiredMs evicted on overflow.
//   - Idle: a key not observed for over 1h is dropped from the ledger
//     so a re-block of the same session fires a fresh notification.
//
// Tests use MemoryNotificationLedger to avoid touching disk.

import { promises as fs, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const LEDGER_VERSION = 1
const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const IDLE_EVICT_MS = 60 * 60 * 1000 // 1 hour
const CAPACITY = 1000
const WRITE_DEBOUNCE_MS = 5_000

interface LedgerEntry {
  key: string
  firstSeenMs: number
  lastFiredMs: number
  lastSeenMs: number
}

interface LedgerFile {
  version: number
  entries: LedgerEntry[]
}

export interface NotificationLedger {
  // Was the ledger file absent on initialization? Drives the silent-
  // seed-on-cold-start path in NotificationManager.
  readonly coldStart: boolean
  hasNotified(key: string): boolean
  markNotified(key: string, now: number): void
  // Update the "I've seen this session in the latest scan" timestamp.
  // Drives idle eviction (keys we stop seeing for >1h are forgotten).
  markObserved(key: string, now: number): void
  // The session is no longer in needs-input — clear notified so the
  // next re-block fires fresh.
  clearNotified(key: string): void
  // Apply TTL + idle + capacity eviction. Returns # entries removed.
  // Callers should invoke periodically (e.g. once per observe tick).
  gc(now: number): number
  // For tests + status-bar count.
  size(): number
  // Flush any pending writes. Call from process shutdown.
  flush(): Promise<void>
}

export class FileNotificationLedger implements NotificationLedger {
  readonly coldStart: boolean
  private readonly filePath: string
  private readonly entries = new Map<string, LedgerEntry>()
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultLedgerPath()
    let raw = ''
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Don't crash on a corrupt or unreadable ledger — just behave
        // as if cold-start.
        process.stderr.write(`beto: ledger ${this.filePath} unreadable (${String(e)})\n`)
      }
      this.coldStart = true
      return
    }
    try {
      const parsed = JSON.parse(raw) as LedgerFile
      if (parsed && Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) {
          if (
            e &&
            typeof e.key === 'string' &&
            typeof e.firstSeenMs === 'number' &&
            typeof e.lastFiredMs === 'number'
          ) {
            this.entries.set(e.key, {
              key: e.key,
              firstSeenMs: e.firstSeenMs,
              lastFiredMs: e.lastFiredMs,
              lastSeenMs:
                typeof e.lastSeenMs === 'number' ? e.lastSeenMs : e.lastFiredMs,
            })
          }
        }
      }
      this.coldStart = false
    } catch {
      // Treat corrupt JSON the same as missing.
      this.coldStart = true
    }
  }

  hasNotified(key: string): boolean {
    return this.entries.has(key)
  }

  markNotified(key: string, now: number): void {
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastFiredMs = now
      existing.lastSeenMs = now
    } else {
      this.entries.set(key, {
        key,
        firstSeenMs: now,
        lastFiredMs: now,
        lastSeenMs: now,
      })
    }
    this.dirty = true
    this.schedule()
  }

  markObserved(key: string, now: number): void {
    const existing = this.entries.get(key)
    if (!existing) return
    existing.lastSeenMs = now
    // No schedule — lastSeenMs changes hot, debounce avoids thrash;
    // the gc + markNotified paths will flush this naturally.
  }

  clearNotified(key: string): void {
    if (this.entries.delete(key)) {
      this.dirty = true
      this.schedule()
    }
  }

  gc(now: number): number {
    let removed = 0
    for (const [k, e] of this.entries) {
      if (now - e.firstSeenMs > TTL_MS || now - e.lastSeenMs > IDLE_EVICT_MS) {
        this.entries.delete(k)
        removed += 1
      }
    }
    if (this.entries.size > CAPACITY) {
      const sorted = [...this.entries.values()].sort(
        (a, b) => a.lastFiredMs - b.lastFiredMs,
      )
      const drop = sorted.slice(0, this.entries.size - CAPACITY)
      for (const e of drop) {
        this.entries.delete(e.key)
        removed += 1
      }
    }
    if (removed > 0) {
      this.dirty = true
      this.schedule()
    }
    return removed
  }

  size(): number {
    return this.entries.size
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty) return
    await this.writeNow()
  }

  // Debounced write. Writes scheduled while another is pending get
  // coalesced. Safe to call from observe ticks at 2s cadence.
  private schedule(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      // Fire and forget; errors surface via stderr inside writeNow.
      void this.writeNow()
    }, WRITE_DEBOUNCE_MS)
    // Don't keep Node alive solely for the flush timer; cli.tsx
    // handles graceful flush on SIGINT.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const body: LedgerFile = {
      version: LEDGER_VERSION,
      entries: [...this.entries.values()],
    }
    const json = JSON.stringify(body, null, 2) + '\n'
    try {
      const dir = path.dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(tmp, json)
      renameSync(tmp, this.filePath)
    } catch (e) {
      process.stderr.write(`beto: ledger write failed (${String(e)})\n`)
      // Mark dirty again so a future tick retries.
      this.dirty = true
    }
    // The async signature is preserved for callers that await flush();
    // we use sync APIs internally because the file is tiny and
    // serialization keeps the rename atomic.
    await Promise.resolve()
  }

  // Exposed for callers that want to seed without scheduling a write.
  // Useful during cold-start seeding where the next tick's
  // markNotified will trigger the write anyway.
  static defaultPath(): string {
    return defaultLedgerPath()
  }
}

// In-memory ledger for tests. Never touches disk. Constructor opts:
//   coldStart: bool — whether to behave like a missing ledger file.
//   prefill:   array of (key, now) tuples to load as already-notified.
export class MemoryNotificationLedger implements NotificationLedger {
  readonly coldStart: boolean
  private readonly entries = new Map<string, LedgerEntry>()

  constructor(opts: {
    coldStart?: boolean
    prefill?: Array<{ key: string; firstSeenMs: number; lastFiredMs: number; lastSeenMs?: number }>
  } = {}) {
    this.coldStart = opts.coldStart ?? !opts.prefill?.length
    if (opts.prefill) {
      for (const p of opts.prefill) {
        this.entries.set(p.key, {
          key: p.key,
          firstSeenMs: p.firstSeenMs,
          lastFiredMs: p.lastFiredMs,
          lastSeenMs: p.lastSeenMs ?? p.lastFiredMs,
        })
      }
    }
  }

  hasNotified(key: string): boolean {
    return this.entries.has(key)
  }

  markNotified(key: string, now: number): void {
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastFiredMs = now
      existing.lastSeenMs = now
    } else {
      this.entries.set(key, { key, firstSeenMs: now, lastFiredMs: now, lastSeenMs: now })
    }
  }

  markObserved(key: string, now: number): void {
    const existing = this.entries.get(key)
    if (existing) existing.lastSeenMs = now
  }

  clearNotified(key: string): void {
    this.entries.delete(key)
  }

  gc(now: number): number {
    let removed = 0
    for (const [k, e] of this.entries) {
      if (now - e.firstSeenMs > TTL_MS || now - e.lastSeenMs > IDLE_EVICT_MS) {
        this.entries.delete(k)
        removed += 1
      }
    }
    return removed
  }

  size(): number {
    return this.entries.size
  }

  async flush(): Promise<void> {
    return Promise.resolve()
  }
}

function defaultLedgerPath(): string {
  return path.join(os.homedir(), '.beto', 'state', 'notifications.json')
}

// Useful for tests / callers that want async-readable load semantics
// even though FileNotificationLedger reads in its constructor.
export async function loadDefaultLedger(): Promise<FileNotificationLedger> {
  return Promise.resolve(new FileNotificationLedger())
}

// fs/promises is re-exported only because we may eventually want to
// switch to async I/O; importing here keeps the call site stable.
export { fs as _fs }
