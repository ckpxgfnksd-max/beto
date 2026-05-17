import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  FileNotificationLedger,
  MemoryNotificationLedger,
} from '../src/lib/notificationLedger.js'

async function tempLedgerPath(prefix = 'beto-ledger-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return path.join(dir, 'notifications.json')
}

describe('FileNotificationLedger — disk roundtrip', () => {
  it('coldStart is true when the file is absent', () => {
    const filePath = path.join(os.tmpdir(), 'beto-no-such-file', 'x.json')
    const led = new FileNotificationLedger(filePath)
    expect(led.coldStart).toBe(true)
    expect(led.size()).toBe(0)
  })

  it('persists markNotified across instances via atomic rewrite', async () => {
    const fp = await tempLedgerPath()
    const a = new FileNotificationLedger(fp)
    a.markNotified('codex:abc', 1000)
    a.markNotified('claude:def', 2000)
    await a.flush()

    const b = new FileNotificationLedger(fp)
    expect(b.coldStart).toBe(false)
    expect(b.hasNotified('codex:abc')).toBe(true)
    expect(b.hasNotified('claude:def')).toBe(true)
    expect(b.size()).toBe(2)
  })

  it('clearNotified removes an entry and persists the removal', async () => {
    const fp = await tempLedgerPath()
    const a = new FileNotificationLedger(fp)
    a.markNotified('claude:x', 1000)
    a.clearNotified('claude:x')
    await a.flush()

    const b = new FileNotificationLedger(fp)
    expect(b.hasNotified('claude:x')).toBe(false)
  })

  it('coldStart is true when the file is corrupt JSON', async () => {
    const fp = await tempLedgerPath()
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, 'not json {{')
    const led = new FileNotificationLedger(fp)
    expect(led.coldStart).toBe(true)
  })
})

describe('NotificationLedger — gc rules', () => {
  it('evicts entries older than the 30-day TTL', () => {
    const led = new MemoryNotificationLedger({
      coldStart: false,
      prefill: [
        {
          key: 'claude:ancient',
          firstSeenMs: 0,
          lastFiredMs: 0,
          lastSeenMs: 1, // observed once, then never again
        },
      ],
    })
    const days31 = 31 * 24 * 60 * 60 * 1000
    const removed = led.gc(days31)
    expect(removed).toBe(1)
    expect(led.hasNotified('claude:ancient')).toBe(false)
  })

  it('evicts idle entries (not observed in 1h+)', () => {
    const led = new MemoryNotificationLedger({
      coldStart: false,
      prefill: [
        { key: 'claude:idle', firstSeenMs: 0, lastFiredMs: 0, lastSeenMs: 0 },
      ],
    })
    const twoHours = 2 * 60 * 60 * 1000
    expect(led.gc(twoHours)).toBe(1)
  })

  it('does NOT evict entries still being observed', () => {
    const led = new MemoryNotificationLedger({
      coldStart: false,
      prefill: [
        { key: 'claude:active', firstSeenMs: 0, lastFiredMs: 0, lastSeenMs: 0 },
      ],
    })
    const halfHour = 30 * 60 * 1000
    led.markObserved('claude:active', halfHour)
    expect(led.gc(halfHour)).toBe(0)
    expect(led.hasNotified('claude:active')).toBe(true)
  })
})
