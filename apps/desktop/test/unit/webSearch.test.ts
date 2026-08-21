// apps/desktop/test/unit/webSearch.test.ts
//
// Provider dispatch for web search (Brave preferred, Tavily fallback) plus the
// per-provider request/response mapping. keychain and global fetch are mocked
// so provider PICK ORDER and wire formats are tested deterministically.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../electron/services/keychain', () => ({ retrieveKey: vi.fn(() => null) }))

import { webSearch, activeWebSearchProvider, tavilySearch } from '../../electron/services/web-search-tool'
import { retrieveKey } from '../../electron/services/keychain'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.mocked(retrieveKey).mockReset()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('activeWebSearchProvider', () => {
  it('is null with no keys', () => {
    expect(activeWebSearchProvider()).toBeNull()
  })

  it('prefers Brave when both keys exist (back-compat)', () => {
    vi.mocked(retrieveKey).mockImplementation(() => 'some-key')
    expect(activeWebSearchProvider()).toBe('brave')
  })

  it('falls back to Tavily when only its key exists', () => {
    vi.mocked(retrieveKey).mockImplementation((id: string) => (id === 'tavily' ? 'tvly-x' : null))
    expect(activeWebSearchProvider()).toBe('tavily')
  })
})

describe('webSearch dispatch', () => {
  it('throws a combined error naming both providers when no key is set', async () => {
    await expect(webSearch('anything')).rejects.toThrow(/Brave or Tavily/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes to Brave (GET + X-Subscription-Token) when the Brave key exists', async () => {
    vi.mocked(retrieveKey).mockImplementation((id: string) => (id === 'brave-search' ? 'BSA-key' : null))
    fetchMock.mockResolvedValue(jsonResponse({ web: { results: [{ title: 't', url: 'https://a', description: 'd' }] } }))

    const results = await webSearch('electron csp', 3)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('api.search.brave.com')
    expect(url).toContain('count=3')
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('BSA-key')
    expect(results).toEqual([{ title: 't', url: 'https://a', description: 'd' }])
  })

  it('routes to Tavily (POST + Bearer) when only the Tavily key exists', async () => {
    vi.mocked(retrieveKey).mockImplementation((id: string) => (id === 'tavily' ? 'tvly-key' : null))
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ title: 't', url: 'https://a', content: 'snippet' }] }))

    const results = await webSearch('electron csp', 4)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tvly-key')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ query: 'electron csp', max_results: 4, search_depth: 'basic' })
    // auto_parameters must NEVER be sent — it can silently double credit cost.
    expect(body.auto_parameters).toBeUndefined()
    // Tavily's `content` maps onto the Brave-shaped `description` field.
    expect(results).toEqual([{ title: 't', url: 'https://a', description: 'snippet' }])
  })
})

describe('tavilySearch', () => {
  it('clamps count into 1-10', async () => {
    vi.mocked(retrieveKey).mockImplementation(() => 'tvly-key')
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))
    await tavilySearch('q', 99)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_results).toBe(10)
  })

  it('surfaces HTTP errors with the status code', async () => {
    vi.mocked(retrieveKey).mockImplementation(() => 'tvly-key')
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    await expect(tavilySearch('q')).rejects.toThrow(/429/)
  })
})
