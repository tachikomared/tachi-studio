// apps/desktop/test/unit/imgnaiMediaAssetGate.test.ts
//
// THE GAP the pollinations privacy sweep (4266c62, 2026-08-01) left open in
// imgnai-media.ts: submitAndPoll's poll loop re-checks PRIVATE MODE before
// every poll fetch, but the terminal poll's OWN gate check only covers that
// poll's fetch — settleToArtifacts → downloadAsset then dispatches a BRAND
// NEW request (the signed asset URL) with no gate at all. A job that finishes
// server-side in the same instant PRIVATE MODE is engaged would still
// download and write the file, with no check having ever run for that
// specific request. THE RULE this file exists to pin: no cloud request may
// BEGIN without a same-instant check, including one that only exists because
// the PREVIOUS request (the poll) just came back terminal.
//
// This is a DIFFERENT case from pollinations' "already in flight" one (kept
// deliberately, see pollinations-media.ts's header): the asset download has
// not been dispatched yet when the terminal poll returns, so refusing it
// prevents real egress rather than discarding one that already happened.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ mode: 'open' as 'open' | 'private' }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('../../electron/services/keychain', () => ({ retrieveKey: () => 'key123:secret456' }))
vi.mock('../../electron/services/storage-root', () => ({
  writeStorageFile: (_area: string, rel: string, _bytes: Uint8Array) => `C:/storage/Media/${rel.replace(/\\/g, '/')}`,
}))

import { imgnaiGenerateImage } from '../../electron/services/imgnai-media'

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' } as unknown as Headers,
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

describe('imgnai downloadAsset: gated even though the poll loop already checked', () => {
  it('a mode flip landing exactly when the job completes blocks the asset download — no bytes fetched, no file written', async () => {
    fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/v1/images/generations')) {
        // Submit: still processing, poll again after 1 s (imgnai-media-core
        // clamps poll_after_seconds to a [1, 30] floor — 0 defaults to 5).
        return jsonResponse({ request_id: 'req-1', status: 'processing', poll_after_seconds: 1, responses: [] })
      }
      if (u.includes('/v1/generation-requests/')) {
        // The poll that discovers completion — PRIVATE MODE flips in the SAME
        // instant the job finishes server-side, before this function can react.
        h.mode = 'private'
        return jsonResponse({
          request_id: 'req-1', status: 'completed', poll_after_seconds: 5,
          responses: [{ status: 'completed', output_assets: [{ url: 'https://cdn.example/a.png' }] }],
        })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await expect(imgnaiGenerateImage({ model: 'pink-image', prompt: 'a fox' }))
      .rejects.toThrow(/PRIVATE MODE/)

    // Exactly submit + poll — the asset URL was never dispatched.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('cdn.example'))).toBe(false)
  })

  it('control: the same sequence with no flip downloads and writes normally', async () => {
    fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/v1/images/generations')) {
        return jsonResponse({ request_id: 'req-2', status: 'processing', poll_after_seconds: 1, responses: [] })
      }
      if (u.includes('/v1/generation-requests/')) {
        return jsonResponse({
          request_id: 'req-2', status: 'completed', poll_after_seconds: 5,
          responses: [{ status: 'completed', output_assets: [{ url: 'https://cdn.example/b.png' }] }],
        })
      }
      if (u.includes('cdn.example')) {
        return {
          ok: true, status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) } as unknown as Headers,
          arrayBuffer: async () => new ArrayBuffer(16),
          text: async () => '',
          json: async () => null,
        }
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const { artifacts } = await imgnaiGenerateImage({ model: 'pink-image', prompt: 'a fox' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].path).toContain('C:/storage/Media/')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })
})
