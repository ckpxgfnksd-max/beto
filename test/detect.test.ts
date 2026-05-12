import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  basenameFromCommand,
  execVersion,
  scanProcesses,
  statePathCandidates,
  which,
} from '../src/lib/detect.js'
import { extractVersion } from '../src/lib/doctor.js'

describe('which', () => {
  let dir: string
  const origPath = process.env.PATH

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beto-which-'))
  })
  afterEach(() => {
    process.env.PATH = origPath
  })

  it('finds a binary on PATH', async () => {
    const target = path.join(dir, 'fakebin')
    await fs.writeFile(target, '#!/bin/sh\necho hi\n', { mode: 0o755 })
    process.env.PATH = dir
    const found = await which('fakebin')
    expect(found).toBe(target)
  })

  it('returns null for an absent binary', async () => {
    process.env.PATH = dir
    const found = await which('no-such-binary-' + Math.random())
    expect(found).toBeNull()
  })
})

describe('execVersion', () => {
  it('captures the first line of --version output', async () => {
    const got = await execVersion('node', 2000)
    expect(got).toMatch(/^v?\d+\.\d+/)
  })

  it('returns null when the binary does not exist', async () => {
    const got = await execVersion('definitely-not-a-real-binary-' + Math.random(), 500)
    expect(got).toBeNull()
  })

  it('returns null on timeout', async () => {
    // `sleep` writes nothing to stdout, so we hit the timeout deterministically.
    const got = await execVersion('sleep', 100)
    expect(got).toBeNull()
  })
})

describe('extractVersion', () => {
  it('pulls semver from "claude version 2.1.139"', () => {
    expect(extractVersion('claude version 2.1.139')).toBe('2.1.139')
  })
  it('pulls from leading v prefix', () => {
    expect(extractVersion('v0.13.4')).toBe('0.13.4')
  })
  it('pulls from "1.4.0\\n(c)..."', () => {
    expect(extractVersion('1.4.0\n(c) 2026 OpenAI')).toBe('1.4.0')
  })
  it('falls back to first 12 chars when no version-shape', () => {
    expect(extractVersion('totally weird output')).toBe('totally weir')
  })
})

describe('statePathCandidates', () => {
  it('produces XDG-aware candidates for claude', () => {
    const home = '/h'
    const out = statePathCandidates(home, 'claude')
    expect(out).toContain('/h/.claude/jobs')
    // At least one of the XDG variants should appear.
    expect(out.some((p) => p.includes('.local/share/claude') || p.includes('.config/claude'))).toBe(true)
  })

  it('honors XDG_DATA_HOME when set', () => {
    const prior = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = '/custom/data'
    try {
      const out = statePathCandidates('/h', 'codex')
      expect(out).toContain('/custom/data/codex')
    } finally {
      if (prior == null) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prior
    }
  })

  it('returns empty for aider (per-repo, no central dir)', () => {
    const out = statePathCandidates('/h', 'aider')
    expect(out).toEqual([])
  })
})

describe('basenameFromCommand', () => {
  it('strips path and args', () => {
    expect(basenameFromCommand('/usr/local/bin/claude --bg "fix bug"')).toBe('claude')
  })
  it('handles bare invocations', () => {
    expect(basenameFromCommand('ollama serve')).toBe('ollama')
  })
  it('returns null for empty input', () => {
    expect(basenameFromCommand('')).toBeNull()
    expect(basenameFromCommand('   ')).toBeNull()
  })
})

describe('scanProcesses', () => {
  it('returns at least one line on a healthy system', async () => {
    const lines = await scanProcesses(3000)
    // ps always lists at least the ps invocation itself.
    expect(lines.length).toBeGreaterThan(0)
  })

  it('respects the timeout', async () => {
    const t0 = Date.now()
    await scanProcesses(50)
    const elapsed = Date.now() - t0
    // Generous slack — scan should complete in either ~50ms (timeout)
    // or a few hundred ms (success). The point is it doesn't run for
    // multiple seconds.
    expect(elapsed).toBeLessThan(2000)
  })
})
