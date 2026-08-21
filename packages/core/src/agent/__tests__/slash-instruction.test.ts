import { describe, it, expect } from 'vitest'
import { buildSlashCommandInstruction } from '../slash-instruction.js'
import type { ParsedSlashCommand } from '../types.js'

const cmd = (command: ParsedSlashCommand['command'], fix = false): ParsedSlashCommand => ({ command, flags: { fix }, rawArgs: '' })

describe('buildSlashCommandInstruction', () => {
  it('emits the matching <tachi-plan> block + approval gate per command', () => {
    for (const c of ['troubleshoot', 'refactor', 'review', 'plan'] as const) {
      const s = buildSlashCommandInstruction(cmd(c))
      expect(s).toContain(`[SLASH COMMAND: /${c}]`)
      expect(s).toContain(`<tachi-plan type="${c}">`)
      expect(s).toContain(`"command": "${c}"`)
      expect(s).toMatch(/DO NOT begin/) // every command defers tool calls until approval
    }
  })

  it('adds the --fix execution paragraph only when fix is set', () => {
    expect(buildSlashCommandInstruction(cmd('plan', true))).toContain('The user passed --fix')
    expect(buildSlashCommandInstruction(cmd('plan', false))).not.toContain('The user passed --fix')
  })

  it('carries each command\'s distinctive schema fields', () => {
    expect(buildSlashCommandInstruction(cmd('troubleshoot'))).toContain('rootCause')
    expect(buildSlashCommandInstruction(cmd('refactor'))).toContain('estimatedDiff')
    expect(buildSlashCommandInstruction(cmd('review'))).toContain('findings')
    expect(buildSlashCommandInstruction(cmd('plan'))).toContain('criticalPath')
  })
})
