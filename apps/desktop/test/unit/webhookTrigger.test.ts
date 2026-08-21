// apps/desktop/test/unit/webhookTrigger.test.ts
//
// BATCH35 lane B — the TradingView webhook TRIGGER node, end to end as far as a
// node-env test can reach:
//
//   1. REGISTRY   — services/webhook-hooks.ts driven directly (it is electron-
//                   free and takes `now` as a parameter, so the rate limiter and
//                   the secret lifecycle are testable without timers).
//   2. SECURITY   — the properties that make an internet-shaped endpoint safe to
//                   open on a desktop app: default-closed, 32-byte secret,
//                   constant-time compare, size cap, rate limit, and a path
//                   parser that rejects traversal before any lookup.
//   3. NO TRADING — a hard, greppable assertion that nothing in the feature
//                   reaches an order/wallet path. The app's money-path caps are
//                   a law; a trigger that could trade would route around them.
//   4. WIRING     — source assertions (house idiom: the canvas cannot be driven
//                   in node) that the node type is registered everywhere a node
//                   type must be registered, and that its i18n exists in all 8
//                   locales.

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  armWebhook,
  deliverWebhook,
  disarmWebhook,
  forgetWebhook,
  isValidHookId,
  isWebhookArmed,
  listArmedWebhooks,
  mintWebhookToken,
  normalizeAlertBody,
  onWebhookAlert,
  parseWebhookPath,
  recentWebhookAlerts,
  resetWebhookRegistry,
  revealWebhookToken,
  rotateWebhookToken,
  safeCompareSecret,
  setWebhookTokenStore,
  webhookPath,
  webhookUrl,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_HOOKS,
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RECENT_MAX,
  WEBHOOK_TOKEN_BYTES,
  type WebhookAlert,
} from '../../electron/services/webhook-hooks'

import {
  alertSummary,
  canCopyUrl,
  compactAlertLine,
  emitWebhookFired,
  mayAutoRun,
  maskToken,
  newHookId,
  onWebhookFired,
  resetWebhookFiredListeners,
  webhookNodeState,
} from '../../src/pages/nodes/webhookTrigger'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const HOOK = 'hook-0123456789abcdef'
const T0 = 1_770_000_000_000

beforeEach(() => {
  resetWebhookRegistry()
  setWebhookTokenStore(null)
  resetWebhookFiredListeners()
})

// ── 1. REGISTRY ──────────────────────────────────────────────────────────────

describe('webhook registry · arm / disarm lifecycle', () => {
  it('starts empty — every path is closed until a canvas node arms one', () => {
    expect(listArmedWebhooks()).toEqual([])
    expect(isWebhookArmed(HOOK)).toBe(false)
    const res = deliverWebhook({ source: 'tradingview', hookId: HOOK, token: 'x', body: 'buy' }, T0)
    expect(res).toMatchObject({ ok: false, status: 404, code: 'not-armed' })
  })

  it('arming opens exactly one path and hands back a secret', () => {
    const armed = armWebhook(HOOK, 'tradingview', T0)
    expect(armed.ok).toBe(true)
    if (!armed.ok) return
    expect(armed.path).toBe(`/webhooks/tradingview/${HOOK}`)
    expect(armed.token).toMatch(/^[0-9a-f]+$/)
    expect(isWebhookArmed(HOOK)).toBe(true)
    // A DIFFERENT id stays closed — arming is per hook, not per server.
    expect(isWebhookArmed('hook-ffffffffffffffff')).toBe(false)
  })

  it('re-arming the same id keeps the secret (a pasted alert URL survives a reload)', () => {
    const first = armWebhook(HOOK, 'tradingview', T0)
    const again = armWebhook(HOOK, 'tradingview', T0 + 5_000)
    expect(first.ok && again.ok && first.token).toBe(again.ok ? again.token : null)
  })

  it('disarm closes the path but keeps the secret; forget drops it', () => {
    const first = armWebhook(HOOK, 'tradingview', T0)
    expect(first.ok).toBe(true)
    const token = first.ok ? first.token : ''

    disarmWebhook(HOOK)
    expect(isWebhookArmed(HOOK)).toBe(false)
    const rearmed = armWebhook(HOOK, 'tradingview', T0)
    expect(rearmed.ok && rearmed.token).toBe(token)

    forgetWebhook(HOOK)
    const fresh = armWebhook(HOOK, 'tradingview', T0)
    expect(fresh.ok && fresh.token).not.toBe(token)
  })

  it('rotate replaces the secret in place — the old URL stops working', () => {
    const armed = armWebhook(HOOK, 'tradingview', T0)
    const old = armed.ok ? armed.token : ''
    const next = rotateWebhookToken(HOOK)
    expect(next).toBeTruthy()
    expect(next).not.toBe(old)
    expect(revealWebhookToken(HOOK)).toBe(next)
    expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token: old, body: 'x' }, T0))
      .toMatchObject({ ok: false, status: 401 })
    expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token: next!, body: 'x' }, T0).ok).toBe(true)
  })

  it('caps how many hooks can be armed at once', () => {
    for (let i = 0; i < WEBHOOK_MAX_HOOKS; i++) {
      expect(armWebhook(`hook-${String(i).padStart(12, '0')}`, 'tradingview', T0).ok).toBe(true)
    }
    expect(armWebhook('hook-overflow0001', 'tradingview', T0))
      .toMatchObject({ ok: false, code: 'too-many-hooks' })
  })

  it('persists secrets through the injected store (survives a restart)', () => {
    const disk: Record<string, string> = {}
    setWebhookTokenStore({
      load: () => ({ ...disk }),
      save: (m) => { for (const k of Object.keys(disk)) delete disk[k]; Object.assign(disk, m) },
    })
    const armed = armWebhook(HOOK, 'tradingview', T0)
    const token = armed.ok ? armed.token : ''
    expect(disk[HOOK]).toBe(token)

    // "Restart": drop all in-memory state, re-install the same store.
    resetWebhookRegistry()
    setWebhookTokenStore({ load: () => ({ ...disk }), save: () => {} })
    const after = armWebhook(HOOK, 'tradingview', T0 + 60_000)
    expect(after.ok && after.token).toBe(token)
  })

  it('ignores corrupt persisted entries instead of arming something malformed', () => {
    setWebhookTokenStore({
      load: () => ({ '../etc/passwd': 'deadbeef', [HOOK]: 'too-short' }),
      save: () => {},
    })
    const armed = armWebhook(HOOK, 'tradingview', T0)
    // The short token was rejected on load, so a fresh full-length one is minted.
    expect(armed.ok && armed.token.length).toBe(WEBHOOK_TOKEN_BYTES * 2)
  })
})

// ── 2. SECURITY ──────────────────────────────────────────────────────────────

describe('webhook security · the properties that make this safe to expose', () => {
  it('mints a secret of at least 32 bytes of entropy, and never twice the same', () => {
    const a = mintWebhookToken()
    const b = mintWebhookToken()
    expect(a).toHaveLength(WEBHOOK_TOKEN_BYTES * 2) // hex
    expect(WEBHOOK_TOKEN_BYTES).toBeGreaterThanOrEqual(32)
    expect(a).not.toBe(b)
  })

  it('compares secrets in constant time (length mismatch never reaches the compare)', () => {
    const token = mintWebhookToken()
    expect(safeCompareSecret(token, token)).toBe(true)
    // XOR the last nibble so the "wrong" secret differs BY CONSTRUCTION.
    // Substituting a fixed '0' here made this the suite's only flake: whenever
    // the minted token already ENDED in '0' (1 in 16 runs), the mutant equalled
    // the real secret and the compare truthfully said so (5/48 in a stress loop).
    const lastNibbleFlipped = token.slice(0, -1) + (parseInt(token.slice(-1), 16) ^ 1).toString(16)
    expect(safeCompareSecret(lastNibbleFlipped, token)).toBe(false)
    expect(safeCompareSecret(token.slice(0, 10), token)).toBe(false) // would THROW in timingSafeEqual
    expect(safeCompareSecret('', token)).toBe(false)
    expect(safeCompareSecret(undefined as unknown as string, token)).toBe(false)
  })

  it('a wrong token is 401 and leaves no trace on the hook', () => {
    armWebhook(HOOK, 'tradingview', T0)
    const res = deliverWebhook({ source: 'tradingview', hookId: HOOK, token: 'nope', body: 'buy' }, T0)
    expect(res).toMatchObject({ ok: false, status: 401, code: 'bad-token' })
    expect(listArmedWebhooks()[0]!.hits).toBe(0)
    expect(recentWebhookAlerts(HOOK)).toEqual([])
  })

  it('an unarmed hook and a wrong source both read as 404 (no existence oracle)', () => {
    armWebhook(HOOK, 'tradingview', T0)
    expect(deliverWebhook({ source: 'nyse', hookId: HOOK, token: 'x', body: '' }, T0))
      .toMatchObject({ status: 404 })
    expect(deliverWebhook({ source: 'tradingview', hookId: 'hook-aaaaaaaaaaaa', token: 'x', body: '' }, T0))
      .toMatchObject({ status: 404, code: 'not-armed' })
  })

  it('caps the body — an alert is a sentence, not an upload', () => {
    const armed = armWebhook(HOOK, 'tradingview', T0)
    const token = armed.ok ? armed.token : ''
    const big = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1)
    expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: big }, T0))
      .toMatchObject({ ok: false, status: 413, code: 'too-large' })
    // …and the transport's own overflow signal is honoured even with a small body.
    expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: 'x', oversized: true }, T0))
      .toMatchObject({ ok: false, status: 413 })
    // A body exactly AT the cap is fine.
    expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) }, T0).ok).toBe(true)
  })

  it('rate-limits a leaked URL, then recovers when the window rolls', () => {
    const armed = armWebhook(HOOK, 'tradingview', T0)
    const token = armed.ok ? armed.token : ''
    for (let i = 0; i < WEBHOOK_RATE_LIMIT.max; i++) {
      expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: 'buy' }, T0 + i).ok).toBe(true)
    }
    const blocked = deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: 'buy' }, T0 + WEBHOOK_RATE_LIMIT.max)
    expect(blocked).toMatchObject({ ok: false, status: 429, code: 'rate-limited' })
    expect(blocked.ok === false && blocked.retryAfterMs).toBeGreaterThan(0)

    const later = deliverWebhook(
      { source: 'tradingview', hookId: HOOK, token, body: 'buy' },
      T0 + WEBHOOK_RATE_LIMIT.windowMs + 1,
    )
    expect(later.ok).toBe(true)
  })

  it('the path parser rejects traversal, extra segments and unknown sources BEFORE any lookup', () => {
    expect(parseWebhookPath(`/webhooks/tradingview/${HOOK}`)).toEqual({ source: 'tradingview', hookId: HOOK })
    for (const bad of [
      '/webhooks/tradingview/../../etc/passwd',
      '/webhooks/tradingview/%2e%2e%2f%2e%2e',
      '/webhooks/tradingview',
      '/webhooks/tradingview/a/b',
      '/webhooks/nyse/' + HOOK,
      '/webhooks//' + HOOK,
      '/v1/chat/completions',
      '',
    ]) {
      expect(parseWebhookPath(bad), bad).toBeNull()
    }
  })

  it('hook ids are restricted to a shape that cannot escape a URL segment', () => {
    expect(isValidHookId(HOOK)).toBe(true)
    for (const bad of ['short', '../evil', 'HOOK-UPPER-CASE', 'hook id with spaces', 'hook/slash', '', null, 42]) {
      expect(isValidHookId(bad), String(bad)).toBe(false)
    }
    expect(armWebhook('bad id', 'tradingview', T0)).toMatchObject({ ok: false, code: 'bad-hook-id' })
  })

  it('builds the copyable URL from the same path the route matches', () => {
    const url = webhookUrl('http://127.0.0.1:11435/', 'tradingview', HOOK, 'abc')
    expect(url).toBe(`http://127.0.0.1:11435${webhookPath('tradingview', HOOK)}?token=abc`)
    expect(parseWebhookPath(new URL(url).pathname)).toEqual({ source: 'tradingview', hookId: HOOK })
  })
})

// ── 3. DELIVERY ──────────────────────────────────────────────────────────────

describe('webhook delivery · an alert becomes text', () => {
  it('normalizes JSON and plain text the way TradingView actually sends them', () => {
    expect(normalizeAlertBody('BUY BTCUSD @ 42000')).toEqual({ text: 'BUY BTCUSD @ 42000' })
    const json = normalizeAlertBody('{"ticker":"BTCUSD","action":"buy"}')
    expect(json.json).toEqual({ ticker: 'BTCUSD', action: 'buy' })
    expect(json.text).toContain('"ticker": "BTCUSD"') // pretty-printed for the node
    expect(normalizeAlertBody('  ')).toEqual({ text: '' })
    // A JSON scalar is text, not a document — quoting it would help nobody.
    expect(normalizeAlertBody('"buy"')).toEqual({ text: '"buy"' })
    expect(normalizeAlertBody('{not json')).toEqual({ text: '{not json' })
  })

  it('records the alert, notifies subscribers and rings the recent buffer', () => {
    const armed = armWebhook(HOOK, 'tradingview', T0)
    const token = armed.ok ? armed.token : ''
    const seen: WebhookAlert[] = []
    const off = onWebhookAlert(a => seen.push(a))

    for (let i = 0; i < WEBHOOK_RECENT_MAX + 3; i++) {
      deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: `alert ${i}` }, T0 + i)
    }
    off()

    expect(seen).toHaveLength(WEBHOOK_RECENT_MAX + 3)
    const recent = recentWebhookAlerts(HOOK)
    expect(recent).toHaveLength(WEBHOOK_RECENT_MAX)
    expect(recent[0]!.text).toBe(`alert ${WEBHOOK_RECENT_MAX + 2}`) // newest first
    const hook = listArmedWebhooks()[0]!
    expect(hook.hits).toBe(WEBHOOK_RECENT_MAX + 3)
    expect(hook.lastAt).toBe(T0 + WEBHOOK_RECENT_MAX + 2)

    // Unsubscribed: no further deliveries reach the old listener.
    deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: 'after' }, T0 + 9999)
    expect(seen).toHaveLength(WEBHOOK_RECENT_MAX + 3)
  })

  it('a throwing subscriber cannot swallow the alert', () => {
    const armed = armWebhook(HOOK, 'tradingview', T0)
    const token = armed.ok ? armed.token : ''
    const good: string[] = []
    onWebhookAlert(() => { throw new Error('boom') })
    onWebhookAlert(a => good.push(a.text))
    expect(deliverWebhook({ source: 'tradingview', hookId: HOOK, token, body: 'still delivered' }, T0).ok).toBe(true)
    expect(good).toEqual(['still delivered'])
  })
})

// ── 4. NO TRADING ────────────────────────────────────────────────────────────

describe('webhook trigger · inbound signal only (money-path law)', () => {
  const FEATURE_FILES = [
    'electron/services/webhook-hooks.ts',
    'src/pages/nodes/webhookTrigger.ts',
    'src/pages/nodes/canvas/nodeTypes/WebhookNode.tsx',
  ]

  it('no part of the feature reaches an order, wallet or broker path', () => {
    // The alert is TEXT. Anything that could place a trade from an inbound POST
    // would route around the app's spend caps and unattended-execution gates.
    const forbidden = /\b(placeOrder|submitOrder|createOrder|sendTransaction|signTransaction|walletService|darksol|transfer|buyToken|sellToken)\b/i
    for (const f of FEATURE_FILES) {
      const src = read(f)
      // The word "trade" appears in prose ("never places a trade") — match the
      // API shapes only, not the English.
      expect(forbidden.test(src), `${f} reaches a money path`).toBe(false)
    }
  })

  it('the node type is NOT runnable — a trigger can never execute anything', async () => {
    const { isRunnableType, RUNNABLE_NODE_TYPES } = await import('../../src/pages/nodes/run-eligibility')
    expect(isRunnableType('webhook')).toBe(false)
    expect([...RUNNABLE_NODE_TYPES]).not.toContain('webhook')
  })

  it('the compiler treats it as inert data, like a Text node', () => {
    const src = read('electron/services/graph-to-agentkit.ts')
    expect(src).toContain("case 'webhook':  break")
  })

  it('auto-run needs an explicit per-node opt-in and never stacks runs', () => {
    expect(mayAutoRun({ autoRun: true,      state: 'listening', running: false })).toBe(true)
    expect(mayAutoRun({ autoRun: false,     state: 'listening', running: false })).toBe(false)
    expect(mayAutoRun({ autoRun: undefined, state: 'listening', running: false })).toBe(false)
    expect(mayAutoRun({ autoRun: true,      state: 'listening', running: true  })).toBe(false)
    expect(mayAutoRun({ autoRun: true,      state: 'disarmed',  running: false })).toBe(false)
    expect(mayAutoRun({ autoRun: true,      state: 'server-off', running: false })).toBe(false)
  })

  it('the palette template ships auto-run OFF', () => {
    const src = read('src/pages/nodes/sidebar/NodePalette.tsx')
    const line = src.split('\n').find(l => l.includes("type: 'webhook'"))!
    expect(line).toBeTruthy()
    expect(line).not.toContain('autoRun')
  })
})

// ── 5. RENDERER STATE + READOUT ──────────────────────────────────────────────

describe('webhook node state machine', () => {
  const base = { serverEnabled: true, serverRunning: true, armed: true, live: true }

  it('tells the truth about the server before anything else', () => {
    expect(webhookNodeState({ ...base, serverEnabled: false })).toBe('server-off')
    expect(webhookNodeState({ ...base, serverRunning: false })).toBe('server-down')
    // …even when the node itself would otherwise be in an error/disarmed state.
    expect(webhookNodeState({ ...base, serverEnabled: false, armed: false, error: 'x' })).toBe('server-off')
  })

  it('distinguishes disarmed, error and listening', () => {
    expect(webhookNodeState({ ...base, armed: false })).toBe('disarmed')
    expect(webhookNodeState({ ...base, error: 'too many hooks' })).toBe('error')
    expect(webhookNodeState(base)).toBe('listening')
    // Armed but main never handed back a URL → not listening, do not pretend.
    expect(webhookNodeState({ ...base, live: false })).toBe('server-down')
  })

  it('only a listening node offers a URL to copy', () => {
    expect(canCopyUrl('listening', 'http://127.0.0.1:11435/webhooks/x')).toBe(true)
    expect(canCopyUrl('listening', '')).toBe(false)
    expect(canCopyUrl('listening', null)).toBe(false)
    expect(canCopyUrl('disarmed', 'http://127.0.0.1:11435/webhooks/x')).toBe(false)
    expect(canCopyUrl('server-off', 'http://127.0.0.1:11435/webhooks/x')).toBe(false)
  })

  it('mints hook ids main will accept', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const id = newHookId()
      expect(isValidHookId(id)).toBe(true)
      ids.add(id)
    }
    expect(ids.size).toBe(50)
  })

  it('masks the secret on screen and clips a multi-line alert to one line', () => {
    const token = mintWebhookToken()
    const masked = maskToken(token)
    expect(masked).not.toBe(token)
    expect(masked.startsWith(token.slice(0, 6))).toBe(true)
    expect(maskToken('')).toBe('')
    expect(maskToken('short')).toBe('•••••')

    const at = new Date(2026, 6, 27, 9, 5, 3).getTime()
    expect(alertSummary({ receivedAt: at, text: 'x'.repeat(200) })).toMatch(/^09:05:03 · x{63}…$/)
    expect(alertSummary({ receivedAt: at, text: '   ' })).toBe('09:05:03')
    expect(alertSummary(null)).toBe('')
  })

  // ── the `Last: HH:MM:SS · {` regression ──────────────────────────────────
  //
  // main's normalizeAlertBody PRETTY-PRINTS a parsed JSON alert (stringify with
  // an indent of 2) because that is what the node's downstream output wants.
  // alertSummary then took the first non-empty LINE of that — which for every
  // pretty-printed object on earth is `{`. So the node's readout was
  // `Last: 09:05:03 · {` for every JSON alert TradingView has ever sent,
  // carrying exactly zero bits about the payload. These pin the compact
  // re-serialization that replaced it, and pin that plain text is untouched.

  const AT = new Date(2026, 6, 27, 9, 5, 3).getTime()
  const summary = (text: string, max?: number) =>
    alertSummary({ receivedAt: AT, text }, max)

  it('summarizes a pretty-printed JSON OBJECT as compact single-line JSON', () => {
    const body = normalizeAlertBody('{"ticker":"BTCUSD","action":"test"}')
    expect(body.text).toContain('\n')                       // main still pretty-prints
    expect(summary(body.text)).toBe('09:05:03 · {"ticker":"BTCUSD","action":"test"}')
    expect(summary(body.text)).not.toMatch(/· \{$/)         // never the bare brace again
  })

  it('summarizes a JSON ARRAY the same way', () => {
    const body = normalizeAlertBody('[{"a":1},{"b":2}]')
    expect(summary(body.text)).toBe('09:05:03 · [{"a":1},{"b":2}]')
  })

  it('keeps key ORDER, so two different payloads read differently', () => {
    const one = summary(normalizeAlertBody('{"action":"buy","ticker":"BTCUSD"}').text)
    const two = summary(normalizeAlertBody('{"action":"sell","ticker":"ETHUSD"}').text)
    expect(one).not.toBe(two)
    expect(one).toContain('"action":"buy"')
  })

  it('leaves PLAIN TEXT alerts exactly as they were', () => {
    expect(summary('BUY BTCUSD @ 42000')).toBe('09:05:03 · BUY BTCUSD @ 42000')
    // multi-line plain text still collapses to its first non-empty line
    expect(summary('\n\n  first line  \nsecond line')).toBe('09:05:03 · first line')
  })

  it('leaves a JSON SCALAR as text — main deliberately does not treat it as a document', () => {
    expect(normalizeAlertBody('"buy"')).toEqual({ text: '"buy"' })
    expect(summary('"buy"')).toBe('09:05:03 · "buy"')
    expect(summary('42')).toBe('09:05:03 · 42')
  })

  it('falls back to the first line for a body that only LOOKS like JSON', () => {
    expect(summary('{not json\nsecond line')).toBe('09:05:03 · {not json')
    expect(summary('[1, 2, oops')).toBe('09:05:03 · [1, 2, oops')
  })

  it('TRUNCATES a long JSON payload at the summary cap instead of stretching the tile', () => {
    const wide = JSON.stringify(Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field${i}`, `value${i}`]),
    ))
    const body = normalizeAlertBody(wide)
    const out = summary(body.text)
    const rendered = out.slice('09:05:03 · '.length)
    expect(rendered).toHaveLength(64)               // max, ellipsis included
    expect(rendered.endsWith('…')).toBe(true)
    expect(rendered.startsWith('{"field0":"value0"')).toBe(true)
    expect(rendered).not.toContain('\n')
  })

  it('honours a caller-supplied max', () => {
    const body = normalizeAlertBody('{"ticker":"BTCUSD","action":"test"}')
    expect(summary(body.text, 12)).toBe('09:05:03 · {"ticker":"…')
  })

  it('renders the timestamp alone for an empty or whitespace body', () => {
    expect(summary('')).toBe('09:05:03')
    expect(summary('{}')).toBe('09:05:03 · {}')   // an empty OBJECT is still a payload
  })

  it('compactAlertLine is the pure seam under all of the above', () => {
    expect(compactAlertLine('{\n  "action": "buy"\n}')).toBe('{"action":"buy"}')
    expect(compactAlertLine('plain')).toBe('plain')
    expect(compactAlertLine('   ')).toBe('')
    expect(compactAlertLine(null)).toBe('')
    expect(compactAlertLine(undefined)).toBe('')
  })

  it('the fired bus reaches subscribers and survives a throwing one', () => {
    const got: string[] = []
    onWebhookFired(() => { throw new Error('boom') })
    const off = onWebhookFired(e => got.push(e.nodeId))
    emitWebhookFired({ nodeId: 'n1', hookId: HOOK, text: 'buy', receivedAt: T0 })
    off()
    emitWebhookFired({ nodeId: 'n2', hookId: HOOK, text: 'sell', receivedAt: T0 })
    expect(got).toEqual(['n1'])
  })
})

// ── 6. WIRING (source assertions — the canvas cannot be driven in node) ──────

describe('webhook node · registered everywhere a node type must be', () => {
  it('renders through FlowCanvas nodeTypes', () => {
    const src = read('src/pages/nodes/canvas/FlowCanvas.tsx')
    expect(src).toContain("import { WebhookNode }  from './nodeTypes/WebhookNode'")
    expect(src).toContain('webhook:  React.memo(WebhookNode)')
  })

  it('survives a save/load round-trip instead of self-healing to `unknown`', () => {
    expect(read('src/pages/nodes/serialization.ts')).toMatch(/KNOWN_NODE_TYPES[\s\S]{0,240}'webhook'/)
  })

  it('is offered in the palette under its own TRIGGERS group', () => {
    const src = read('src/pages/nodes/sidebar/NodePalette.tsx')
    expect(src).toContain("type: 'webhook'")
    expect(src).toContain("t('palette.groups.triggers')")
    expect(src).toContain('TRIGGER_TEMPLATES')
    // The group is part of the searchable set, not just rendered.
    expect(src).toMatch(/allTargets[\s\S]{0,300}TRIGGER_TEMPLATES/)
  })

  it('has a palette colour, so the drag ghost is not a silent accent fallback', () => {
    expect(read('src/pages/nodes/sidebar/paletteDrag.ts')).toMatch(/webhook:\s*'var\(--/)
  })

  it('feeds downstream nodes as a static source in a full Run-flow', () => {
    expect(read('electron/ipc/graph.ipc.ts')).toContain("n.type !== 'webhook'")
  })

  it('the route lives on the EXISTING api server, ahead of the /v1 bearer gate', () => {
    const src = read('electron/services/openai-api-server.ts')
    expect(src).toContain("path.startsWith('/webhooks/')")
    expect(src).toContain('parseWebhookPath')
    expect(src).toContain('WEBHOOK_MAX_BODY_BYTES')
    // Ordering matters: the webhook branch must return BEFORE safeCompareToken,
    // or a TradingView alert would need the app-wide /v1 bearer.
    expect(src.indexOf("path.startsWith('/webhooks/')")).toBeLessThan(src.indexOf('if (!safeCompareToken('))
    // The bind address is untouched.
    expect(src).toContain("server.listen(port, '127.0.0.1')")
  })

  it('the IPC hangs off nodes.ipc — no new boot-time import on main.ts (R8b)', () => {
    const nodesIpc = read('electron/ipc/nodes.ipc.ts')
    expect(nodesIpc).toContain('registerWebhookIpc()')
    for (const ch of ['webhooks:status', 'webhooks:arm', 'webhooks:disarm', 'webhooks:rotate', 'webhooks:recent']) {
      expect(nodesIpc).toContain(`ipcMain.handle('${ch}'`)
    }
    expect(read('electron/main.ts')).not.toContain('webhook')
  })

  it('the preload bridge exposes the channels the node calls', () => {
    const src = read('electron/preload.ts')
    for (const ch of ['webhooks:status', 'webhooks:arm', 'webhooks:disarm', 'webhooks:rotate', 'webhooks:recent', 'webhooks:alert']) {
      expect(src).toContain(ch)
    }
  })

  it('the secret never enters the flow file (flows get exported and shared)', () => {
    // types.ts documents the rule; the node must not write a token into data.
    expect(read('src/pages/nodes/types.ts')).toMatch(/WebhookNodeData[\s\S]{0,1400}hookId/)
    const node = read('src/pages/nodes/canvas/nodeTypes/WebhookNode.tsx')
    expect(node).not.toMatch(/updateNodeData\([^)]*token/)
  })
})

describe('webhook node · i18n parity', () => {
  const keys = [
    'palette.groups.triggers',
    'webhookNode.header',
    'webhookNode.state.listening', 'webhookNode.state.disarmed',
    'webhookNode.state.server-off', 'webhookNode.state.server-down', 'webhookNode.state.error',
    'webhookNode.help.listening', 'webhookNode.help.disarmed',
    'webhookNode.help.server-off', 'webhookNode.help.server-down', 'webhookNode.help.error',
    'webhookNode.arm', 'webhookNode.disarm', 'webhookNode.armAria', 'webhookNode.disarmAria',
    'webhookNode.copyUrl', 'webhookNode.copied', 'webhookNode.copyUrlAria',
    'webhookNode.rotate', 'webhookNode.rotateAria',
    'webhookNode.autoRun', 'webhookNode.lastAlert', 'webhookNode.noAlerts',
    'webhookNode.loopbackHint', 'webhookNode.signalOnly',
    'templatesRail.items.geo-audit.label', 'templatesRail.items.geo-audit.description',
  ]

  const lookup = (obj: Record<string, unknown>, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj)

  const ns = (lang: string) =>
    JSON.parse(read(`src/i18n/locales/${lang}/nodes.json`)) as Record<string, unknown>

  it('every new key exists, non-empty, in all 8 locales', () => {
    const missing: string[] = []
    for (const lang of LANGS) {
      const j = ns(lang)
      for (const k of keys) {
        const v = lookup(j, k)
        if (typeof v !== 'string' || v.trim() === '') missing.push(`${lang}/${k}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('interpolation placeholders match English everywhere', () => {
    const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',')
    const en = ns('en')
    const drift: string[] = []
    for (const k of ['webhookNode.header', 'webhookNode.lastAlert']) {
      const want = ph(String(lookup(en, k)))
      for (const lang of LANGS) {
        const got = ph(String(lookup(ns(lang), k)))
        if (got !== want) drift.push(`${lang}/${k}: ${got} != ${want}`)
      }
    }
    expect(drift).toEqual([])
  })

  it('the loopback caveat is stated in every language (it is the #1 way to be fooled)', () => {
    for (const lang of LANGS) {
      expect(String(lookup(ns(lang), 'webhookNode.loopbackHint')), lang).toContain('127.0.0.1')
    }
  })
})
