// Commander surface. Ported from aggro/src-tauri/src/commander.rs.
//
// Three operations live here:
//
//   dispatch(prompt, cwd?)  → `claude --bg "<prompt>"` in cwd. Detached.
//   attach(sessionId)       → opens a Terminal window with `claude attach <id>`
//                             (macOS only — osascript). Linux/Windows: typed error.
//   reply(sessionId, msg)   → pbcopy + osascript ⌘V into a freshly-attached
//                             Terminal (macOS only — fragile but works).
//
// Returns typed Result objects so the UI can show actionable text instead
// of a stack trace.

import { spawn } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'

export type CommanderResult =
  | { ok: true; message: string }
  | { ok: false; kind: string; message: string }

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export async function dispatch(prompt: string, cwd?: string): Promise<CommanderResult> {
  const trimmed = prompt.trim()
  if (!trimmed) {
    return { ok: false, kind: 'empty-prompt', message: 'Prompt must not be empty.' }
  }

  let working = cwd && cwd.length > 0 ? cwd : os.homedir()
  try {
    const st = await fs.stat(working)
    if (!st.isDirectory()) working = os.homedir()
  } catch {
    working = os.homedir()
  }

  try {
    const child = spawn('claude', ['--bg', trimmed], {
      cwd: working,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return { ok: true, message: `dispatched in ${working}` }
  } catch (e) {
    return {
      ok: false,
      kind: 'spawn-failed',
      message: `Could not run \`claude --bg\`: ${String(e)}. Is the Claude Code CLI on PATH?`,
    }
  }
}

export async function attach(sessionId: string): Promise<CommanderResult> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, kind: 'invalid-id', message: 'Session id has invalid characters.' }
  }
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      kind: 'unsupported-os',
      message: 'attach is macOS-only for now. Run `claude attach ' + sessionId + '` manually.',
    }
  }

  // Drive Terminal.app via osascript. session_id is validated above so
  // splicing is safe.
  const script = `tell application "Terminal"
  activate
  do script "claude attach ${sessionId}"
end tell`
  try {
    await runOsascript(script)
    return { ok: true, message: `attached to ${sessionId} in Terminal` }
  } catch (e) {
    return {
      ok: false,
      kind: 'osascript-failed',
      message: `osascript failed: ${String(e)}`,
    }
  }
}

export async function reply(sessionId: string, message: string): Promise<CommanderResult> {
  const trimmed = message.trim()
  if (!trimmed) {
    return { ok: false, kind: 'empty-reply', message: 'Reply must not be empty.' }
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, kind: 'invalid-id', message: 'Session id has invalid characters.' }
  }
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      kind: 'unsupported-os',
      message:
        'reply is macOS-only for now. Run `claude attach ' +
        sessionId +
        '` and paste manually.',
    }
  }

  // 1. pbcopy the reply (stdin pipe, never on command line)
  try {
    await pbcopy(trimmed)
  } catch (e) {
    return { ok: false, kind: 'pbcopy-failed', message: `pbcopy failed: ${String(e)}` }
  }

  // 2. osascript: open Terminal, run `claude attach`, wait, paste, return.
  // The 1500ms wait is the prompt-render budget. Fragile under load — if
  // Terminal is slow to render the input prompt, paste lands on nothing.
  const script = `tell application "Terminal"
  activate
  do script "claude attach ${sessionId}"
end tell
delay 1.5
tell application "System Events"
  keystroke "v" using {command down}
  delay 0.1
  keystroke return
end tell`
  try {
    await runOsascript(script)
    return { ok: true, message: `replied to ${sessionId} (clipboard + ⌘V)` }
  } catch (e) {
    return {
      ok: false,
      kind: 'osascript-failed',
      message: `osascript failed: ${String(e)}. Grant Accessibility permission to your terminal app.`,
    }
  }
}

// Run osascript synchronously-ish. Resolves on exit 0, rejects on non-zero
// or stderr output.
function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `osascript exited ${code}`))
    })
  })
}

function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `pbcopy exited ${code}`))
    })
    child.stdin.write(text)
    child.stdin.end()
  })
}

// Resolve cwd for the dispatch form: prefer the peeked session's cwd when
// present; fall back to home.
export function resolveDispatchCwd(peekedCwd?: string): string {
  if (peekedCwd && peekedCwd.length > 0) return peekedCwd
  return os.homedir()
}

export const _paths = { homedir: () => os.homedir(), join: path.join }
