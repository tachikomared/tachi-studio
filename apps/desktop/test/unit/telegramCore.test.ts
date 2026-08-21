// Unit tests for the PURE Telegram-channel helpers.
import { describe, it, expect } from 'vitest'
import { chunkMessage, formatPairingCode, matchesPairingCode, extractIncoming, nextOffset } from '../../electron/services/telegram-core'

describe('chunkMessage', () => {
  it('passes short messages through and drops empties', () => {
    expect(chunkMessage('hi')).toEqual(['hi'])
    expect(chunkMessage('')).toEqual([])
    expect(chunkMessage('   ')).toEqual([])
  })
  it('splits long text at newline boundaries under the cap', () => {
    const line = 'x'.repeat(100)
    const text = Array.from({ length: 60 }, () => line).join('\n') // ~6060 chars
    const chunks = chunkMessage(text, 1000)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
    expect(chunks.join('\n').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })
  it('hard-cuts a single giant token', () => {
    const chunks = chunkMessage('a'.repeat(2500), 1000)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(1000)
  })
})

describe('pairing', () => {
  it('formats 6 digits with left pad', () => {
    expect(formatPairingCode(7)).toBe('000007')
    expect(formatPairingCode(123456)).toBe('123456')
    expect(formatPairingCode(1_234_567)).toBe('234567')
  })
  it('matches bare code and /start payload only', () => {
    expect(matchesPairingCode('000007', '000007')).toBe(true)
    expect(matchesPairingCode('/start 000007', '000007')).toBe(true)
    expect(matchesPairingCode('/start', '000007')).toBe(false)
    expect(matchesPairingCode('000008', '000007')).toBe(false)
    expect(matchesPairingCode('hello 000007', '000007')).toBe(false)
  })
})

describe('extractIncoming / nextOffset', () => {
  it('extracts text messages and skips noise', () => {
    const body = { ok: true, result: [
      { update_id: 10, message: { chat: { id: 42 }, text: ' hello ' } },
      { update_id: 11, message: { chat: { id: 42 } } },              // sticker/no text
      { update_id: 12, edited_message: { chat: { id: 42 }, text: 'edited' } }, // not `message`
      { update_id: 13, message: { chat: { id: '77' }, text: 'second' } },
    ] }
    const inc = extractIncoming(body)
    expect(inc).toEqual([
      { updateId: 10, chatId: '42', text: 'hello' },
      { updateId: 13, chatId: '77', text: 'second' },
    ])
    expect(nextOffset(inc, 0)).toBe(14)
    expect(nextOffset([], 5)).toBe(5)
  })
  it('tolerates garbage bodies', () => {
    expect(extractIncoming(null)).toEqual([])
    expect(extractIncoming({ ok: true })).toEqual([])
    expect(extractIncoming('nope')).toEqual([])
  })
})

// ── F19: callbacks + permission keyboard + run-event formatting ──────────────
import {
  advanceOffset, extractCallbacks, permissionKeyboard, parsePermissionCallback, formatRunEvent,
} from '../../electron/services/telegram-core'

describe('advanceOffset', () => {
  it('advances over EVERY update kind, not just extracted messages', () => {
    const body = { result: [
      { update_id: 10, message: { chat: { id: 1 }, text: 'hi' } },
      { update_id: 11, sticker: {} },                 // unhandled kind
      { update_id: 12, callback_query: { id: 'c', data: 'x', message: { chat: { id: 1 } } } },
    ] }
    expect(advanceOffset(body, 0)).toBe(13)
    expect(advanceOffset(body, 99)).toBe(99) // never goes backwards
    expect(advanceOffset(null, 5)).toBe(5)
  })
})

describe('extractCallbacks', () => {
  it('extracts callback queries and skips malformed ones', () => {
    const body = { result: [
      { update_id: 1, callback_query: { id: 'cb1', data: 'perm:abc:allow', message: { chat: { id: 77 } } } },
      { update_id: 2, callback_query: { id: 'cb2' } },             // no data/chat
      { update_id: 3, message: { chat: { id: 77 }, text: 'hi' } }, // not a callback
    ] }
    const cbs = extractCallbacks(body)
    expect(cbs).toHaveLength(1)
    expect(cbs[0]).toEqual({ updateId: 1, callbackId: 'cb1', chatId: '77', data: 'perm:abc:allow' })
  })
})

describe('permission callback round-trip', () => {
  it('keyboard data parses back for every button', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000'
    const kb = permissionKeyboard(id)
    const datas = kb.inline_keyboard.flat().map(b => b.callback_data)
    expect(datas).toHaveLength(3)
    for (const d of datas) {
      const parsed = parsePermissionCallback(d)
      expect(parsed?.id).toBe(id)
    }
    expect(new Set(datas.map(d => parsePermissionCallback(d)?.decision))).toEqual(new Set(['allow', 'deny', 'allow_30m']))
    // callback_data must stay within Telegram's 64-byte cap
    for (const d of datas) expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64)
  })
  it('rejects junk and injection-shaped data (fail-closed)', () => {
    expect(parsePermissionCallback('perm:abc:always_allow_tool')).toBeNull() // not offered remotely
    expect(parsePermissionCallback('perm::allow')).toBeNull()
    expect(parsePermissionCallback('nonsense')).toBeNull()
    expect(parsePermissionCallback('')).toBeNull()
  })
})

describe('formatRunEvent', () => {
  it('formats the three event kinds compactly', () => {
    expect(formatRunEvent({ type: 'run-started', harness: 'tachi', task: 'fix the bug' })).toContain('TACHI run started')
    expect(formatRunEvent({ type: 'run-finished', harness: 'tachi', ok: true, ms: 65_000 })).toContain('(1m)')
    const fail = formatRunEvent({ type: 'run-finished', harness: 'openclaude', ok: false, ms: 3000, error: 'boom' })
    expect(fail).toContain('FAILED')
    expect(fail).toContain('boom')
    expect(formatRunEvent({ type: 'permission-requested', toolName: 'bash', reason: 'rm -rf build' })).toContain('Approval needed')
  })
})
