// apps/desktop/electron/services/web-search-tool.ts
import { retrieveKey } from './keychain'

export const WEB_SEARCH_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current information. Returns top results with title, URL, and a short snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Be specific.' },
        count: {
          type: 'integer',
          description: 'Number of results (1-10, default 5)',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
  },
}

export interface WebSearchResult {
  title:       string
  url:         string
  description: string
}

export type WebSearchProviderId = 'brave' | 'tavily'

// Fixed API endpoints — used by callers that must run the egress-policy check
// (PRIVATE MODE → loopback only) before any search leaves the machine.
export const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, { keyId: string; apiUrl: string }> = {
  brave:  { keyId: 'brave-search', apiUrl: 'https://api.search.brave.com/res/v1/web/search' },
  tavily: { keyId: 'tavily',       apiUrl: 'https://api.tavily.com/search' },
}

/** Which provider webSearch() would use right now (Brave preferred for back-compat). */
export function activeWebSearchProvider(): WebSearchProviderId | null {
  if (retrieveKey(WEB_SEARCH_PROVIDERS.brave.keyId)) return 'brave'
  if (retrieveKey(WEB_SEARCH_PROVIDERS.tavily.keyId)) return 'tavily'
  return null
}

export async function braveSearch(query: string, count = 5): Promise<WebSearchResult[]> {
  const key = retrieveKey('brave-search')
  if (!key) throw new Error('Brave Search API key not set. Add it in Settings → Connections.')
  const url = new URL(WEB_SEARCH_PROVIDERS.brave.apiUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(Math.max(count, 1), 10)))
  const res = await fetch(url.toString(), {
    headers: {
      'X-Subscription-Token': key,
      'Accept': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Brave Search failed (HTTP ${res.status})`)
  const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description?: string }> } }
  return (data.web?.results ?? []).map(r => ({
    title:       r.title,
    url:         r.url,
    description: r.description ?? '',
  }))
}

export async function tavilySearch(query: string, count = 5): Promise<WebSearchResult[]> {
  const key = retrieveKey('tavily')
  if (!key) throw new Error('Tavily API key not set. Add it in Settings → Connections.')
  const res = await fetch(WEB_SEARCH_PROVIDERS.tavily.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(Math.max(count, 1), 10),
      // Pinned: 'basic' = 1 credit. Never send auto_parameters — it can silently
      // escalate to advanced depth (2 credits) on the user's free 1,000/mo plan.
      search_depth: 'basic',
      topic: 'general',
    }),
  })
  if (!res.ok) throw new Error(`Tavily Search failed (HTTP ${res.status})`)
  const data = await res.json() as { results?: Array<{ title: string; url: string; content?: string }> }
  return (data.results ?? []).map(r => ({
    title:       r.title,
    url:         r.url,
    description: r.content ?? '',
  }))
}

/**
 * Provider-agnostic web search: Brave if its key exists (back-compat for
 * existing users), else Tavily. All consumers (chat web_search, TACHI
 * deep_research, nodes web_search) go through this.
 */
export async function webSearch(query: string, count = 5): Promise<WebSearchResult[]> {
  const provider = activeWebSearchProvider()
  if (provider === 'brave')  return braveSearch(query, count)
  if (provider === 'tavily') return tavilySearch(query, count)
  throw new Error('No web search key set. Add a Brave or Tavily key in Settings → Connections.')
}
