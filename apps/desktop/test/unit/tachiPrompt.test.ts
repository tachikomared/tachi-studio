// apps/desktop/test/unit/tachiPrompt.test.ts
//
// buildTachiSystemPrompt: verify the stable base is always present, and that an
// active slash command appends its <tachi-plan> instruction LAST (most salient),
// coexisting with private mode. Guards the parsedCommand -> TACHI wiring that lets
// /plan, /refactor, /review, /troubleshoot reach the agent.

import { describe, it, expect } from 'vitest'
import { buildTachiSystemPrompt } from '../../electron/services/tachi/prompt'

const base = { workspaceRoot: '/ws', platform: 'linux', date: '2026-06-17' }

describe('buildTachiSystemPrompt', () => {
  it('omits slash-command framing when no command is active', () => {
    const s = buildTachiSystemPrompt(base)
    expect(s).toContain('You are TACHI')
    expect(s).not.toContain('SLASH COMMAND')
  })

  it('appends the slash-command instruction (after the base) when a command is active', () => {
    const s = buildTachiSystemPrompt({ ...base, parsedCommand: { command: 'plan', flags: { fix: false }, rawArgs: '' } })
    expect(s).toContain('[SLASH COMMAND: /plan]')
    expect(s).toContain('<tachi-plan type="plan">')
    expect(s.indexOf('You are TACHI')).toBeLessThan(s.indexOf('SLASH COMMAND'))
  })

  it('coexists with private mode + honours --fix', () => {
    const s = buildTachiSystemPrompt({ ...base, privateMode: true, parsedCommand: { command: 'review', flags: { fix: true }, rawArgs: '' } })
    expect(s).toContain('PRIVATE MODE is ON')
    expect(s).toContain('[SLASH COMMAND: /review]')
    expect(s).toContain('The user passed --fix')
  })

  // Verbosity / output-economy steering (STEAL 2026-06-21 #1, headroom) — an
  // always-on frozen block that cuts OUTPUT tokens (no preamble/postamble, no
  // echoing file contents). Measured −22…−63% output tokens, zero accuracy loss.
  it('includes the always-on output-economy directive in the STABLE prefix', () => {
    const s = buildTachiSystemPrompt(base)
    expect(s).toContain('Output economy')
    // stable: it appears before the volatile per-call Environment block
    expect(s.indexOf('Output economy')).toBeLessThan(s.indexOf('Environment:'))
    // carries the high-value reduction rules
    expect(s).toMatch(/preamble|postamble/i)
    expect(s).toMatch(/echo|paste/i)
    // explicitly scoped to WORDS, not effort (prevents "be terse" → "do less")
    expect(s).toMatch(/do the full job/i)
  })

  it('keeps the output-economy block identical regardless of volatile context (cache-friendly)', () => {
    const a = buildTachiSystemPrompt(base)
    const b = buildTachiSystemPrompt({ ...base, projectContext: 'x', memory: 'y', date: '2099-01-01' })
    const grab = (s: string) => s.slice(s.indexOf('Output economy'), s.indexOf('Environment:'))
    expect(grab(a)).toBe(grab(b))
  })
})
