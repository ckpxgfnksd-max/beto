import { describe, it, expect } from 'vitest'
import { summarizeTask } from '../src/lib/summarize.js'

describe('summarizeTask', () => {
  it('returns empty for empty input', () => {
    expect(summarizeTask('')).toBe('')
    expect(summarizeTask('   ')).toBe('')
  })

  it('strips "I want to" prefix', () => {
    expect(summarizeTask('I want to build Aggro for the team')).toBe('Build Aggro')
  })

  it('strips "I need to" + skips "the"', () => {
    expect(summarizeTask('I need to build the MVP for a new product')).toBe('Build MVP')
  })

  it('strips "Please" + "help me"', () => {
    expect(summarizeTask('Please help me fix the auth bug')).toBe('Fix auth')
  })

  it('strips "Can you" prefix', () => {
    expect(summarizeTask('Can you implement OAuth in the gateway?')).toBe('Implement OAuth')
  })

  it('strips "How do I" prefix', () => {
    expect(summarizeTask('How do I migrate Postgres to MySQL')).toBe('Migrate Postgres')
  })

  it('preserves ProperCase / camelCase content words', () => {
    expect(summarizeTask('I want to refactor OpenCode adapter')).toBe('Refactor OpenCode')
    expect(summarizeTask('Build a useAuth hook')).toBe('Build useAuth')
  })

  it('preserves SCREAMING_CASE / acronyms', () => {
    expect(summarizeTask('I need to fix the API endpoint')).toBe('Fix API')
    expect(summarizeTask("I'm trying to debug MVP issues")).toBe('Debug MVP')
  })

  it('handles array of stacked fillers ("Hi, can you...")', () => {
    expect(summarizeTask('Hi can you help me fix the auth bug')).toBe('Fix auth')
  })

  it('extracts name= attribute from XML-ish wrappers', () => {
    // Real shape: Claude Code's scheduled tasks ship a <scheduled-task>
    // wrapper around the actual prompt. The `name=` attribute is the
    // task identifier we want to surface.
    expect(summarizeTask('<scheduled-task name="daily_brief">do thing</scheduled-task>')).toBe('daily_brief')
    expect(summarizeTask("<scheduled-task name='x-brief'>x</scheduled-task>")).toBe('x-brief')
  })

  it('falls back to the only content token when input is one word', () => {
    expect(summarizeTask('debug')).toBe('Debug')
    expect(summarizeTask('Aggro')).toBe('Aggro')
  })

  it('keeps a single stopword when nothing else exists', () => {
    expect(summarizeTask('the')).toBe('The')
  })

  it('caps at maxWords (default 2)', () => {
    // First two content words after stopword skip: build · new. Yes,
    // "auth" would be more informative — but distinguishing weak
    // modifiers from informative nouns requires either an LLM or a
    // bigger stopword list. The pure-heuristic posture keeps "new".
    expect(summarizeTask('build the new auth system for the platform')).toBe('Build new')
  })

  it('respects maxWords override', () => {
    expect(
      summarizeTask('I want to build a strategic information radar', { maxWords: 3, maxChars: 40 }),
    ).toBe('Build strategic information')
  })

  it('caps at maxChars (default 24)', () => {
    // A single very-long word should get truncated, not break the budget.
    const long = 'antidisestablishmentarianism advocacy'
    expect(summarizeTask(long).length).toBeLessThanOrEqual(24)
  })

  it('strips trailing punctuation from chosen words', () => {
    expect(summarizeTask('fix bugs! please?')).toBe('Fix bugs')
  })

  it('handles real beto-session samples gracefully', () => {
    // Real first-user messages observed in ~/.claude/projects/.
    const cases: [string, string][] = [
      [
        'I want to build the MVP for a "Strategic Information Radar" application.',
        'Build MVP',
      ],
      ['I want to build Aggro as a tool/app to clearly and easily observe', 'Build Aggro'],
      ['read this post via chasewang.me/cn-only-ai-friend', 'Read post'],
      ['<scheduled-task name=daily_brief>generate today brief</scheduled-task>', 'daily_brief'],
      ['Build OpenCode adapter for beto', 'Build OpenCode'],
    ]
    for (const [input, expected] of cases) {
      expect(summarizeTask(input), `input: ${input}`).toBe(expected)
    }
  })
})
