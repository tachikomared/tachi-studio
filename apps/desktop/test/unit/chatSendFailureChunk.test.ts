// apps/desktop/test/unit/chatSendFailureChunk.test.ts
//
// P0 2026-07-25 — "chat is silently dead" regression net, IPC half.
//
// electron/ipc/chat.ipc.ts used to do `sendChatMessage(...).catch(() => {})`.
// When the send threw before the first provider branch (the memory-facts
// injection failing to resolve inside the packaged bundle), the renderer got
// ZERO chunks: no delta, no error, no done. The composer spun forever and there
// was nothing in the log. This pins the contract: a rejected send ALWAYS emits
// an error chunk the renderer can render and clear its spinner on.
//
// emitSendFailureChunk() takes its sink injected, so no BrowserWindow is needed;
// electron is stubbed only because chat.ipc's import graph reaches keychain
// (safeStorage/app) and settings-store (app.getPath) at module load.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChatChunk } from '@tachi/core'

vi.mock('electron', () => ({
  ipcMain:     { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  app:         { getPath: () => '/tmp', getVersion: () => '0.0.0-test', on: vi.fn(), whenReady: () => Promise.resolve() },
  BrowserWindow: class { static getAllWindows() { return [] } },
  shell:       { openExternal: vi.fn() },
  dialog:      { showOpenDialog: vi.fn() },
  net:         { fetch: vi.fn() },
  session:     { defaultSession: { webRequest: { onBeforeRequest: vi.fn() } } },
  Notification: class { show() {} static isSupported() { return false } },
}))

import { emitSendFailureChunk } from '../../electron/ipc/chat.ipc'

function capture(err: unknown): { chunks: ChatChunk[]; logs: unknown[][] } {
  const chunks: ChatChunk[] = []
  const logs: unknown[][] = []
  emitSendFailureChunk(err, {
    send: (c) => chunks.push(c),
    log:  (msg, e) => logs.push([msg, e]),
  })
  return { chunks, logs }
}

describe('emitSendFailureChunk', () => {
  it('emits exactly one error chunk when the send rejects', () => {
    const { chunks } = capture(new Error('boom'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.type).toBe('error')
  })

  it('uses the messageId "unknown" shape the renderer resolves by conversation', () => {
    const { chunks } = capture(new Error('boom'))
    expect(chunks[0]).toEqual({
      type: 'error',
      messageId: 'unknown',
      error: { code: 'INTERNAL', message: 'boom' },
    })
  })

  it('carries a HUMAN message for the exact P0 failure (never "[object Object]")', () => {
    const { chunks } = capture(new Error("Cannot find module './settings-store'"))
    const chunk = chunks[0] as Extract<ChatChunk, { type: 'error' }>
    expect(chunk.error.message).toContain('Cannot find module')
    expect(chunk.error.message).not.toContain('[object Object]')
  })

  it('still emits a readable chunk for a non-Error rejection', () => {
    const chunk = capture({ statusCode: 502, message: 'bad gateway' }).chunks[0] as Extract<ChatChunk, { type: 'error' }>
    expect(chunk.type).toBe('error')
    expect(chunk.error.message).toContain('bad gateway')
    expect(chunk.error.message).not.toBe('undefined')
  })

  it('emits a chunk even when the rejection value is undefined', () => {
    const chunk = capture(undefined).chunks[0] as Extract<ChatChunk, { type: 'error' }>
    expect(chunk.type).toBe('error')
    expect(chunk.error.message.length).toBeGreaterThan(0)
  })

  it('logs the failure once (the old catch logged nothing at all)', () => {
    const { logs } = capture(new Error('boom'))
    expect(logs).toHaveLength(1)
    expect(String(logs[0]![0])).toContain('chat:send')
  })

  it('works without a logger (log is optional)', () => {
    const chunks: ChatChunk[] = []
    expect(() => emitSendFailureChunk(new Error('boom'), { send: (c) => chunks.push(c) })).not.toThrow()
    expect(chunks).toHaveLength(1)
  })
})

describe('the PRIVATE MODE refusal is provider-agnostic (Kilo was only the witness)', () => {
  // Driver 2026-08-01: main correctly blocked kilo-gateway (no ledger row) but
  // the renderer showed nothing for 3+ minutes. The refusal itself was never
  // Kilo-specific — ONE gate runs before EVERY provider branch — so the fix
  // (chat.store rendering a messageId:'unknown' error) covers every cloud
  // provider at once. This pins the "one gate, ahead of all branches" shape.
  const read = (rel: string) =>
    readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('one egress gate sits BEFORE the first provider branch', () => {
    const src = read('electron/services/chat-service.ts')
    const gate = src.indexOf("sendError('PRIVATE_MODE_BLOCKED'")
    expect(gate).toBeGreaterThan(0)
    // every provider branch dispatches on effectiveProviderId; none may precede
    // the gate.
    const firstBranch = src.indexOf("if (effectiveProviderId === ")
    expect(firstBranch).toBeGreaterThan(gate)
    // …and there is exactly ONE such refusal, not a per-provider copy.
    expect(src.split("sendError('PRIVATE_MODE_BLOCKED'").length - 1).toBe(1)
  })

  it('the refusal message names the blocked provider, so the bubble is actionable', () => {
    const policy = read('electron/services/egress-policy.ts')
    expect(policy).toContain('PRIVATE MODE blocks ${kind} provider "${providerId ?? \'(none)\'}"')
  })
})
