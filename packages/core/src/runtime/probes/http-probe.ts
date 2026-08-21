import { RuntimeStatus } from '../types.js'

export interface HttpProbeResult {
  status: RuntimeStatus
  responseStatus?: number
  data?: unknown
}

export async function httpProbe(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<HttpProbeResult> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.ok) {
      let data: unknown
      try { data = await res.json() } catch { /* not JSON */ }
      return { status: 'healthy', responseStatus: res.status, data }
    }
    if (res.status === 401 || res.status === 403) return { status: 'needs_login', responseStatus: res.status }
    return { status: 'error', responseStatus: res.status }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return { status: 'not_running' }
    return { status: 'unreachable' }
  }
}
