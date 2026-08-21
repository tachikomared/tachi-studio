// apps/desktop/electron/services/oauth-service.ts
import { randomBytes, createHash } from 'crypto'
import { createServer } from 'http'
import { shell } from 'electron'
import { storeKey, retrieveKey } from './keychain'
import { getOAuthProvider } from './provider-registry'

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// ── Redirect URIs (not provider-generic — kept as app-level constants) ────────

/** Anthropic uses a fixed copy-paste callback hosted by Anthropic's console. */
const ANTHROPIC_REDIRECT = 'https://console.anthropic.com/oauth/code/callback'

/** OpenRouter callback is a local one-shot server we spin up. */
const OPENROUTER_REDIRECT = 'http://localhost:3000/openrouter/callback'

// ── Anthropic Claude Pro/Max ─────────────────────────────────────────────────

export interface AnthropicLoginInit {
  authorizeUrl: string
  state:        string
  verifier:     string
}

/** Step 1: generate state + verifier, open browser, return state so renderer can prompt for the code. */
export function startAnthropicLogin(): AnthropicLoginInit {
  const provider = getOAuthProvider('anthropic-oauth')
  if (!provider) throw new Error('[oauth-service] Provider "anthropic-oauth" not found in registry')

  const { verifier, challenge } = generatePkce()
  const state = base64UrlEncode(randomBytes(16))
  const url = new URL(provider.authBaseUrl)
  url.searchParams.set('code', 'true')   // Anthropic-specific param to use copy-paste mode
  if (provider.clientId) url.searchParams.set('client_id', provider.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT)
  url.searchParams.set('scope', provider.scope)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return { authorizeUrl: url.toString(), state, verifier }
}

/** Step 2: user pastes code; we exchange it for tokens. */
export async function completeAnthropicLogin(
  code: string,
  state: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const provider = getOAuthProvider('anthropic-oauth')
  if (!provider) throw new Error('[oauth-service] Provider "anthropic-oauth" not found in registry')

  // Anthropic returns the code as "code#state" — split if needed
  let actualCode = code.trim()
  if (actualCode.includes('#')) {
    const [c, returnedState] = actualCode.split('#')
    if (returnedState !== state) throw new Error('OAuth state mismatch — possible CSRF; restart sign-in.')
    actualCode = c
  }

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     provider.clientId,
      code:          actualCode,
      redirect_uri:  ANTHROPIC_REDIRECT,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Anthropic token exchange failed (${res.status}): ${text}`)
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number }
  storeKey('anthropic-oauth-access', data.access_token)
  if (data.refresh_token) storeKey('anthropic-oauth-refresh', data.refresh_token)
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in }
}

export async function refreshAnthropicToken(): Promise<string | null> {
  const provider = getOAuthProvider('anthropic-oauth')
  if (!provider) return null

  let refresh: string | null
  try { refresh = retrieveKey('anthropic-oauth-refresh') } catch { return null }
  if (!refresh) return null

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     provider.clientId,
      refresh_token: refresh,
    }),
  })
  if (!res.ok) return null
  const data = await res.json() as { access_token: string; refresh_token?: string }
  storeKey('anthropic-oauth-access', data.access_token)
  if (data.refresh_token) storeKey('anthropic-oauth-refresh', data.refresh_token)
  return data.access_token
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

/**
 * Spin a one-shot HTTP server on port 3000, open the OpenRouter auth page,
 * capture the ?code=, exchange it for a persistent API key, close the server.
 * Resolves with the API key or rejects on cancel/timeout.
 */
export function startOpenRouterLogin(signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const provider = getOAuthProvider('openrouter')
    if (!provider) {
      reject(new Error('[oauth-service] Provider "openrouter" not found in registry'))
      return
    }

    const { verifier, challenge } = generatePkce()
    let done = false
    const cleanup = (): void => { try { server.close() } catch {/*ok*/} }

    const server = createServer(async (req: { url?: string }, res: { writeHead(code: number, headers?: Record<string, string>): { end(body?: string): void } }) => {
      if (done) { res.writeHead(404).end(); return }
      const url = new URL(req.url ?? '/', 'http://localhost:3000')
      if (url.pathname !== '/openrouter/callback') { res.writeHead(404).end(); return }
      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h1>Missing code</h1><p>You can close this tab.</p>')
        return
      }
      try {
        const exchangeRes = await fetch(provider.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        })
        if (!exchangeRes.ok) throw new Error(`Token exchange failed: ${exchangeRes.status}`)
        const data = await exchangeRes.json() as { key: string }
        storeKey('openrouter-oauth', data.key)
        done = true
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Signed in!</h1><p>You can close this tab and return to Tachi Studio.</p>')
        cleanup()
        resolve(data.key)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' }).end(`<h1>Error</h1><pre>${String(err)}</pre>`)
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    server.on('error', (err: Error & { code?: string }) => {
      if (!done) {
        cleanup()
        if (err.code === 'EADDRINUSE') {
          reject(new Error('Port 3000 is in use; close the other app and retry.'))
        } else {
          reject(err)
        }
      }
    })

    server.listen(3000, '127.0.0.1', () => {
      const url = new URL(provider.authBaseUrl)
      url.searchParams.set('callback_url', OPENROUTER_REDIRECT)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      shell.openExternal(url.toString())
    })

    // Abort + timeout
    signal.addEventListener('abort', () => {
      if (!done) { cleanup(); reject(new Error('cancelled')) }
    }, { once: true })
    setTimeout(() => {
      if (!done) { cleanup(); reject(new Error('OpenRouter login timed out (5 min).')) }
    }, 5 * 60_000)
  })
}
