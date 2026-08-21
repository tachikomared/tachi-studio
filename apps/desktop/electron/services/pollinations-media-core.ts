// apps/desktop/electron/services/pollinations-media-core.ts
//
// PURE helpers for the Pollinations keyless image engine
// (image.pollinations.ai) — no electron imports so these are unit-testable
// directly (see test/unit/pollinationsMedia.test.ts). The IO half lives in
// pollinations-media.ts.
//
// WHAT POLLINATIONS IS (probed live 2026-08-01, FREE-FLEET-SWEEP-2026-08-01.md
// §3#2 + a same-day re-probe with a nonce in every prompt):
//   • the only genuinely KEYLESS cloud image generator that answers today —
//     no account, no key, nothing to store. GET with the prompt IN THE PATH:
//       GET /prompt/<encodeURIComponent(prompt)>?width&height&seed&nologo&model
//     It is NOT OpenAI-compatible and has no POST body.
//   • GET /models → 200 `["sana"]` (an array of model-name strings).
//   • fresh nonce prompts: 200 image/jpeg every time, 2–42 s. An 8,300-char
//     ENCODED path still answered 200 (prompt echoed back in the JPEG's EXIF),
//     so the 2,000-char prompt cap below is well inside measured bounds.
//   • documented anonymous rate limit: ONE request per 15 s. The re-probe saw
//     an immediate second request QUEUED server-side (41.9 s) rather than
//     429'd, but the client still paces to the documented limit — politeness
//     that also keeps a canvas fan-out from piling onto their queue.
//   • their cache replays identical prompt+seed+size requests (~1.5 s, same
//     bytes) — which is why a run with seed -1 must ROLL a real seed before
//     the URL is built: "generate again" has to mean a new image, and the
//     rolled seed is recorded on the entry so Remix reproduces THIS image.
//
// EGRESS HONESTY: this is a CLOUD call — the prompt leaves the machine.
// 'pollinations' is listed in egress-policy's CLOUD_PROVIDER_IDS, so PRIVATE
// MODE blocks it exactly like imgnai/venice/surplus, and nothing anywhere may
// stamp its artifacts "local".

// ── Endpoint + limits ─────────────────────────────────────────────────────────

export const POLLINATIONS_BASE = 'https://image.pollinations.ai'

/** Documented anonymous tier: "One request every 15s". Enforced client-side. */
export const POLLINATIONS_MIN_INTERVAL_MS = 15_000

/** Prompt cap BEFORE encoding. Probed: an 8.3k-char encoded path (~2.5k chars
 *  decoded) still returned 200; 2,000 decoded chars encodes to ≤6k — headroom
 *  on both sides rather than an assumption. */
export const POLLINATIONS_PROMPT_MAX_CHARS = 2_000

/** ~45 s cold per the sweep; 42 s measured under their server-side throttle.
 *  4x the worst observation, because a timeout kills a real render. */
export const POLLINATIONS_FETCH_TIMEOUT_MS = 180_000

// ── Models ────────────────────────────────────────────────────────────────────

export interface PollinationsModelInfo {
  id:       string
  label:    string
  modality: 'image'
  live:     boolean
}

/** OFFLINE FALLBACK — the live GET /models list replaces this when reachable.
 *  Snapshot of 2026-08-01: exactly ["sana"]. */
export const POLLINATIONS_STATIC_MODELS: PollinationsModelInfo[] = [
  { id: 'sana', label: 'Sana', modality: 'image', live: false },
]

/** The id a node/composer with nothing selected generates with. */
export const POLLINATIONS_DEFAULT_MODEL = 'sana'

/** Title-case a bare model id for the dropdown ('sana' → 'Sana'). */
function labelFor(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * Parse GET /models. The live shape is an array of strings (`["sana"]`);
 * tolerate `{ name }` objects too in case they enrich it. Garbage → [].
 */
export function parsePollinationsModels(body: unknown): PollinationsModelInfo[] {
  if (!Array.isArray(body)) return []
  const out: PollinationsModelInfo[] = []
  for (const item of body) {
    let id = ''
    if (typeof item === 'string') id = item.trim()
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      id = ((item as { name: string }).name).trim()
    }
    if (!id) continue
    out.push({ id, label: labelFor(id), modality: 'image', live: true })
  }
  return out
}

// ── Size ──────────────────────────────────────────────────────────────────────

const SIZE_MIN = 64
const SIZE_MAX = 2048
const DEFAULT_DIM = 1024

function clampDim(n: number): number {
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)))
}

/**
 * The composer's `size` param is a "WxH" string (curated tiers, e.g.
 * '1024x1024'). Parse it into the width/height query params Pollinations
 * takes; anything unparseable falls back to 1024x1024, clamped to a sane
 * range so a hand-edited bag cannot request a 0x0 or 100k-pixel render.
 */
export function resolvePollinationsSize(size: unknown): { width: number; height: number } {
  if (typeof size === 'string') {
    const m = size.trim().match(/^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/)
    if (m) return { width: clampDim(Number(m[1])), height: clampDim(Number(m[2])) }
  }
  return { width: DEFAULT_DIM, height: DEFAULT_DIM }
}

// ── Seed ──────────────────────────────────────────────────────────────────────

/**
 * The seed that actually runs. A missing / -1 / non-finite seed is ROLLED to a
 * real random one — Pollinations caches by prompt+seed+size, so "random"
 * left to the server would replay the first render forever. The rolled value
 * is returned to the caller and recorded on the gallery entry, so a locked
 * seed (Remix) reproduces and a fresh run never replays.
 */
export function rollPollinationsSeed(seed: unknown, random: () => number = Math.random): number {
  if (typeof seed === 'number' && Number.isFinite(seed) && seed >= 0) {
    return Math.floor(seed)
  }
  return Math.floor(random() * 2_147_483_647)
}

// ── URL ───────────────────────────────────────────────────────────────────────

export interface PollinationsImageUrlInput {
  prompt: string
  model:  string
  width:  number
  height: number
  seed:   number
}

/**
 * Build the GET url — the prompt goes IN THE PATH, encodeURIComponent'd and
 * capped (see POLLINATIONS_PROMPT_MAX_CHARS). Query carries only generation
 * facts: width/height/seed/model/nologo. There is no credential and there
 * must never be a `?token=`-style anything — keyless is the entire point.
 */
export function buildPollinationsImageUrl(input: PollinationsImageUrlInput): string {
  const prompt = input.prompt.trim().slice(0, POLLINATIONS_PROMPT_MAX_CHARS)
  const q = new URLSearchParams({
    width:  String(input.width),
    height: String(input.height),
    seed:   String(input.seed),
    model:  input.model.trim() || POLLINATIONS_DEFAULT_MODEL,
    nologo: 'true',
  })
  return `${POLLINATIONS_BASE}/prompt/${encodeURIComponent(prompt)}?${q.toString()}`
}

// ── Pacing ────────────────────────────────────────────────────────────────────

/**
 * How long the NEXT request must wait, given when the last one STARTED.
 * 0 ⇒ go now. Pure — the queue in pollinations-media.ts owns the clock.
 */
export function pollinationsPacingDelay(lastStartedAt: number | null, now: number): number {
  if (lastStartedAt === null || lastStartedAt <= 0) return 0
  return Math.max(0, lastStartedAt + POLLINATIONS_MIN_INTERVAL_MS - now)
}

// ── Response verdict ──────────────────────────────────────────────────────────

/** A 200 whose body is not an image (an HTML error page, a JSON apology) is a
 *  failure, not a picture — the sweep's own lesson about trusting a 200. */
export function isPollinationsImageResponse(status: number, contentType: string | null): boolean {
  if (status < 200 || status >= 300) return false
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase()
  return ct.startsWith('image/')
}
