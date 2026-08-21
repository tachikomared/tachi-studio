import { describe, it, expect } from 'vitest'
import { makeLogEvent } from '../format.js'
import type { LogLevel, LogCategory } from '../types.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']
const CATEGORIES: LogCategory[] = [
  'app',
  'chat',
  'provider',
  'runtime',
  'terminal',
  'agent-command',
  'settings',
  'updater',
  'security',
]

function expectGeneratedFields(event: ReturnType<typeof makeLogEvent>): void {
  expect(event.id).toMatch(UUID_RE)
  expect(event.ts).toMatch(ISO_RE)
  expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
}

describe('makeLogEvent', () => {
  describe('shape', () => {
    it('has exactly the six expected keys (including details when omitted)', () => {
      const event = makeLogEvent('info', 'app', 'hello')
      expect(Object.keys(event).sort()).toEqual([
        'category',
        'details',
        'id',
        'level',
        'message',
        'ts',
      ])
    })

    it('produces correctly typed fields', () => {
      const event = makeLogEvent('info', 'app', 'hello')
      expect(typeof event.id).toBe('string')
      expect(typeof event.ts).toBe('string')
      expect(typeof event.level).toBe('string')
      expect(typeof event.category).toBe('string')
      expect(typeof event.message).toBe('string')
    })
  })

  describe('id', () => {
    it('is a v4 UUID', () => {
      expect(makeLogEvent('info', 'app', 'x').id).toMatch(UUID_RE)
    })

    it('is unique across many calls', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 1000; i++) {
        ids.add(makeLogEvent('info', 'app', 'x').id)
      }
      expect(ids.size).toBe(1000)
    })

    it('returns a fresh object instance per call', () => {
      const events = Array.from({ length: 10 }, () =>
        makeLogEvent('info', 'app', 'x')
      )
      expect(new Set(events).size).toBe(events.length)
    })
  })

  describe('ts', () => {
    it('is a valid ISO 8601 timestamp', () => {
      const event = makeLogEvent('info', 'app', 'x')
      expect(event.ts).toMatch(ISO_RE)
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
    })

    it('is close to the current time', () => {
      const event = makeLogEvent('info', 'app', 'x')
      expect(Math.abs(Date.now() - Date.parse(event.ts))).toBeLessThan(5000)
    })

    it('produces valid timestamps for consecutive calls', () => {
      const a = makeLogEvent('info', 'app', 'x')
      const b = makeLogEvent('info', 'app', 'x')
      expect(a.ts).toMatch(ISO_RE)
      expect(b.ts).toMatch(ISO_RE)
      expect(Math.abs(Date.now() - Date.parse(a.ts))).toBeLessThan(5000)
      expect(Math.abs(Date.now() - Date.parse(b.ts))).toBeLessThan(5000)
    })
  })

  describe('level passthrough', () => {
    it.each(LEVELS)('passes through level %s', level => {
      const event = makeLogEvent(level, 'app', 'msg')
      expect(event.level).toBe(level)
      expectGeneratedFields(event)
    })
  })

  describe('category passthrough', () => {
    it.each(CATEGORIES)('passes through category %s', category => {
      const event = makeLogEvent('info', category, 'msg')
      expect(event.category).toBe(category)
      expectGeneratedFields(event)
    })
  })

  describe('message passthrough', () => {
    it('leaves a safe string unchanged', () => {
      const msg = 'GET /v1/models HTTP/1.1'
      expect(makeLogEvent('info', 'app', msg).message).toBe(msg)
    })

    it('leaves the empty string unchanged', () => {
      expect(makeLogEvent('info', 'app', '').message).toBe('')
    })

    it('leaves near-miss secret-like strings unchanged', () => {
      const cases = ['Bearer ', 'bk_', 'bk_!', 'sk-', 'sk-!', 'embark token']
      for (const msg of cases) {
        expect(makeLogEvent('info', 'app', msg).message).toBe(msg)
      }
    })
  })

  describe('redaction integration (message)', () => {
    it('redacts a Bearer token, keeping the prefix', () => {
      const event = makeLogEvent('info', 'provider', 'Authorization: Bearer bk_abc123xyz')
      expect(event.message).toBe('Authorization: Bearer [REDACTED]')
    })

    it('redacts a bk_ prefixed key', () => {
      const event = makeLogEvent('info', 'provider', 'key=bk_supersecret')
      expect(event.message).toBe('key=[REDACTED]')
    })

    it('redacts an sk- prefixed key', () => {
      const event = makeLogEvent('info', 'provider', 'token sk-abc_DEF-123')
      expect(event.message).toBe('token [REDACTED]')
    })

    it('redacts multiple secrets in one message', () => {
      const event = makeLogEvent(
        'info',
        'provider',
        'Bearer xyz and bk_one and sk-two'
      )
      expect(event.message).toBe('Bearer [REDACTED] and [REDACTED] and [REDACTED]')
      expect(event.message).not.toMatch(/bk_one|sk-two|Bearer xyz/)
    })

    it('only redacts the token, leaving surrounding words intact', () => {
      const event = makeLogEvent('info', 'provider', 'Bearer abc123 done')
      expect(event.message).toBe('Bearer [REDACTED] done')
    })

    it('consumes trailing punctuation in a Bearer token (\\S+ is greedy)', () => {
      const event = makeLogEvent('info', 'provider', 'Bearer abc123.')
      expect(event.message).toBe('Bearer [REDACTED]')
    })
  })

  describe('details', () => {
    it('includes details key as undefined when omitted', () => {
      const event = makeLogEvent('info', 'app', 'x')
      expect('details' in event).toBe(true)
      expect(event.details).toBeUndefined()
    })

    it('includes details key as undefined when passed undefined', () => {
      const event = makeLogEvent('info', 'app', 'x', undefined)
      expect('details' in event).toBe(true)
      expect(event.details).toBeUndefined()
    })

    it('passes an object through by reference', () => {
      const details = { status: 200, url: 'https://example.com' }
      const event = makeLogEvent('info', 'app', 'x', details)
      expect(event.details).toBe(details)
    })

    it('passes an empty object through by reference', () => {
      const details = {}
      const event = makeLogEvent('info', 'app', 'x', details)
      expect(event.details).toBe(details)
    })

    it('does NOT redact secret-shaped values inside details', () => {
      const details = {
        authorization: 'Bearer bk_secret',
        token: 'sk-abc123',
      }
      const event = makeLogEvent('info', 'app', 'x', details)
      expect(event.details).toBe(details)
      expect(event.details).toEqual({
        authorization: 'Bearer bk_secret',
        token: 'sk-abc123',
      })
    })
  })

  describe('statelessness', () => {
    it('generates fresh id/ts per call for identical inputs', () => {
      const a = makeLogEvent('warn', 'security', 'same message')
      const b = makeLogEvent('warn', 'security', 'same message')
      expect(a.id).not.toBe(b.id)
      expect(a).not.toBe(b)
      expect(a.level).toBe(b.level)
      expect(a.category).toBe(b.category)
      expect(a.message).toBe(b.message)
    })
  })
})
