// apps/desktop/electron/services/browser-session.ts
//
// Interactive browser SESSIONS for the TACHI harness — the stateful upgrade of
// the one-shot `browse(url)` tool (page-render.ts). A session keeps ONE page of
// the shared managed chrome-headless-shell alive across tool calls so the agent
// can open a page, read its interactive elements, click/type/scroll by CSS
// selector, and read again — a real operate-the-web loop instead of a snapshot.
//
// ⚠️ SECURITY: same contract as page-render.ts, enforced HERE (never trusted to
// callers):
//   • BEFORE any navigation (open + the `navigate` action): http(s)-only parse,
//     checkUrlEgressSafe (PRIVATE MODE fail-closed + SSRF screen), then
//     resolveAndAssertSafe (DNS resolve + non-global/encoded-IP block).
//   • AFTER any navigation: every redirect hop AND the committed url re-face the
//     same screen (a clean url can 30x to 169.254.169.254 — firecrawl pattern).
//   • AFTER EVERY action: the landed page.url() is re-screened. A click can
//     navigate cross-origin (or to an internal host); if the landed url fails
//     the guard the session is CLOSED and the call throws — we never keep a
//     live handle onto a page we weren't allowed to reach.
// Chromium re-resolves DNS on navigate (we can't pin its resolver), so this is
// validate-then-connect — the same accepted residual as page-render/deep_research.
//
// Resource discipline: at most MAX_SESSIONS concurrent sessions (each is a full
// Chromium), and every session self-destructs after IDLE_TTL_MS without an op
// (the timer resets on open/act/read). closeAllBrowserSessions() is the app-quit
// sweep. The puppeteer launch is behind an injectable factory so the registry /
// TTL / cap bookkeeping is unit-testable without a real browser.

import type { BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { checkUrlEgressSafe } from './egress-policy'
import { resolveAndAssertSafe } from './ssrf-guard'
import { getChromiumPath, installChromium } from './chromium-installer'

// ─── Tunables ────────────────────────────────────────────────────────────────

const MAX_SESSIONS = 3           // each session is a whole Chromium — keep it tight
const IDLE_TTL_MS = 5 * 60_000   // auto-close after 5 min without an op
const NAV_TIMEOUT_MS = 30_000    // page.goto budget (matches page-render)
const SETTLE_TIMEOUT_MS = 3_000  // post-click/press grace for a triggered navigation
const TEXT_CAP = 15_000          // snapshot innerText cap
const MAX_ELEMENTS = 40          // snapshot interactive-element cap
const EXTRACT_CAP = 60           // raw records harvested in-page (summarize trims to 40)

// ─── Types ───────────────────────────────────────────────────────────────────

/** One interactive element as harvested in-page (plain data — no DOM handles). */
export interface ExtractedElement {
  tag: string
  id?: string
  name?: string
  /** Visible text content, whitespace-collapsed (empty for bare inputs). */
  text?: string
  ariaLabel?: string
  placeholder?: string
  /** `type` attribute (inputs/buttons), for labelling bare controls. */
  type?: string
  /** nth-of-type CSS path from the nearest id'd ancestor (or body) — the fallback selector. */
  path: string
}

export interface BrowserSnapshot {
  title: string
  url: string
  /** Rendered innerText, capped at 15k chars. */
  text: string
  /** Numbered list of up to 40 interactive elements with selector-hints. */
  elements: string
}

export interface BrowserAction {
  kind: 'click' | 'type' | 'press' | 'scroll' | 'navigate'
  /** click/type target (a selector-hint from a previous snapshot, or any CSS selector). */
  selector?: string
  /** type: the text to type into the focused element. */
  text?: string
  /** press: a puppeteer keyboard key name (e.g. "Enter", "Tab", "ArrowDown"). */
  key?: string
  /** scroll: vertical delta in px (positive = down). */
  dy?: number
  /** navigate: the url to go to (faces the full egress/SSRF guard). */
  url?: string
}

// ─── Injectable browser seam (registry logic testable without Chromium) ──────

/** The slice of puppeteer's Page the session layer actually uses. */
export interface SessionPage {
  goto(url: string, opts?: { waitUntil?: 'networkidle2'; timeout?: number }): Promise<{
    request(): { redirectChain(): Array<{ url(): string }> }
  } | null>
  url(): string
  title(): Promise<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate(fn: (...a: any[]) => unknown, ...args: unknown[]): Promise<any>
  click(selector: string): Promise<void>
  focus(selector: string): Promise<void>
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> }
  setDefaultNavigationTimeout?(ms: number): void
  /** Optional (absent in test fakes): awaited around click/press/navigate to let a triggered nav settle. */
  waitForNavigation?(opts?: { waitUntil?: 'networkidle2'; timeout?: number }): Promise<unknown>
}

export interface SessionBrowser {
  newPage(): Promise<SessionPage>
  close(): Promise<void>
}

export type LaunchBrowser = (opts: { win?: BrowserWindow | null }) => Promise<SessionBrowser>

let launchOverride: LaunchBrowser | null = null
/** TEST-ONLY: swap the puppeteer launch for a fake. Pass null to restore. */
export function __setLaunchBrowserForTests(fn: LaunchBrowser | null): void { launchOverride = fn }

/** Real launcher: shared managed chrome-headless-shell via puppeteer-core (both lazy — heavy). */
async function defaultLaunch(opts: { win?: BrowserWindow | null }): Promise<SessionBrowser> {
  const executablePath = getChromiumPath() ?? await installChromium(opts.win ?? null)
  const mod = await import('puppeteer-core')
  const puppeteer = (mod as unknown as { default?: typeof import('puppeteer-core') }).default ?? mod
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,                                     // chrome-headless-shell is headless-only
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  return browser as unknown as SessionBrowser
}

// ─── URL guards (identical contract to page-render.ts) ───────────────────────

/** http(s)-only parse → egress policy → DNS/SSRF resolve. Throws on any failure. */
async function assertUrlAllowed(url: string): Promise<void> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`browser session: invalid URL "${url}"`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`browser session: only http(s) URLs are allowed (got ${parsed.protocol})`)
  }
  const decision = await checkUrlEgressSafe(url)         // privacy mode + SSRF screen
  if (!decision.allowed) throw new Error(decision.reason ?? 'browser session: blocked by egress policy')
  await resolveAndAssertSafe(url)                        // DNS resolve + non-global/encoded-IP block (throws)
}

/**
 * SSRF redirect re-check after a goto: every redirect hop and the committed url
 * re-face the guard (the pre-goto screen only saw the REQUESTED url).
 */
async function recheckHops(
  response: Awaited<ReturnType<SessionPage['goto']>>,
  page: SessionPage,
  requestedUrl: string,
): Promise<void> {
  const hops = new Set<string>()
  for (const req of response?.request().redirectChain() ?? []) hops.add(req.url())
  hops.add(page.url())
  for (const hop of hops) {
    if (hop === requestedUrl) continue                   // already validated pre-goto
    await assertUrlAllowed(hop)
  }
}

// ─── Pure element summarization (exported for unit tests) ────────────────────

const CSS_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const escapeAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * Build a robust unique-ish CSS selector for an extracted element:
 * id (best) > name attribute > the harvested nth-of-type path (last resort).
 */
export function buildSelectorHint(el: ExtractedElement): string {
  if (el.id) return CSS_IDENT_RE.test(el.id) ? `#${el.id}` : `[id="${escapeAttr(el.id)}"]`
  if (el.name) return `${el.tag}[name="${escapeAttr(el.name)}"]`
  return el.path || el.tag
}

/**
 * Render extracted elements as the compact numbered list the model acts from:
 *   N. <tag> "label" selector-hint
 * Label precedence: visible text > aria-label > placeholder > name > type.
 */
export function summarizeElements(els: ExtractedElement[], max: number = MAX_ELEMENTS): string {
  const lines: string[] = []
  for (const el of els.slice(0, max)) {
    const label = (el.text || el.ariaLabel || el.placeholder || el.name || el.type || '')
      .replace(/\s+/g, ' ').trim().slice(0, 60)
    lines.push(`${lines.length + 1}. <${el.tag}> "${label}" ${buildSelectorHint(el)}`)
  }
  return lines.length ? lines.join('\n') : '(no interactive elements found)'
}

// ─── In-page harvest ─────────────────────────────────────────────────────────

/**
 * Runs INSIDE the page (serialized by puppeteer) — collects plain records for
 * visible interactive elements, incl. an nth-of-type path anchored at the
 * nearest id'd ancestor. Must stay self-contained (no outer-scope references
 * except the `cap` argument).
 */
function harvestInteractiveElements(cap: number): ExtractedElement[] {
  const out: ExtractedElement[] = []
  const els = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]'))
  for (const el of els) {
    if (out.length >= cap) break
    if ((el as HTMLElement).getClientRects().length === 0) continue   // invisible → not actionable
    // nth-of-type path from the nearest id'd ancestor (or body) down to el.
    let path = ''
    let node: Element | null = el
    while (node && node !== document.body) {
      let k = 1
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) k++
      }
      const seg = `${node.tagName.toLowerCase()}:nth-of-type(${k})`
      path = path ? `${seg} > ${path}` : seg
      const parent: Element | null = node.parentElement
      if (parent && parent.id) { path = `#${CSS.escape(parent.id)} > ${path}`; break }
      node = parent
    }
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      type: el.getAttribute('type') || undefined,
      path,
    })
  }
  return out
}

async function takeSnapshot(page: SessionPage): Promise<BrowserSnapshot> {
  const title = await page.title()
  const url = page.url()
  const text: string = (await page.evaluate(() => document.body?.innerText ?? '')) ?? ''
  const records: ExtractedElement[] = (await page.evaluate(harvestInteractiveElements, EXTRACT_CAP)) ?? []
  return { title, url, text: text.slice(0, TEXT_CAP), elements: summarizeElements(records) }
}

// ─── Session registry ────────────────────────────────────────────────────────

interface Session {
  id: string
  browser: SessionBrowser
  page: SessionPage
  timer: ReturnType<typeof setTimeout> | null
  /** Last url that passed the guard — post-action re-checks skip when unchanged. */
  lastSafeUrl: string
}

const sessions = new Map<string, Session>()
let pendingOpens = 0   // opens in flight count against the cap (no over-subscription race)

/** Re-arm the idle self-destruct — called on every op. */
function touch(s: Session): void {
  if (s.timer) clearTimeout(s.timer)
  s.timer = setTimeout(() => { void destroySession(s.id) }, IDLE_TTL_MS)
  // Don't hold the process open just for an idle browser session.
  ;(s.timer as { unref?: () => void }).unref?.()
}

async function destroySession(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  if (s.timer) clearTimeout(s.timer)
  try { await s.browser.close() } catch { /* best-effort */ }
}

function getSession(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new Error(`browser session "${id}" not found — it may have expired (5 min idle) or been closed. Open a new one.`)
  return s
}

/** Guard the landed url after any op; on failure the session is torn down (fail closed). */
async function assertLandedUrlSafe(s: Session): Promise<void> {
  const landed = s.page.url()
  // about:blank carries no fetched content — nothing to screen.
  if (landed === s.lastSafeUrl || landed === 'about:blank') return
  try {
    await assertUrlAllowed(landed)
  } catch (e) {
    await destroySession(s.id)
    throw new Error(`browser session closed: the page navigated to a blocked url (${landed}) — ${(e as Error).message}`)
  }
  s.lastSafeUrl = landed
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Open a new interactive session: guard the url, launch a managed-Chromium
 * page, navigate, and return the first snapshot. Caps at MAX_SESSIONS.
 */
export async function openBrowserSession(
  url: string,
  opts: { win?: BrowserWindow | null } = {},
): Promise<{ sessionId: string } & BrowserSnapshot> {
  if (sessions.size + pendingOpens >= MAX_SESSIONS) {
    throw new Error(`browser session limit reached (${MAX_SESSIONS} concurrent) — close one with browser_close first.`)
  }
  await assertUrlAllowed(url)                            // BEFORE any launch (page-render contract)

  pendingOpens++
  let browser: SessionBrowser | null = null
  try {
    browser = await (launchOverride ?? defaultLaunch)(opts)
    const page = await browser.newPage()
    page.setDefaultNavigationTimeout?.(NAV_TIMEOUT_MS)
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
    await recheckHops(response, page, url)               // SSRF redirect re-check

    const s: Session = {
      id: `bs_${randomBytes(6).toString('hex')}`,
      browser, page, timer: null, lastSafeUrl: page.url(),
    }
    sessions.set(s.id, s)
    touch(s)
    const snap = await takeSnapshot(page)
    return { sessionId: s.id, ...snap }
  } catch (e) {
    // Never leak a Chromium on a failed open (blocked redirect, nav timeout, …).
    if (browser) { try { await browser.close() } catch { /* best-effort */ } }
    throw e
  } finally {
    pendingOpens--
  }
}

/**
 * Perform one action in a session and return the fresh snapshot. `navigate`
 * faces the full pre-goto guard; EVERY kind re-screens the landed page.url()
 * afterwards (a click can navigate anywhere) — a blocked landing closes the
 * session and throws.
 */
export async function actBrowserSession(sessionId: string, action: BrowserAction): Promise<BrowserSnapshot> {
  const s = getSession(sessionId)
  touch(s)
  const { page } = s

  switch (action.kind) {
    case 'click': {
      if (!action.selector) throw new Error('browser act: click needs a selector.')
      // Start listening BEFORE the click so a triggered navigation is awaited.
      const settle = page.waitForNavigation?.({ waitUntil: 'networkidle2', timeout: SETTLE_TIMEOUT_MS }).catch(() => null)
      await page.click(action.selector)
      await settle
      break
    }
    case 'type': {
      if (!action.selector) throw new Error('browser act: type needs a selector.')
      if (typeof action.text !== 'string') throw new Error('browser act: type needs text.')
      await page.focus(action.selector)
      await page.keyboard.type(action.text)
      break
    }
    case 'press': {
      if (!action.key) throw new Error('browser act: press needs a key (e.g. "Enter").')
      const settle = page.waitForNavigation?.({ waitUntil: 'networkidle2', timeout: SETTLE_TIMEOUT_MS }).catch(() => null)
      await page.keyboard.press(action.key)
      await settle
      break
    }
    case 'scroll': {
      if (typeof action.dy !== 'number' || !Number.isFinite(action.dy)) {
        throw new Error('browser act: scroll needs a numeric dy.')
      }
      await page.evaluate((dy: number) => { window.scrollBy(0, dy) }, action.dy)
      break
    }
    case 'navigate': {
      if (!action.url) throw new Error('browser act: navigate needs a url.')
      await assertUrlAllowed(action.url)                 // SAME pre-goto guard as open
      try {
        const response = await page.goto(action.url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
        await recheckHops(response, page, action.url)
      } catch (e) {
        // A blocked redirect means blocked CONTENT is already committed — fail closed.
        await destroySession(s.id)
        throw new Error(`browser session closed: navigate failed — ${(e as Error).message}`)
      }
      break
    }
    default:
      throw new Error(`browser act: unknown action kind "${(action as { kind?: string }).kind}".`)
  }

  await assertLandedUrlSafe(s)                           // click/press/scroll can navigate too
  touch(s)
  return takeSnapshot(page)
}

/** Re-read the current page of a session (also re-screens the current url — a page can self-redirect). */
export async function readBrowserSession(sessionId: string): Promise<BrowserSnapshot> {
  const s = getSession(sessionId)
  touch(s)
  await assertLandedUrlSafe(s)
  return takeSnapshot(s.page)
}

/** Close one session (idempotent — unknown ids are a no-op). */
export async function closeBrowserSession(sessionId: string): Promise<void> {
  await destroySession(sessionId)
}

/** App-quit sweep: tear down every live session (fire-and-forget closes). */
export function closeAllBrowserSessions(): void {
  for (const id of [...sessions.keys()]) void destroySession(id)
}

/** TEST-ONLY: live session count (registry bookkeeping assertions). */
export function __sessionCountForTests(): number { return sessions.size }
