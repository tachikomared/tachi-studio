// apps/desktop/test/unit/fusionRerunIpc.test.ts
//
// Fusion panel RE-RUN handler (electron/ipc/fusion.ipc.ts) — exercises the
// rerunMember() core logic with injected deps (a fake ChatBackend + a mocked
// cost ledger), so it never touches electron or the real provider/keychain.
//
// Mirrors the style of sidecarSpend.test.ts (assert on what ledger.record was
// called with) and the core FakeBackend pattern in fusion.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { PROVIDER_LIST, type ChatBackend, type ChatChunk, type ChatRequest } from '@tachi/core'

// fusion.ipc.ts transitively imports electron-coupled modules (provider-service
// → keychain → `import { safeStorage, app } from 'electron'`). Stub electron so
// the module loads under vitest; rerunMember() never touches it (deps injected).
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
  app: { getPath: () => '/tmp' },
}))

import { rerunMember } from '../../electron/ipc/fusion.ipc'

/** Scripted backend: yields a fixed chunk list, recording the request. */
class FakeBackend implements ChatBackend {
  id = 'fake'
  displayName = 'Fake'
  calls: ChatRequest[] = []
  constructor(private chunks: ChatChunk[]) {}
  async *sendMessage(request: ChatRequest, _apiKey: string): AsyncIterable<ChatChunk> {
    this.calls.push(request)
    for (const c of this.chunks) yield c
  }
}

const answer = (text: string): ChatChunk[] => [
  { type: 'delta', messageId: 'x', text },
  { type: 'usage', messageId: 'x', usage: { promptTokens: 5, completionTokens: 9, totalTokens: 14 } },
  { type: 'done', messageId: 'x' },
]

describe('fusion rerunMember handler', () => {
  it('runs the model and records usage under the GATEWAY that served it, not the harness', async () => {
    const backend = new FakeBackend(answer('a fresh answer'))
    const record = vi.fn()
    const res = await rerunMember(
      // 'bankr' is the legacy short alias getChatBackend still accepts — the
      // ledger must get the canonical id the resolver returned, not the
      // argument, and never the harness's own name.
      { providerId: 'bankr', model: 'glm-5.2', brief: 'plan the thing' },
      {
        resolveBackend: () => ({ backend, key: 'sk-test', providerId: 'bankr-gateway' }),
        ledger: () => ({ record }),
      },
    )
    expect(res).toEqual({ ok: true, chars: 'a fresh answer'.length })
    expect(backend.calls[0].model).toBe('glm-5.2')
    expect(backend.calls[0].messages).toEqual([{ role: 'user', content: 'plan the thing' }])
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]).toEqual(['bankr-gateway', 'glm-5.2', 5, 9])
    // The recorded id must be a REAL provider — 'tachi' matched nothing.
    expect(PROVIDER_LIST.map(p => p.id)).toContain(record.mock.calls[0]![0])
  })

  it('records each gateway under its own id (a venice leg is venice spend)', async () => {
    const backend = new FakeBackend(answer('venice answer'))
    const record = vi.fn()
    await rerunMember(
      { providerId: 'venice', model: 'zai-org-glm-4.7', brief: 'b' },
      {
        resolveBackend: () => ({ backend, key: 'k', providerId: 'venice' }),
        ledger: () => ({ record }),
      },
    )
    expect(record.mock.calls[0]![0]).toBe('venice')
  })

  it('returns ok:false (and never touches the ledger) when the provider is unknown', async () => {
    const record = vi.fn()
    const res = await rerunMember(
      { providerId: 'nope', model: 'm', brief: 'b' },
      { resolveBackend: () => null, ledger: () => ({ record }) },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Provider unavailable')
    expect(record).not.toHaveBeenCalled()
  })

  it('returns ok:false when the gateway has no API key', async () => {
    const backend = new FakeBackend(answer('unused'))
    const record = vi.fn()
    const res = await rerunMember(
      { providerId: 'bankr', model: 'm', brief: 'b' },
      { resolveBackend: () => ({ backend, key: null, providerId: 'bankr-gateway' }), ledger: () => ({ record }) },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no API key')
    expect(record).not.toHaveBeenCalled()
  })

  it('returns ok:false when the leg throws', async () => {
    const throwing: ChatBackend = {
      id: 'boom', displayName: 'Boom',
      // eslint-disable-next-line require-yield
      async *sendMessage() { throw new Error('breaker tripped') },
    }
    const record = vi.fn()
    const res = await rerunMember(
      { providerId: 'bankr', model: 'm', brief: 'b' },
      { resolveBackend: () => ({ backend: throwing, key: 'k', providerId: 'bankr-gateway' }), ledger: () => ({ record }) },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('breaker tripped')
    expect(record).not.toHaveBeenCalled()
  })
})
