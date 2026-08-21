// apps/desktop/test/unit/openclaudeProxyServedModel.test.ts
//
// P1-14. Every model id the app records for an OpenClaude run is an ECHO of our
// own request: the SDK stamps its events with the model variable it was handed
// and never reads the `model` field the upstream response carries. If a gateway
// silently served something else — a cheaper sibling, a dated pin, a fallback
// after a capacity error — the run log, the cost ledger and the UI would all
// still say what we asked for, because they all trace back to the same
// request-side string.
//
// The generated /v1-proxy sidecar wrapper sits in the path for the OpenGateway
// route and is the only component that sees both sides of the wire. These tests
// pin the two things that make its answer trustworthy:
//
//   1. BEHAVIOUR. The sniffing helpers are extracted from the GENERATED wrapper
//      and executed, so the escaping of the regex through the template literal
//      is exercised for real rather than assumed. Unknown must stay unknown: no
//      plausible default, and never the requested model, because that guess
//      would manufacture precisely the echo this mechanism exists to detect.
//   2. IT REMAINS A PEEK. A proxy that buffers or rewrites the payload it
//      observes is worse than no proxy — it would break streaming for every
//      request to pay for a log line. The body path must still be a pipe.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same hoisted-box electron mock as openclaudeWrapperSync.test.ts: the
// installer only calls app.getPath inside functions, so filling the box in
// beforeAll is safe.
const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import { writeOpenClaudeWrapper } from '../../electron/services/openclaude-installer'

beforeAll(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'tachi-oc-served-'))
})

let _wrapper: string | null = null
/** Generate start-server.mjs through the real installer path, once. */
function wrapper(): string {
  if (_wrapper) return _wrapper
  const base = join(h.userData, 'sidecars', 'openclaude')
  mkdirSync(base, { recursive: true })
  writeOpenClaudeWrapper()
  _wrapper = readFileSync(join(base, 'start-server.mjs'), 'utf8')
  return _wrapper
}

/** The text of the wrapper's /v1-proxy branch, up to the next route. */
function proxyRegion(): string {
  const w = wrapper()
  const start = w.indexOf("if (req.url && req.url.startsWith('/v1-proxy'))")
  const end = w.indexOf('// Pre-flight:')
  expect(start, 'wrapper no longer has a /v1-proxy branch').toBeGreaterThan(-1)
  expect(end, 'wrapper no longer has a /preflight route to bound the region').toBeGreaterThan(start)
  return w.slice(start, end)
}

interface Sniffer {
  feed(chunk: Buffer | string): string | null
  result(): string | null
}
interface Helpers {
  SERVED_MODEL_PEEK_BYTES: number
  _extractServedModel(text: string): string | null
  _createServedModelSniffer(limitBytes: number): Sniffer
}

let _helpers: Helpers | null = null
/**
 * Lift the sniffing helpers out of the generated wrapper and evaluate them.
 *
 * Evaluating the generated text (rather than re-typing the functions in the
 * test) is the whole point: these regexes are written inside a TypeScript
 * template literal, where every backslash has to be doubled, and a mis-escape
 * produces a wrapper that still parses and silently never matches.
 */
function helpers(): Helpers {
  if (_helpers) return _helpers
  const w = wrapper()
  const start = w.indexOf('const SERVED_MODEL_PEEK_BYTES')
  const end = w.indexOf('// Diagnostic banner')
  expect(start, 'wrapper no longer declares SERVED_MODEL_PEEK_BYTES').toBeGreaterThan(-1)
  expect(end, 'wrapper no longer has the boot banner to bound the helper block').toBeGreaterThan(start)
  const src = w.slice(start, end)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  _helpers = new Function(
    `${src}\nreturn { SERVED_MODEL_PEEK_BYTES, _extractServedModel, _createServedModelSniffer };`,
  )() as Helpers
  return _helpers
}

/** An SSE frame as OpenAI-compatible gateways emit it. */
function sseChunk(model: string): string {
  return 'data: ' + JSON.stringify({
    id: 'chatcmpl-abc',
    object: 'chat.completion.chunk',
    created: 1_754_200_000,
    model,
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  }) + '\n\n'
}

describe('the wrapper can read the model the UPSTREAM reports', () => {
  it('reads it from the first SSE chunk of a streamed answer', () => {
    const s = helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES)
    expect(s.feed(Buffer.from(sseChunk('served-mini-3')))).toBe('served-mini-3')
    expect(s.result()).toBe('served-mini-3')
  })

  it('reads it from a non-streamed JSON body', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-xyz',
      object: 'chat.completion',
      model: 'served-large-1',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    })
    const s = helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES)
    s.feed(Buffer.from(body))
    expect(s.result()).toBe('served-large-1')
  })

  it('survives a chunk boundary falling inside the token', () => {
    // The regression a naive per-chunk regex would ship with: TCP does not
    // respect JSON, and `"mod` | `el":"…"` reports unknown forever.
    const whole = sseChunk('split-model-9')
    const cut = whole.indexOf('"model"') + 4
    const s = helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES)
    expect(s.feed(Buffer.from(whole.slice(0, cut)))).toBeNull()
    expect(s.feed(Buffer.from(whole.slice(cut)))).toBe('split-model-9')
  })

  it('tolerates whitespace around the colon', () => {
    // Pretty-printed JSON is legal and some gateways emit it. This case is also
    // what proves the \\s in the generated regex survived the template literal:
    // a mis-escape leaves a literal `s*`, which still matches the compact
    // `"model":"x"` form and would otherwise go unnoticed until production.
    expect(helpers()._extractServedModel('{\n  "model" : "spaced-model"\n}')).toBe('spaced-model')
  })

  it('decodes an id that arrives JSON-escaped', () => {
    // Exercises the backslash alternation in the generated regex. Without it the
    // character class stops dead at the backslash, the match fails outright, and
    // a perfectly readable id is reported as unknown.
    expect(helpers()._extractServedModel('{"model":"vendor\\/model-1"}')).toBe('vendor/model-1')
  })

  it('keeps the FIRST model it sees when a stream repeats the envelope', () => {
    const s = helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES)
    s.feed(Buffer.from(sseChunk('first-model')))
    s.feed(Buffer.from(sseChunk('later-model')))
    expect(s.result()).toBe('first-model')
  })
})

describe('unknown stays unknown — no plausible defaults', () => {
  it('a body that names no model reports null, not a guess', () => {
    const s = helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES)
    s.feed(Buffer.from(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } })))
    expect(s.result()).toBeNull()
  })

  it('an empty body reports null', () => {
    const s = helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES)
    expect(s.result()).toBeNull()
  })

  it('the log prints the word unknown rather than omitting the field', () => {
    // A missing field reads as "we did not look"; the literal word is the
    // difference between an unobserved run and an unobservable one.
    expect(proxyRegion()).toMatch(/servedModel=.*unknown|unknown.*servedModel/s)
    expect(proxyRegion()).toContain("'unknown'")
  })
})

describe('it stays a peek, never a buffer', () => {
  it('the peek window is bounded and small', () => {
    const cap = helpers().SERVED_MODEL_PEEK_BYTES
    expect(cap).toBeGreaterThan(0)
    expect(cap).toBeLessThanOrEqual(64 * 1024)
  })

  it('stops accumulating once the cap is passed, even if the model comes later', () => {
    // Proves the cap is enforced rather than decorative: a 100 MB download must
    // not be held in the sidecar's heap on the off-chance it names a model.
    const cap = helpers().SERVED_MODEL_PEEK_BYTES
    const s = helpers()._createServedModelSniffer(cap)
    s.feed(Buffer.alloc(cap + 1, 0x20))
    expect(s.feed(Buffer.from(sseChunk('too-late')))).toBeNull()
    expect(s.result()).toBeNull()
  })

  it('does not modify the chunks it observes', () => {
    // The chunk object handed to the observer is the SAME Buffer the pipe
    // forwards. Touching it would corrupt the response for the SDK.
    const original = Buffer.from(sseChunk('untouched-1'))
    const copy = Buffer.from(original)
    helpers()._createServedModelSniffer(helpers().SERVED_MODEL_PEEK_BYTES).feed(original)
    expect(original.equals(copy)).toBe(true)
  })

  it('the response body is still piped straight through', () => {
    const region = proxyRegion()
    expect(region).toContain('upstreamRes.pipe(res)')
    expect(region).toContain('req.pipe(upstreamReq)')
    // Accumulation lives only in the sniffer at module scope. Any concat or
    // setEncoding inside the proxy branch means someone started buffering.
    expect(region).not.toContain('Buffer.concat')
    expect(region).not.toContain('upstreamRes.setEncoding')
    // A rewritten payload would need one of these on the success path; only the
    // error paths end the response themselves.
    expect(region).not.toContain('res.write(')
  })
})

describe('the served model is logged, and marked as distinct from the requested one', () => {
  it('the end-of-response log carries both, labelled', () => {
    const region = proxyRegion()
    expect(region).toContain('servedModel=')
    expect(region).toContain('requestedModel=')
    expect(region).toContain('status=')
  })

  it('a substitution gets its own line', () => {
    // The whole point of P1-14: this is the only place in the stack where
    // requested and served can disagree in the open.
    expect(proxyRegion()).toMatch(/MODEL SUBSTITUTION/)
  })

  it('the requested side is observed on the wire, not read back from env', () => {
    // OPENAI_MODEL is the sidecar's startup pin, not what the SDK asked for on
    // this request. Comparing the served model against the pin would compare an
    // echo with an echo.
    const region = proxyRegion()
    expect(region).toContain('requestSniff.feed')
    expect(region).not.toContain('process.env.OPENAI_MODEL')
  })

  it('a compressed body is reported unknown rather than sniffed for rubbish', () => {
    // We strip accept-encoding on the way out, but an absent Accept-Encoding is
    // not a ban (RFC 9110 §12.5.3), so a gateway may still gzip. Regexing gzip
    // bytes would eventually produce a confident wrong id.
    const region = proxyRegion()
    expect(region).toContain("upstreamRes.headers['content-encoding']")
    expect(region).toMatch(/sniffable/)
  })
})
