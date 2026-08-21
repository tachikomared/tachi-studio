// apps/desktop/electron/services/page-render.ts
//
// renderPage(url) — fetch a web page with a REAL headless browser (runs the
// page's JS) and return its rendered HTML + visible text + title. Drives the
// shared MANAGED chrome-headless-shell (chromium-installer) via puppeteer-core's
// executablePath — the same binary the Design MP4 export uses, downloaded once.
//
// ⚠️ SECURITY: a browser fetching ARBITRARY urls is a new SSRF/egress surface, so
// every call routes through the SAME guards as http_fetch / deep_research, in the
// same order, BEFORE any browser launch:
//   1. checkUrlEgressSafe(url)  — PRIVATE MODE fail-closed + always-on SSRF screen
//   2. resolveAndAssertSafe(url) — DNS-resolve + block non-global / encoded-IP hosts
// Chromium re-resolves DNS on navigate (we can't pin its resolver), so this is
// validate-then-connect — the same accepted residual as the deep_research fetch.
//
// Consumers: an optional JS-render path for deep_research/web-search (S2) and the
// agent `browse(url)` harness tool (S3). Both are gated OFF in private mode by
// their callers; this module re-checks regardless.

import type { BrowserWindow } from 'electron'
import { checkUrlEgressSafe } from './egress-policy'
import { resolveAndAssertSafe } from './ssrf-guard'
import { getChromiumPath, installChromium } from './chromium-installer'

export interface RenderPageResult { html: string; text: string; title: string }
export interface RenderPageOptions {
  /** Window to forward first-run Chromium install-progress to. Defaults to the first open window. */
  win?: BrowserWindow | null
  /** Navigation timeout (ms). Default 30s. */
  timeoutMs?: number
  /** Cap on returned text length. Default 40k. */
  maxChars?: number
}

/**
 * Render `url` in the managed headless Chromium and return its rendered content.
 * Throws on a blocked/invalid URL (SSRF/egress) or a navigation/launch failure.
 */
/**
 * Guard + launch a managed-Chromium page for `url`, run `fn(page)`, and close.
 * Owns the entire SSRF/egress contract in ONE place: the pre-goto screen, the
 * post-goto redirect re-check (a clean url can 30x to an internal host), and
 * teardown. Both renderPage and harvestBrandFromPage build on it so the guard
 * logic can never drift between them.
 */
async function withGuardedPage<T>(
  url: string,
  opts: { win?: BrowserWindow | null; timeoutMs?: number },
  fn: (page: import('puppeteer-core').Page) => Promise<T>,
): Promise<T> {
  // ── Guard preamble (BEFORE any launch) — identical to the http_fetch path ──
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`browse: invalid URL "${url}"`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`browse: only http(s) URLs are allowed (got ${parsed.protocol})`)
  }
  const decision = await checkUrlEgressSafe(url)         // privacy mode + SSRF screen
  if (!decision.allowed) throw new Error(decision.reason ?? 'browse blocked by egress policy')
  await resolveAndAssertSafe(url)                        // DNS resolve + non-global/encoded-IP block (throws)

  // ── Ensure the shared managed Chromium (downloads on first use) ──
  const executablePath = getChromiumPath() ?? await installChromium(opts.win ?? null)

  // puppeteer-core is heavy + externalized — load lazily so it stays out of the
  // startup/import graph (matches the harness's dynamic-import convention).
  const mod = await import('puppeteer-core')
  const puppeteer = (mod as unknown as { default?: typeof import('puppeteer-core') }).default ?? mod
  const timeout = opts.timeoutMs ?? 30_000

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,                                     // chrome-headless-shell is headless-only
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage()
    page.setDefaultNavigationTimeout(timeout)
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout })

    // ── SSRF redirect re-check (STEAL 2026-07-08, firecrawl pattern) ──
    // The guards above validated the REQUESTED url, but a clean url can 30x to
    // an internal host (169.254.169.254, 10.x, a rebind) that never faced them.
    // Re-run the same egress + DNS screen on every redirect hop AND the final
    // committed url; if any is blocked, refuse the result rather than return
    // internally-sourced content.
    const hops = new Set<string>()
    for (const req of response?.request().redirectChain() ?? []) hops.add(req.url())
    hops.add(page.url())
    for (const hop of hops) {
      if (hop === url) continue                            // already validated pre-goto
      try {
        const parsedHop = new URL(hop)
        if (parsedHop.protocol !== 'http:' && parsedHop.protocol !== 'https:') {
          throw new Error(`browse: redirect to a non-http(s) target is blocked (${parsedHop.protocol})`)
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('browse:')) throw e
        throw new Error(`browse: redirect to an unparseable url is blocked (${hop})`)
      }
      const hopDecision = await checkUrlEgressSafe(hop)
      if (!hopDecision.allowed) throw new Error(`browse: redirect blocked by egress policy — ${hopDecision.reason ?? hop}`)
      await resolveAndAssertSafe(hop)                      // DNS resolve + non-global/encoded-IP block (throws)
    }

    return await fn(page)
  } finally {
    try { await browser.close() } catch { /* best-effort */ }
  }
}

export async function renderPage(url: string, opts: RenderPageOptions = {}): Promise<RenderPageResult> {
  const maxChars = opts.maxChars ?? 40_000
  return withGuardedPage(url, opts, async (page) => {
    const title = await page.title()
    const html = await page.content()
    const text = await page.evaluate(() => document.body?.innerText ?? '')
    return {
      title,
      html: html.slice(0, 2_000_000),
      text: text.slice(0, maxChars),
    }
  })
}

// ── Brand-from-URL harvest (STEAL 2026-07-08, dembrandt/open-design) ──────────

export interface BrandKit {
  url: string
  siteName: string
  /** Hex colors ranked by on-page usage (most-used first), deduped. */
  colors: string[]
  /** Font-family names seen in computed styles, most-used first. */
  fonts: string[]
  /** Best-guess logo image URL (og:image / <img> in header / favicon), if any. */
  logo?: string
  /** A few representative headline/tagline strings for tone. */
  copy: string[]
}

/**
 * Extract a site's real design tokens from a URL: render it in managed Chromium
 * and harvest computed colors (ranked by usage), fonts, a logo, and headline
 * copy. Deterministic in-page harvest (no LLM) — the caller synthesises a Brand
 * direction from this. Reuses withGuardedPage, so all the SSRF/egress guards
 * (incl. the redirect re-check) apply.
 */
export async function harvestBrandFromPage(url: string, opts: { win?: BrowserWindow | null } = {}): Promise<BrandKit> {
  return withGuardedPage(url, { ...opts, timeoutMs: 30_000 }, async (page) => {
    const harvest = await page.evaluate(() => {
      const norm = (c: string): string | null => {
        const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c.replace(/\s+/g, ' ').trim())
        if (!m) return null
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1
        if (a < 0.05) return null                                  // fully transparent → ignore
        const hex = (n: string) => Number(n).toString(16).padStart(2, '0')
        return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`.toLowerCase()
      }
      const colorCounts = new Map<string, number>()
      const fontCounts = new Map<string, number>()
      const els = Array.from(document.querySelectorAll('body *')).slice(0, 4000)
      for (const el of els) {
        const cs = getComputedStyle(el)
        for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
          const hex = norm(cs.getPropertyValue(prop))
          if (hex && hex !== '#000000' && hex !== '#ffffff') colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1)
        }
        const ff = cs.fontFamily.split(',')[0]?.replace(/["']/g, '').trim()
        if (ff) fontCounts.set(ff, (fontCounts.get(ff) ?? 0) + 1)
      }
      const rank = (m: Map<string, number>, n: number) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0])

      const meta = (name: string) =>
        (document.querySelector(`meta[property="${name}"], meta[name="${name}"]`) as HTMLMetaElement | null)?.content ?? ''
      const abs = (u: string | null | undefined) => { try { return u ? new URL(u, location.href).href : '' } catch { return '' } }
      const headerImg = document.querySelector('header img, [class*="logo" i] img, img[alt*="logo" i]') as HTMLImageElement | null
      const favicon = (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href
      // Reject degenerate values (empty, bare `data:,`) so a placeholder favicon
      // doesn't masquerade as a logo.
      const realUrl = (u: string) => (/^https?:\/\/\S+/.test(u) || /^data:image\/\S+;base64,\S{16,}/.test(u)) ? u : ''
      const logo = realUrl(abs(meta('og:image'))) || realUrl(abs(headerImg?.src)) || realUrl(abs(favicon)) || undefined

      const siteName = meta('og:site_name') || document.title || location.hostname
      const copy: string[] = []
      const tagline = meta('og:description') || meta('description')
      if (tagline) copy.push(tagline)
      for (const h of Array.from(document.querySelectorAll('h1, h2')).slice(0, 4)) {
        const t = (h.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (t && t.length < 120 && !copy.includes(t)) copy.push(t)
      }
      return { colors: rank(colorCounts, 8), fonts: rank(fontCounts, 4), logo, siteName, copy: copy.slice(0, 5) }
    })
    return { url, ...harvest }
  })
}

/** Render a harvested BrandKit into a markdown "brand direction" block for the design prompt. */
export function brandKitToMarkdown(kit: BrandKit): string {
  const lines: string[] = [`# Brand: ${kit.siteName}`, `Source: ${kit.url}`, '']
  if (kit.colors.length) lines.push(`**Palette** (most-used first): ${kit.colors.join(', ')}`)
  if (kit.fonts.length) lines.push(`**Typefaces**: ${kit.fonts.join(', ')}`)
  if (kit.logo) lines.push(`**Logo**: ${kit.logo}`)
  if (kit.copy.length) { lines.push('', '**Voice / headlines**:'); for (const c of kit.copy) lines.push(`- ${c}`) }
  lines.push('', 'Design in THIS brand: use the palette above as the primary colors, echo the typographic feel, and match the voice.')
  return lines.join('\n')
}
