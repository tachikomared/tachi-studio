// apps/desktop/test/unit/browserSession.test.ts
//
// Interactive browser sessions (browser-session.ts): the PURE element
// summarization / selector-hint builders, plus the session-registry
// bookkeeping (cap, idle TTL, guard-driven teardown) with the puppeteer
// launch swapped for an injected fake — fully offline, no Chromium.
import { describe, it, expect, vi, afterEach } from 'vitest'

// The module's guard imports pull electron (privacy mirror / userData paths) —
// mock all three so the test stays offline AND the egress decision is scriptable.
const { egressState, guards } = vi.hoisted(() => ({
  egressState: { blocked: new Set<string>() },
  guards: { egressCalls: [] as string[], resolveCalls: [] as string[] },
}))

vi.mock('../../electron/services/egress-policy', () => ({
  checkUrlEgressSafe: vi.fn(async (url: string) => {
    guards.egressCalls.push(url)
    return egressState.blocked.has(url)
      ? { allowed: false, reason: `blocked-by-test: ${url}` }
      : { allowed: true }
  }),
}))
vi.mock('../../electron/services/ssrf-guard', () => ({
  resolveAndAssertSafe: vi.fn(async (url: string) => { guards.resolveCalls.push(url) }),
}))
vi.mock('../../electron/services/chromium-installer', () => ({
  getChromiumPath: vi.fn(() => 'C:/fake/chrome-headless-shell.exe'),
  installChromium: vi.fn(async () => 'C:/fake/chrome-headless-shell.exe'),
}))

import {
  openBrowserSession,
  actBrowserSession,
  readBrowserSession,
  closeBrowserSession,
  closeAllBrowserSessions,
  buildSelectorHint,
  summarizeElements,
  __setLaunchBrowserForTests,
  __sessionCountForTests,
  type ExtractedElement,
  type SessionBrowser,
  type SessionPage,
} from '../../electron/services/browser-session'

// ─── Fake browser/page (injected via __setLaunchBrowserForTests) ─────────────

interface FakeBrowser extends SessionBrowser {
  closed: boolean
  page: SessionPage & { _setUrl(u: string): void }
  close: ReturnType<typeof vi.fn>
}

function makeFakeBrowser(opts: { onClickUrl?: string } = {}): FakeBrowser {
  let currentUrl = 'about:blank'
  const page = {
    goto: vi.fn(async (u: string) => { currentUrl = u; return null }),
    url: () => currentUrl,
    title: async () => 'Fake Page',
    // Route the module's three evaluate() calls by their serialized source:
    // innerText snapshot, in-page element harvest, and scrollBy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluate: vi.fn(async (fn: (...a: any[]) => unknown) => {
      const src = String(fn)
      if (src.includes('innerText')) return 'hello body text'
      if (src.includes('querySelectorAll')) {
        return [
          { tag: 'a', text: 'Home', path: 'a:nth-of-type(1)' },
          { tag: 'input', name: 'q', placeholder: 'Search…', path: 'form:nth-of-type(1) > input:nth-of-type(1)' },
        ] satisfies ExtractedElement[]
      }
      return undefined
    }),
    click: vi.fn(async () => { if (opts.onClickUrl) currentUrl = opts.onClickUrl }),
    focus: vi.fn(async () => {}),
    keyboard: { type: vi.fn(async () => {}), press: vi.fn(async () => {}) },
    setDefaultNavigationTimeout: vi.fn(),
    _setUrl: (u: string) => { currentUrl = u },
  }
  const browser: FakeBrowser = {
    closed: false,
    page: page as unknown as FakeBrowser['page'],
    newPage: async () => page as unknown as SessionPage,
    close: vi.fn(async () => { browser.closed = true }),
  }
  return browser
}

/** Inject a factory that hands out one fake browser per launch, recorded for assertions. */
function injectFakes(opts: { onClickUrl?: string } = {}): FakeBrowser[] {
  const launched: FakeBrowser[] = []
  __setLaunchBrowserForTests(async () => {
    const b = makeFakeBrowser(opts)
    launched.push(b)
    return b
  })
  return launched
}

afterEach(() => {
  closeAllBrowserSessions()
  __setLaunchBrowserForTests(null)
  egressState.blocked.clear()
  guards.egressCalls.length = 0
  guards.resolveCalls.length = 0
  vi.useRealTimers()
})

// ─── Pure: buildSelectorHint ─────────────────────────────────────────────────

describe('buildSelectorHint', () => {
  const base: ExtractedElement = { tag: 'button', path: 'div:nth-of-type(2) > button:nth-of-type(1)' }

  it('prefers a simple id as #id', () => {
    expect(buildSelectorHint({ ...base, id: 'submit-btn', name: 'go' })).toBe('#submit-btn')
  })

  it('falls back to an attribute selector for CSS-hostile ids', () => {
    expect(buildSelectorHint({ ...base, id: '1weird:id' })).toBe('[id="1weird:id"]')
    expect(buildSelectorHint({ ...base, id: 'he said "hi"' })).toBe('[id="he said \\"hi\\""]')
  })

  it('uses tag[name=…] when there is no id', () => {
    expect(buildSelectorHint({ tag: 'input', name: 'q', path: 'input:nth-of-type(1)' })).toBe('input[name="q"]')
  })

  it('falls back to the nth-of-type path, then the bare tag', () => {
    expect(buildSelectorHint(base)).toBe('div:nth-of-type(2) > button:nth-of-type(1)')
    expect(buildSelectorHint({ tag: 'a', path: '' })).toBe('a')
  })
})

// ─── Pure: summarizeElements ─────────────────────────────────────────────────

describe('summarizeElements', () => {
  it('renders numbered lines with label precedence text > aria-label > placeholder > name > type', () => {
    const els: ExtractedElement[] = [
      { tag: 'a', text: 'Docs', path: 'a:nth-of-type(1)' },
      { tag: 'button', ariaLabel: 'Close dialog', path: 'button:nth-of-type(1)' },
      { tag: 'input', placeholder: 'Search…', path: 'input:nth-of-type(1)' },
      { tag: 'input', name: 'email', path: 'input:nth-of-type(2)' },
      { tag: 'input', type: 'checkbox', path: 'input:nth-of-type(3)' },
    ]
    const out = summarizeElements(els).split('\n')
    expect(out[0]).toBe('1. <a> "Docs" a:nth-of-type(1)')
    expect(out[1]).toBe('2. <button> "Close dialog" button:nth-of-type(1)')
    expect(out[2]).toBe('3. <input> "Search…" input:nth-of-type(1)')
    expect(out[3]).toBe('4. <input> "email" input[name="email"]')
    expect(out[4]).toBe('5. <input> "checkbox" input:nth-of-type(3)')
  })

  it('collapses whitespace and truncates long labels to 60 chars', () => {
    const long = 'x'.repeat(200)
    const out = summarizeElements([{ tag: 'a', text: `  a \n  b   ${long}`, path: 'a:nth-of-type(1)' }])
    expect(out).toContain('"a b ')
    const label = /"([^"]*)"/.exec(out)![1]
    expect(label.length).toBeLessThanOrEqual(60)
  })

  it('caps at 40 elements by default', () => {
    const els: ExtractedElement[] = Array.from({ length: 55 }, (_, i) => ({
      tag: 'a', text: `link ${i}`, path: `a:nth-of-type(${i + 1})`,
    }))
    const lines = summarizeElements(els).split('\n')
    expect(lines).toHaveLength(40)
    expect(lines[39]).toMatch(/^40\. /)
  })

  it('returns a placeholder when nothing was found', () => {
    expect(summarizeElements([])).toBe('(no interactive elements found)')
  })
})

// ─── Registry: open / cap / close ────────────────────────────────────────────

describe('session registry', () => {
  it('open guards the url, navigates, and returns sessionId + snapshot', async () => {
    const launched = injectFakes()
    const r = await openBrowserSession('http://example.com/')
    expect(r.sessionId).toMatch(/^bs_/)
    expect(r.title).toBe('Fake Page')
    expect(r.text).toBe('hello body text')
    expect(r.elements).toContain('1. <a> "Home" a:nth-of-type(1)')
    expect(r.elements).toContain('input[name="q"]')
    expect(launched[0].page.goto).toHaveBeenCalledWith('http://example.com/', expect.anything())
    // Both guard stages ran on the requested url BEFORE launch.
    expect(guards.egressCalls).toContain('http://example.com/')
    expect(guards.resolveCalls).toContain('http://example.com/')
    expect(__sessionCountForTests()).toBe(1)
  })

  it('open refuses a blocked url before launching anything', async () => {
    const launched = injectFakes()
    egressState.blocked.add('http://blocked.example/')
    await expect(openBrowserSession('http://blocked.example/')).rejects.toThrow(/blocked-by-test/)
    expect(launched).toHaveLength(0)
    expect(__sessionCountForTests()).toBe(0)
  })

  it('open refuses non-http(s) and invalid urls', async () => {
    injectFakes()
    await expect(openBrowserSession('file:///etc/passwd')).rejects.toThrow(/only http\(s\)/)
    await expect(openBrowserSession('not a url')).rejects.toThrow(/invalid URL/)
  })

  it('open tears the browser down when a redirect lands on a blocked url', async () => {
    const launched = injectFakes()
    egressState.blocked.add('http://internal.example/')
    __setLaunchBrowserForTests(async () => {
      const b = makeFakeBrowser()
      // Simulate a 30x: goto commits a DIFFERENT url than requested.
      ;(b.page.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        b.page._setUrl('http://internal.example/')
        return null
      })
      launched.push(b)
      return b
    })
    await expect(openBrowserSession('http://clean.example/')).rejects.toThrow(/blocked-by-test/)
    expect(launched[0].closed).toBe(true)
    expect(__sessionCountForTests()).toBe(0)
  })

  it('caps concurrent sessions at 3 and close frees a slot', async () => {
    injectFakes()
    const a = await openBrowserSession('http://one.example/')
    await openBrowserSession('http://two.example/')
    await openBrowserSession('http://three.example/')
    await expect(openBrowserSession('http://four.example/')).rejects.toThrow(/limit reached/)
    await closeBrowserSession(a.sessionId)
    expect(__sessionCountForTests()).toBe(2)
    await expect(openBrowserSession('http://four.example/')).resolves.toBeTruthy()
  })

  it('read/act on an unknown or closed session throws', async () => {
    injectFakes()
    await expect(readBrowserSession('bs_nope')).rejects.toThrow(/not found/)
    const r = await openBrowserSession('http://example.com/')
    await closeBrowserSession(r.sessionId)
    await expect(actBrowserSession(r.sessionId, { kind: 'scroll', dy: 100 })).rejects.toThrow(/not found/)
  })

  it('closeAllBrowserSessions closes every browser', async () => {
    const launched = injectFakes()
    await openBrowserSession('http://one.example/')
    await openBrowserSession('http://two.example/')
    closeAllBrowserSessions()
    expect(__sessionCountForTests()).toBe(0)
    await vi.waitFor(() => { for (const b of launched) expect(b.closed).toBe(true) })
  })
})

// ─── Registry: actions + landed-url guard ────────────────────────────────────

describe('actBrowserSession', () => {
  it('click drives page.click with the selector and returns a fresh snapshot', async () => {
    const launched = injectFakes()
    const r = await openBrowserSession('http://example.com/')
    const snap = await actBrowserSession(r.sessionId, { kind: 'click', selector: '#submit-btn' })
    expect(launched[0].page.click).toHaveBeenCalledWith('#submit-btn')
    expect(snap.title).toBe('Fake Page')
    expect(snap.url).toBe('http://example.com/')
  })

  it('type focuses the selector then types; press hits the keyboard; scroll evaluates', async () => {
    const launched = injectFakes()
    const r = await openBrowserSession('http://example.com/')
    await actBrowserSession(r.sessionId, { kind: 'type', selector: 'input[name="q"]', text: 'hello' })
    expect(launched[0].page.focus).toHaveBeenCalledWith('input[name="q"]')
    expect(launched[0].page.keyboard.type).toHaveBeenCalledWith('hello')
    await actBrowserSession(r.sessionId, { kind: 'press', key: 'Enter' })
    expect(launched[0].page.keyboard.press).toHaveBeenCalledWith('Enter')
    await actBrowserSession(r.sessionId, { kind: 'scroll', dy: 500 })
    // The scroll evaluate got the dy argument.
    const scrollCall = (launched[0].page.evaluate as ReturnType<typeof vi.fn>).mock.calls
      .find(c => String(c[0]).includes('scrollBy'))
    expect(scrollCall?.[1]).toBe(500)
  })

  it('validates action arguments per kind', async () => {
    injectFakes()
    const r = await openBrowserSession('http://example.com/')
    await expect(actBrowserSession(r.sessionId, { kind: 'click' })).rejects.toThrow(/needs a selector/)
    await expect(actBrowserSession(r.sessionId, { kind: 'type', selector: 'input' })).rejects.toThrow(/needs text/)
    await expect(actBrowserSession(r.sessionId, { kind: 'press' })).rejects.toThrow(/needs a key/)
    await expect(actBrowserSession(r.sessionId, { kind: 'scroll' })).rejects.toThrow(/numeric dy/)
    await expect(actBrowserSession(r.sessionId, { kind: 'navigate' })).rejects.toThrow(/needs a url/)
    expect(__sessionCountForTests()).toBe(1) // arg errors never kill the session
  })

  it('a click that lands on a BLOCKED url closes the session and throws', async () => {
    const launched = injectFakes({ onClickUrl: 'http://evil.internal/' })
    egressState.blocked.add('http://evil.internal/')
    const r = await openBrowserSession('http://example.com/')
    await expect(actBrowserSession(r.sessionId, { kind: 'click', selector: 'a' }))
      .rejects.toThrow(/session closed.*blocked/)
    expect(__sessionCountForTests()).toBe(0)
    expect(launched[0].closed).toBe(true)
    await expect(readBrowserSession(r.sessionId)).rejects.toThrow(/not found/)
  })

  it('a click that lands on an ALLOWED cross-page url re-screens it and continues', async () => {
    injectFakes({ onClickUrl: 'http://example.com/next' })
    const r = await openBrowserSession('http://example.com/')
    const snap = await actBrowserSession(r.sessionId, { kind: 'click', selector: 'a' })
    expect(snap.url).toBe('http://example.com/next')
    expect(guards.egressCalls).toContain('http://example.com/next')
    expect(__sessionCountForTests()).toBe(1)
  })

  it('navigate re-runs the full pre-goto guard; a blocked target leaves the session alive', async () => {
    const launched = injectFakes()
    const r = await openBrowserSession('http://example.com/')
    egressState.blocked.add('http://blocked.example/')
    await expect(actBrowserSession(r.sessionId, { kind: 'navigate', url: 'http://blocked.example/' }))
      .rejects.toThrow(/blocked-by-test/)
    expect(launched[0].page.goto).toHaveBeenCalledTimes(1) // only the original open
    expect(__sessionCountForTests()).toBe(1)               // refused BEFORE goto → session survives
    const snap = await actBrowserSession(r.sessionId, { kind: 'navigate', url: 'http://example.com/other' })
    expect(snap.url).toBe('http://example.com/other')
  })
})

// ─── Registry: idle TTL ──────────────────────────────────────────────────────

describe('idle TTL', () => {
  it('auto-closes a session after 5 idle minutes', async () => {
    vi.useFakeTimers()
    const launched = injectFakes()
    await openBrowserSession('http://example.com/')
    expect(__sessionCountForTests()).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
    expect(__sessionCountForTests()).toBe(0)
    expect(launched[0].closed).toBe(true)
  })

  it('every op resets the idle timer', async () => {
    vi.useFakeTimers()
    injectFakes()
    const r = await openBrowserSession('http://example.com/')
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await readBrowserSession(r.sessionId)          // op at t=4min → timer re-armed
    await vi.advanceTimersByTimeAsync(4 * 60_000)  // t=8min: only 4min idle
    expect(__sessionCountForTests()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000 + 1)  // t=9min+: 5min idle since read
    expect(__sessionCountForTests()).toBe(0)
  })
})
