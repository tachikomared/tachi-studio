// apps/desktop/test/unit/veniceMediaAssetGate.test.ts
//
// Same gap, same fix, different provider (see imgnaiMediaAssetGate.test.ts's
// header for the full argument): venice-media-service.ts's queueAndPoll()
// re-checks PRIVATE MODE before every retrieve poll, but once a poll comes
// back COMPLETED with a `download_url`, fetching that URL is a BRAND NEW
// request the per-poll gate never covered. A mode flip landing in the same
// instant the job finishes server-side used to reach that fetch with zero
// check ever having run for it. Pinned here: it must refuse instead.
//
// venice-media-service.ts has no pre-existing unit test file (the whole IO
// layer — image/tts/stt/video/music — is otherwise exercised only at
// runtime); this file is scoped to the one behaviour it now needs pinned.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ mode: 'open' as 'open' | 'private' }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('../../electron/services/keychain', () => ({ retrieveKey: () => 'venice-key-123' }))
vi.mock('../../electron/services/storage-root', () => ({
  writeStorageFile: (_area: string, rel: string, _bytes: Uint8Array) => `C:/storage/Media/${rel.replace(/\\/g, '/')}`,
}))

import { veniceSubmitVideo } from '../../electron/services/venice-media-service'

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown) {
  return {
    ok: true, status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) } as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

beforeEach(() => {
  h.mode = 'open'
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('venice queueAndPoll: the download_url fetch is gated on its own, not on the poll\'s check', () => {
  it('a flip landing when the retrieve poll reports COMPLETED blocks the download — the asset URL is never fetched', async () => {
    fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/models?type=video')) return jsonResponse({ data: [] })
      if (u.includes('/video/queue')) return jsonResponse({ queue_id: 'q1', download_url: 'https://cdn.venice.ai/asset.mp4' })
      if (u.includes('/video/retrieve')) {
        // The flip lands in the same instant the job is discovered COMPLETED —
        // before queueAndPoll can react to it.
        h.mode = 'private'
        return jsonResponse({ status: 'COMPLETED' })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(veniceSubmitVideo({ model: 'wan-2-2', prompt: 'a fox' })).rejects.toThrow(/PRIVATE MODE/)
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('cdn.venice.ai'))).toBe(false)
  })

  it('control: the same sequence with no flip downloads the asset and writes it', async () => {
    fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/models?type=video')) return jsonResponse({ data: [] })
      if (u.includes('/video/queue')) return jsonResponse({ queue_id: 'q2', download_url: 'https://cdn.venice.ai/asset2.mp4' })
      if (u.includes('/video/retrieve')) return jsonResponse({ status: 'COMPLETED' })
      if (u.includes('cdn.venice.ai')) {
        return {
          ok: true, status: 200,
          headers: { get: () => null } as unknown as Headers,
          arrayBuffer: async () => new ArrayBuffer(32),
          text: async () => '',
          json: async () => null,
        }
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const { artifacts } = await veniceSubmitVideo({ model: 'wan-2-2', prompt: 'a fox' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].path).toContain('C:/storage/Media/')
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('cdn.venice.ai'))).toBe(true)
  })
})
