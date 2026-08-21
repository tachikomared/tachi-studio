// apps/desktop/electron/services/hf-search.ts
//
// Live GGUF search against the public HuggingFace Hub API. Pure shaping is
// delegated to @tachi/core (normalizeHfModel) so this file is just fetch +
// glue. No auth (public models only).
//
// PRIVATE MODE: this file used to have NO egress gate — the Catalog's search
// box reached huggingface.co in PRIVATE MODE, every time, and nothing said so.
// It was the one main-process fetch path that the 2026-06-12 audit's provider
// sweep never covered, because HF is a weights host rather than a "provider".
// Found while wiring the Civitai search (spec risk R6) and fixed in the same
// pass. Precedent for the shape: imgnai-media.ts.

import { normalizeHfModel, type CatalogEntry, type HfRepoLite } from '@tachi/core'
import { enforceProviderEgress } from './egress-policy'
import { retrieveKey, hasKey as keychainHasKey } from './keychain'
// The rejected/unverified vocabulary is defined once, next to the four provider
// validators that also speak it — see provider-key-probe.ts.
import { verdictFor, unverified, type KeyProbeFailure } from './provider-key-probe'

const HF_API = 'https://huggingface.co/api'
const SEARCH_LIMIT = 20
const TIMEOUT_MS = 8000

// ─── THE TOKEN ───────────────────────────────────────────────────────────────
//
// Optional, exactly like the Civitai key and for the same reasons: search and
// public downloads work anonymously. A token raises the rate limit (the
// anonymous one is the thing that makes a burst of catalog searches start
// failing) and lets DOWNLOADS reach repos this user has personally accepted the
// terms for. It is not a login and it grants nothing they have not already
// agreed to on huggingface.co.
//
// THE CONTAINMENT RULE IS THE SAME ONE, AND IT IS NOT OPTIONAL. `hfAuthHeaders`
// is only ever applied to huggingface.co. A `/resolve/` download 302s to a
// signed CDN host (measured 2026-07-31: `us.aws.cdn.hf.co`, CloudFront presign
// with Policy/Signature/Key-Pair-Id) where the URL itself is the credential —
// forwarding a Bearer there leaks it to a third party for no benefit.
// download-manager's GATED_DOWNLOAD_HOSTS says where it is attached;
// installer-kit's isSameDownloadOrigin drops it on every cross-origin hop.

/** The keychain id. One string, shared by main, the IPC and the Settings card. */
export const HF_KEY_ID = 'huggingface'

/** Is a token stored RIGHT NOW? Never returns the secret itself. */
export function hfTokenStored(): boolean {
  try {
    return keychainHasKey(HF_KEY_ID)
  } catch {
    return false   // keychain unavailable ⇒ anonymous, not broken
  }
}

/**
 * Bearer header when the user stored a token, else `{}`.
 *
 * The EMPTY OBJECT matters: spreading `{}` adds no key at all, so an anonymous
 * request carries no `Authorization` header rather than an empty one (which
 * some edges treat as a malformed credential and 400).
 */
export function hfAuthHeaders(): Record<string, string> {
  try {
    const key = retrieveKey(HF_KEY_ID)
    return key ? { Authorization: `Bearer ${key}` } : {}
  } catch {
    return {}
  }
}

export type HfTokenProbe = { ok: true; name: string } | KeyProbeFailure

/**
 * Validate a token by asking HF who it belongs to.
 *
 * `/api/whoami-v2` is the canonical identity endpoint and it is the right probe
 * precisely because it ANSWERS WITH A NAME: "valid" is a claim the user cannot
 * check, "you are dmitry" is one they can. A token pasted from the wrong
 * account validates fine and then fails on exactly the gated repo they wanted.
 *
 * Takes the token as an ARGUMENT rather than reading the keychain: the card
 * pings BEFORE it saves, so that a rejected token is never stored.
 *
 * REJECTED vs UNVERIFIED (`verdictFor`, shared with the four provider
 * validators in provider-key-probe.ts): only HF's 401 says anything about the
 * token. An offline machine, a PRIVATE MODE denial, a 5xx or a 403 (which on HF
 * is a scope problem, not a bad token) are UNVERIFIED — the card stores the
 * token and says it could not be checked, because refusing to save on a network
 * blip strands a token that works. Never throws.
 */
export async function validateHfToken(token: string): Promise<HfTokenProbe> {
  const t = typeof token === 'string' ? token.trim() : ''
  // No network for an empty box — and no egress check either, since nothing
  // would be sent. Nothing was asked, so nothing was rejected.
  if (!t) return unverified()
  try {
    enforceProviderEgress(HF_KEY_ID)
    const res = await fetch(`${HF_API}/whoami-v2`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${t}` },
      signal: timeout(),
    })
    if (!res.ok) return verdictFor(res.status)
    const body = await res.json() as { name?: unknown }
    return { ok: true, name: typeof body?.name === 'string' ? body.name : '' }
  } catch {
    return unverified()
  }
}

interface HfListItem {
  id: string
  downloads?: number
  likes?: number
  tags?: string[]
  pipeline_tag?: string
}
interface HfTreeEntry { type: string; path: string; size?: number }

function timeout() {
  return AbortSignal.timeout(TIMEOUT_MS) as AbortSignal
}

/**
 * Search GGUF repos by free-text query. Returns CatalogEntry[] (entries with
 * no .gguf files are dropped). Throws on network/timeout so the IPC layer can
 * surface a typed failure.
 *
 * The search list already carries downloads/likes/tags/pipeline_tag, so per
 * repo we only fetch the file tree — which, unlike the bare model object,
 * carries per-file `size` (the model object's `siblings` omit sizes, which is
 * why fit badges were previously meaningless).
 */
export async function searchHuggingFace(query: string): Promise<CatalogEntry[]> {
  // FIRST LINE, before the URL is even built — no request is constructed, let
  // alone sent, when PRIVATE MODE is on.
  enforceProviderEgress(HF_KEY_ID)

  // ONE header map for every request in this call. Both targets are
  // huggingface.co — the only host this token is ever sent to.
  const auth = hfAuthHeaders()

  const url = `${HF_API}/models?filter=gguf&search=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&sort=downloads&direction=-1`
  const listRes = await fetch(url, { headers: { ...auth }, signal: timeout() })
  if (!listRes.ok) throw new Error(`HF search returned ${listRes.status}`)
  const list = await listRes.json() as HfListItem[]

  const entries = await Promise.all(list.map(async (item): Promise<CatalogEntry | null> => {
    try {
      const tree = await fetch(`${HF_API}/models/${item.id}/tree/main?recursive=true`, { headers: { ...auth }, signal: timeout() })
        .then(r => r.ok ? r.json() as Promise<HfTreeEntry[]> : [])
        .catch(() => [] as HfTreeEntry[])

      // Build siblings from the tree so each file carries its real size.
      const siblings = tree
        .filter(f => f.type === 'file')
        .map(f => ({ rfilename: f.path, size: f.size }))
      if (siblings.length === 0) return null

      const repo: HfRepoLite = {
        id: item.id,
        siblings,
        tags: item.tags,
        pipelineTag: item.pipeline_tag,
        downloads: item.downloads,
        likes: item.likes,
      }
      return normalizeHfModel(repo)
    } catch {
      return null
    }
  }))

  return entries.filter((e): e is CatalogEntry => e != null)
}
