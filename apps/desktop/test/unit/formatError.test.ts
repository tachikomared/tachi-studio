// apps/desktop/test/unit/formatError.test.ts
//
// Regression guard for the "[object Object]" bug found on a live dogfood run:
// the TACHI loop died with an AI_InvalidToolInputError (the gateway truncated
// streamed tool-call arguments mid-JSON) and the Code tab rendered the terminal
// error as the literal string "[object Object]" — because the AI SDK streams
// `{ type: 'error', error }` where `error` is an OBJECT and the emit site used
// String(). formatError is the one honest stringifier.

import { describe, it, expect } from 'vitest'
import { formatError } from '../../electron/services/format-error'

describe('formatError', () => {
  it('renders an AI_InvalidToolInputError-shaped object with name + message, never [object Object]', () => {
    // Shape as it arrives on the stream part (not necessarily an Error instance).
    const err = {
      name: 'AI_InvalidToolInputError',
      message: 'Invalid input for tool bash: could not parse the tool arguments',
      toolName: 'bash',
      toolInput: '{"command":"pnpm -C apps/desk',
    }
    const out = formatError(err)
    expect(out).not.toContain('[object Object]')
    expect(out).toContain('AI_InvalidToolInputError')
    expect(out).toContain('could not parse the tool arguments')
    expect(out).toContain('tool bash')
  })

  it('renders a plain Error as its message (the bare "Error" name adds nothing)', () => {
    expect(formatError(new Error('boom'))).toBe('boom')
  })

  it('keeps a meaningful Error subclass name', () => {
    expect(formatError(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
  })

  it('passes a string through unchanged', () => {
    expect(formatError('plain failure text')).toBe('plain failure text')
  })

  it('surfaces provider status and code when present', () => {
    const err = Object.assign(new Error('rate limited'), {
      name: 'AI_APICallError',
      statusCode: 429,
      code: 'rate_limit_exceeded',
    })
    const out = formatError(err)
    expect(out).toContain('AI_APICallError: rate limited')
    expect(out).toContain('HTTP 429')
    expect(out).toContain('code rate_limit_exceeded')
  })

  it('follows a nested cause chain', () => {
    const root = new TypeError('Unexpected end of JSON input')
    const mid = Object.assign(new Error('failed to parse tool arguments'), { name: 'AI_JSONParseError', cause: root })
    const top = Object.assign(new Error('tool call failed'), { name: 'AI_InvalidToolInputError', cause: mid })
    const out = formatError(top)
    expect(out).toContain('AI_InvalidToolInputError: tool call failed')
    expect(out).toContain('AI_JSONParseError: failed to parse tool arguments')
    expect(out).toContain('Unexpected end of JSON input')
    expect(out.indexOf('AI_InvalidToolInputError')).toBeLessThan(out.indexOf('Unexpected end of JSON input'))
  })

  it('never returns [object Object] for a message-less object', () => {
    const out = formatError({ status: 502, detail: 'bad gateway' })
    expect(out).not.toContain('[object Object]')
    expect(out).toContain('502')
    expect(out).toContain('bad gateway')
  })

  it('handles null / undefined / empty string without producing "undefined"', () => {
    expect(formatError(null)).toBe('unknown error')
    expect(formatError(undefined)).toBe('unknown error')
    expect(formatError('   ')).toBe('unknown error')
  })

  it('survives circular structures', () => {
    const a: Record<string, unknown> = { name: 'AI_APICallError', message: 'loop' }
    a.cause = a
    const out = formatError(a)
    expect(out).toContain('AI_APICallError: loop')
    expect(out.length).toBeLessThan(500)
  })

  it('survives an error object whose getter throws', () => {
    const nasty = {
      get name(): string { throw new Error('nope') },
      message: 'unreadable',
    }
    const out = formatError(nasty)
    expect(out).not.toContain('[object Object]')
    expect(out.length).toBeGreaterThan(0)
  })

  it('clamps very long messages', () => {
    const out = formatError(new Error('x'.repeat(9000)), { maxLen: 200 })
    expect(out.length).toBeLessThanOrEqual(201) // 200 + the ellipsis
  })
})
