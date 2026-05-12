import React, { useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'

interface Props {
  defaultCwd: string
  onSubmit: (prompt: string, cwd: string) => void
  flash: { kind: 'ok' | 'err'; text: string } | null
}

// Two-step dispatch form: prompt first, then cwd (prefilled).
export function Dispatch({ defaultCwd, onSubmit, flash }: Props) {
  const [step, setStep] = useState<'prompt' | 'cwd'>('prompt')
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState(defaultCwd)

  return (
    <Box flexDirection="column">
      <Text bold>Dispatch a new session</Text>
      <Box marginTop={1}>
        <Text dimColor>Spawns `claude --bg "&lt;prompt&gt;"` in the given cwd.</Text>
      </Box>

      <Box marginTop={1}>
        <Text>Prompt: </Text>
        {step === 'prompt' ? (
          <TextInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={(v) => {
              if (v.trim().length === 0) return
              setPrompt(v)
              setStep('cwd')
            }}
            placeholder="Describe the task…"
          />
        ) : (
          <Text>{prompt}</Text>
        )}
      </Box>

      {step === 'cwd' && (
        <Box>
          <Text>cwd:    </Text>
          <TextInput
            value={cwd}
            onChange={setCwd}
            onSubmit={(v) => onSubmit(prompt, v || defaultCwd)}
            placeholder={defaultCwd}
          />
        </Box>
      )}

      {flash && (
        <Box marginTop={1}>
          <Text color={flash.kind === 'ok' ? 'green' : 'red'}>
            {flash.kind === 'ok' ? '✓ ' : '✗ '}
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}
