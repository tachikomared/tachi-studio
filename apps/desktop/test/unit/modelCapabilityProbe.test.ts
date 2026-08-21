// apps/desktop/test/unit/modelCapabilityProbe.test.ts
//
// Two-gate model admission probe (STEAL 2026-06-12 cluster E;
// free-coding-models sync-set.js probeModel): gate 1 = plain-text sanity,
// gate 2 = minimal tool-call. Models that pass text but cannot emit
// tool_calls are flagged 'chat-only' so agentic surfaces (nodes, router)
// don't silently route tool work to them.

import { describe, it, expect, vi } from 'vitest'
import { probeModelCapability } from '../../electron/services/model-capability-probe'

type FetchImpl = typeof fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchImpl {
  return vi.fn(async (url: unknown, init?: unknown) => handler(String(url), (init ?? {}) as RequestInit)) as unknown as FetchImpl
}

const textOkBody = { choices: [{ message: { content: 'OK' } }] }
const toolCallBody = { choices: [{ message: { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }] } }] }
const textOnlyBody = { choices: [{ message: { content: 'I cannot use tools, but hello!' } }] }

describe('probeModelCapability', () => {
  it('verdict full when both gates pass', async () => {
    const f = mockFetch((_u, init) => {
      const req = JSON.parse(String(init.body)) as { tools?: unknown[] }
      return jsonResponse(req.tools ? toolCallBody : textOkBody)
    })
    const r = await probeModelCapability({ baseUrl: 'https://api.x.ai/v1', model: 'm', fetchImpl: f })
    expect(r.textOk).toBe(true)
    expect(r.toolsOk).toBe(true)
    expect(r.verdict).toBe('full')
  })

  it('verdict chat-only when text passes but tool gate returns plain text', async () => {
    const f = mockFetch((_u, init) => {
      const req = JSON.parse(String(init.body)) as { tools?: unknown[] }
      return jsonResponse(req.tools ? textOnlyBody : textOkBody)
    })
    const r = await probeModelCapability({ baseUrl: 'https://api.x.ai/v1', model: 'm', fetchImpl: f })
    expect(r.verdict).toBe('chat-only')
    expect(r.toolsOk).toBe(false)
  })

  it('verdict unusable when the text gate fails (HTTP error)', async () => {
    const f = mockFetch(() => jsonResponse({ error: 'nope' }, 500))
    const r = await probeModelCapability({ baseUrl: 'https://api.x.ai/v1', model: 'm', fetchImpl: f })
    expect(r.verdict).toBe('unusable')
    expect(r.textOk).toBe(false)
  })

  it('verdict unusable on network failure, with detail', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as FetchImpl
    const r = await probeModelCapability({ baseUrl: 'https://api.x.ai/v1', model: 'm', fetchImpl: f })
    expect(r.verdict).toBe('unusable')
    expect(r.detail).toMatch(/ECONNREFUSED/)
  })

  it('sends Authorization only when a key is provided', async () => {
    const seen: Array<Record<string, string>> = []
    const f = mockFetch((_u, init) => {
      seen.push((init.headers ?? {}) as Record<string, string>)
      const req = JSON.parse(String(init.body)) as { tools?: unknown[] }
      return jsonResponse(req.tools ? toolCallBody : textOkBody)
    })
    await probeModelCapability({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-123', fetchImpl: f })
    expect(seen[0]!.Authorization).toBe('Bearer sk-123')
    await probeModelCapability({ baseUrl: 'https://x/v1', model: 'm', fetchImpl: f })
    expect(seen[2]!.Authorization).toBeUndefined()
  })

  it('tolerates a malformed tool-gate response body (counts as not tools-capable)', async () => {
    const f = mockFetch((_u, init) => {
      const req = JSON.parse(String(init.body)) as { tools?: unknown[] }
      if (req.tools) return new Response('not json', { status: 200 })
      return jsonResponse(textOkBody)
    })
    const r = await probeModelCapability({ baseUrl: 'https://x/v1', model: 'm', fetchImpl: f })
    expect(r.verdict).toBe('chat-only')
  })
})
