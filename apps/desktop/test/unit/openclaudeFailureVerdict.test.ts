// apps/desktop/test/unit/openclaudeFailureVerdict.test.ts
//
// FAILED RUNS MUST NOT RENDER AS SUCCESS (driver, 2026-08-02).
//
// The sidecar reported, on the very first query after the 0.27.0 install was
// repaired:
//
//   [openclaude] /query error: Error: SDK permissionMode "bypassPermissions"
//   requires allowDangerouslySkipPermissions: true
//
// …and the CODE tab rendered "✓ Done (stop)" over a run that produced nothing.
// Two independent defects made that possible and both are pinned here:
//
//   1. the wrapper's own `{"type":"error", ...}` line is NOT an SDK message
//      type, so it fell through every branch of sdkMessageToAgentEvents and was
//      DISCARDED;
//   2. _stream ended with an unconditional `done, reason:'stop'`, so even when
//      an error DID reach the UI the run still claimed success afterwards.
//
// The end-to-end case drives the real client against a loopback NDJSON server
// serving the exact bytes the wrapper writes — the mapper alone cannot prove the
// terminal event, and the terminal event is the thing the operator reads.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AgentEvent } from '@tachi/core'

// Main-process collaborators that would drag electron in. The log path is a
// FIXED string here so the failure wording can be asserted verbatim.
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))
vi.mock('../../electron/services/capability-service', () => ({
  capabilityService: { getMode: () => 'immediate' },
}))
// The ledger is a RECORDER here, not a stub: one of the defects below is a run
// that spends real tokens and writes nothing to it, which is only visible if
// the calls are kept.
const ledgerCalls = vi.hoisted(() => [] as unknown[][])
vi.mock('../../electron/services/cost-ledger', () => ({
  getCostLedger: () => ({ record: (...args: unknown[]) => { ledgerCalls.push(args) } }),
}))
vi.mock('../../electron/services/sidecar-manager', () => ({
  getOpenClaudeLedgerProviderId: () => 'opengateway',
  getOpenClaudeLedgerModelId: () => 'nvidia/nemotron-3-ultra-550b-a55b:free',
  openclaudeLogPath: () => 'C:\\userData\\openclaude.log',
}))

import {
  OpenClaudeClient,
  sdkMessageToAgentEvents,
  newStreamState,
  describeQueryFailure,
  describeStreamInterruption,
  describeAssistantApiError,
} from '../../electron/services/openclaude-client'
import { classifyProviderError } from '@tachi/core/src/chat/classify-error'

/** The literal line the wrapper writes when its /query handler throws. */
const WRAPPER_ERROR_LINE = JSON.stringify({
  type: 'error',
  error: 'Error: SDK permissionMode "bypassPermissions" requires allowDangerouslySkipPermissions: true',
})

/** Spin a one-shot NDJSON /query server that replays `lines`. */
function serveLines(lines: string[]): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      for (const l of lines) res.write(l + '\n')
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

/** Run one task through the real client and collect every event it emits. */
function collect(port: number): Promise<AgentEvent[]> {
  return new Promise(resolve => {
    const events: AgentEvent[] = []
    const client = new OpenClaudeClient(port)
    client.sendTask('.', 'do a thing', e => {
      events.push(e)
      if (e.type === 'done') resolve(events)
    }, new AbortController().signal)
  })
}

/**
 * Like `collect`, but gives up after `budgetMs` and returns what it has.
 *
 * The bound is the POINT, not a convenience: the defect these pre-stream tests
 * pin is "no terminal event is ever emitted", and `collect` would express that
 * as a suite-wide vitest timeout — a slow failure that names the runner rather
 * than the missing event. With a budget the assertion reads "there is no done
 * event", which is the actual finding.
 */
function collectBounded(port: number, signal?: AbortSignal, budgetMs = 3000): Promise<AgentEvent[]> {
  return new Promise(resolve => {
    const events: AgentEvent[] = []
    const timer = setTimeout(() => resolve(events), budgetMs)
    const client = new OpenClaudeClient(port)
    client.sendTask('.', 'do a thing', e => {
      events.push(e)
      if (e.type === 'done') { clearTimeout(timer); resolve(events) }
    }, signal ?? new AbortController().signal)
  })
}

/** A port with nothing listening on it — bound to learn a free one, then closed. */
function closedPort(): Promise<number> {
  return new Promise(resolve => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

describe('sdkMessageToAgentEvents — the wrapper failure line', () => {
  it('surfaces {type:"error", error} instead of dropping it', () => {
    const out = sdkMessageToAgentEvents(JSON.parse(WRAPPER_ERROR_LINE), newStreamState())
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('error')
    expect((out[0] as { message: string }).message).toContain('allowDangerouslySkipPermissions')
  })

  it('accepts the AgentEvent-shaped spelling too (message instead of error)', () => {
    const out = sdkMessageToAgentEvents(
      { type: 'error', message: 'Workspace directory does not exist: D:\\nope' } as never,
      newStreamState(),
    )
    expect((out[0] as { message: string }).message).toContain('Workspace directory does not exist')
  })
})

describe('describeQueryFailure', () => {
  it('quotes the sidecar cause and names the log', () => {
    const s = describeQueryFailure('Error: boom', 'C:\\userData\\openclaude.log')
    expect(s).toContain('OpenClaude run failed')
    expect(s).toContain('boom')
    // The "Error:" prefix carries nothing once we have said "failed".
    expect(s).not.toContain('Error: boom')
    expect(s).toContain('C:\\userData\\openclaude.log')
  })

  it('never leaves the user with an empty reason, and survives no log path', () => {
    expect(describeQueryFailure('   ', null)).toContain('the sidecar reported no reason')
    expect(describeQueryFailure('boom', null)).not.toContain('Full output')
  })
})

describe('OpenClaudeClient — terminal verdict of a failed /query', () => {
  let server: Server
  let port: number
  beforeAll(async () => { ({ server, port } = await serveLines([WRAPPER_ERROR_LINE])) })
  afterAll(() => { server.close() })

  it('reports an error naming the cause and the log, and NEVER a done tick', async () => {
    const events = await collect(port)
    const err = events.find(e => e.type === 'error') as { message: string } | undefined
    expect(err, 'the failure must reach the transcript').toBeTruthy()
    expect(err!.message).toContain('OpenClaude run failed')
    expect(err!.message).toContain('allowDangerouslySkipPermissions')
    expect(err!.message).toContain('openclaude.log')

    const done = events.filter(e => e.type === 'done') as { reason: string }[]
    expect(done).toHaveLength(1)
    // THE PIN. This was `stop` — the "✓ Done (stop)" the driver photographed.
    expect(done[0].reason).toBe('error')
  })
})

describe('OpenClaudeClient — terminal verdict of a silent /query', () => {
  let server: Server
  let port: number
  // A stream that closes having said nothing: no error, no assistant text.
  beforeAll(async () => {
    ({ server, port } = await serveLines([
      JSON.stringify({ type: 'system', session_id: 's1', model: 'nemotron' }),
      JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 0 } }),
    ]))
  })
  afterAll(() => { server.close() })

  it('ends ENDED-INCOMPLETE (empty-text), reusing the TACHI vocabulary', async () => {
    const events = await collect(port)
    const done = events.find(e => e.type === 'done') as
      { reason: string; incomplete?: boolean; incompleteCode?: string; incompleteDetail?: string }
    expect(done.reason).toBe('stop')
    expect(done.incomplete).toBe(true)
    expect(done.incompleteCode).toBe('empty-text')
    expect(done.incompleteDetail).toBeTruthy()
  })
})

// ── THE CAUSE MUST COME FROM THE EVIDENCE ────────────────────────────────────
//
// Driver, 2026-08-02, second finding. The UI printed:
//
//   Provider quota or credits exhausted — check your plan or switch provider.
//   openclaude auth/billing error: unknown
//
// over a log reading `msg 1 system init / msg 2 assistant / msg 3 result
// success`. The account was fine; the billing page it sent the user to was fine.
//
// `error` on an assistant turn is the SDK's error CATEGORY, not a message —
// `unknown` is literally its word for "we could not tell" — and the sentence we
// wrapped it in contained the word "billing", which is what classifyProviderError
// then matched. We diagnosed our own prefix.
describe('describeAssistantApiError — the SDK\'s words, or none', () => {
  it('quotes the provider text and adds nothing of ours to it', () => {
    const s = describeAssistantApiError({
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Provider rate limit reached. Retry in a few seconds.' }] },
    } as never)
    expect(s).toBe('API Error: Provider rate limit reached. Retry in a few seconds.')
    expect(s).not.toContain('auth/billing')
  })

  it('carries errorDetails, which is where the raw provider payload survives', () => {
    const s = describeAssistantApiError({
      type: 'assistant',
      error: 'invalid_request',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The conversation exceeded the provider context limit.' }] },
      errorDetails: 'context_length_exceeded: 210000 > 200000',
    } as never)
    expect(s).toContain('context_length_exceeded')
  })

  it('THE DRIVER\'S CASE: category `unknown`, no text — there is no cause to name', () => {
    // The SDK writes "(no content)" when it had nothing. That placeholder is not
    // a cause either, and treating it as one is how it would have become a
    // diagnosis in a different costume.
    for (const content of [undefined, [], [{ type: 'text', text: '(no content)' }]]) {
      expect(describeAssistantApiError({
        type: 'assistant',
        error: 'unknown',
        isApiErrorMessage: true,
        ...(content ? { message: { role: 'assistant', content } } : {}),
      } as never), JSON.stringify(content)).toBeNull()
    }
  })

  it('a category that DOES mean something is reported even with no message', () => {
    const s = describeAssistantApiError({ type: 'assistant', error: 'billing_error' } as never)
    expect(s).toContain('billing_error')
    expect(s).toContain('reported no message')
  })

  it('the quota sentence is now reserved for evidence of quota', () => {
    // The classifier reads the SDK's own words instead of ours. `unknown` no
    // longer routes to a billing page; the provider's own quota sentence and the
    // SDK's own billing_error category still do.
    //
    // THE REGRESSION GUARDED HERE: the SDK tags its quota_exhausted case with
    // the category `rate_limit`. Appending that category to the provider's own
    // sentence flipped the diagnosis, because RATE_RE is tested before QUOTA_RE
    // — our added words steering a diagnosis about the provider's words, which
    // is the original defect one notch subtler. So when there are words, the
    // string is the words.
    const quotaText = describeAssistantApiError({
      type: 'assistant',
      error: 'rate_limit',
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Provider quota or usage allotment has run out. Please enable billing for your provider.' }] },
    } as never)
    expect(quotaText).not.toContain('rate_limit')
    expect(classifyProviderError(quotaText)).toBe('quota')
    expect(classifyProviderError(describeAssistantApiError({ type: 'assistant', error: 'billing_error' } as never))).toBe('quota')
    expect(classifyProviderError(describeAssistantApiError({ type: 'assistant', error: 'authentication_failed' } as never))).toBe('auth')
    // …and the old line, for comparison: a pure fabrication that classified.
    expect(classifyProviderError('openclaude auth/billing error: unknown')).toBe('quota')
  })

  it('the mapper reports it once, as an error, never also as assistant prose', () => {
    const out = sdkMessageToAgentEvents({
      type: 'assistant',
      error: 'invalid_request',
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: the model rejected tool payloads.' }] },
    } as never, newStreamState())
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('error')
    expect(out.some(e => e.type === 'text')).toBe(false)
  })

  it('a flagged-but-causeless turn emits NOTHING and is remembered on the state', () => {
    const state = newStreamState()
    expect(sdkMessageToAgentEvents({ type: 'assistant', error: 'unknown' } as never, state)).toEqual([])
    expect(state.apiErrorWithoutCause).toBe(true)
  })
})

describe('OpenClaudeClient — the driver\'s successful-but-empty run, end to end', () => {
  let server: Server
  let port: number
  // The exact three messages the log recorded, with msg 2 carrying the SDK's
  // categorised-but-causeless API error.
  beforeAll(async () => {
    ({ server, port } = await serveLines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'olafangensan-glm-4.7-flash-heretic' }),
      JSON.stringify({ type: 'assistant', error: 'unknown', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: '(no content)' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 12, output_tokens: 0 } }),
    ]))
  })
  afterAll(() => { server.close() })

  it('names no cause it cannot support, and lands on the silent-finish verdict', async () => {
    const events = await collect(port)

    // NOT a billing diagnosis, and not a failure with an invented reason.
    const errs = events.filter(e => e.type === 'error') as { message: string }[]
    expect(errs.map(e => e.message).join(' ')).not.toMatch(/billing|quota|credit/i)
    expect(errs).toHaveLength(0)

    const done = events.find(e => e.type === 'done') as
      { reason: string; incomplete?: boolean; incompleteCode?: string; incompleteDetail?: string }
    // The vocabulary this repo already had for "it said nothing".
    expect(done.reason).toBe('stop')
    expect(done.incomplete).toBe(true)
    expect(done.incompleteCode).toBe('empty-text')
    // …and the flag is DISCLOSED rather than swallowed or dressed up.
    expect(done.incompleteDetail).toContain('flagged an API error')
    expect(done.incompleteDetail).toContain('reported no cause')
    expect(done.incompleteDetail).toContain('openclaude.log')
    expect(done.incompleteDetail).not.toMatch(/billing|quota/i)
  })
})

// ── PRE-STREAM FAILURES END THE RUN TOO ──────────────────────────────────────
//
// The three ways a /query can die before the first NDJSON byte — the sidecar is
// not listening, it answers non-2xx, it answers with no body — each emitted an
// `error` and returned. No terminal event, ever: the block that hands out
// `done reason:'error' | 'abort'` and the classifyRunEnd verdict sits below the
// stream loop these branches return above, so the 2026-08-01 pass that gave
// every OTHER exit a verdict never reached them. A caller awaiting a terminal
// event waits for one that is not coming.
describe('OpenClaudeClient — the sidecar is not listening', () => {
  it('reports the connect failure AND ends the run', async () => {
    const events = await collectBounded(await closedPort())
    const err = events.find(e => e.type === 'error') as { message: string } | undefined
    expect(err?.message).toContain('Cannot connect to openclaude')

    const done = events.filter(e => e.type === 'done') as { reason: string }[]
    // THE PIN: this array was empty. One terminal event, and it says failed —
    // the same shape the in-stream failure path already ends on.
    expect(done).toHaveLength(1)
    expect(done[0].reason).toBe('error')
  })
})

describe('OpenClaudeClient — the sidecar answers non-2xx', () => {
  let server: Server
  let port: number
  beforeAll(async () => {
    await new Promise<void>(resolve => {
      server = createServer((_req, res) => { res.writeHead(500); res.end('nope') })
      server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve() })
    })
  })
  afterAll(() => { server.close() })

  it('reports the status AND ends the run', async () => {
    const events = await collectBounded(port)
    expect((events.find(e => e.type === 'error') as { message: string }).message).toContain('HTTP 500')
    const done = events.filter(e => e.type === 'done') as { reason: string }[]
    expect(done).toHaveLength(1)
    expect(done[0].reason).toBe('error')
  })
})

describe('OpenClaudeClient — a 2xx with no body at all', () => {
  let server: Server
  let port: number
  // 204 is the honest reproduction: fetch reports ok:true and body:null, which
  // is exactly the state `res.body?.getReader()` returns undefined for.
  beforeAll(async () => {
    await new Promise<void>(resolve => {
      server = createServer((_req, res) => { res.writeHead(204); res.end() })
      server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve() })
    })
  })
  afterAll(() => { server.close() })

  it('reports the empty response AND ends the run', async () => {
    const events = await collectBounded(port)
    expect((events.find(e => e.type === 'error') as { message: string }).message).toContain('no body')
    const done = events.filter(e => e.type === 'done') as { reason: string }[]
    expect(done).toHaveLength(1)
    expect(done[0].reason).toBe('error')
  })
})

describe('OpenClaudeClient — stopped before the request was answered', () => {
  it('ends on abort, not on error and not on silence', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    // Same closed-port trick is unnecessary — the aborted signal makes fetch
    // reject with AbortError before any socket work matters.
    const events = await collectBounded(await closedPort(), ctrl.signal)
    const done = events.filter(e => e.type === 'done') as { reason: string }[]
    expect(done).toHaveLength(1)
    // A user pressing stop is not a failure, and it is not nothing either —
    // the post-stream abort check has always said 'abort'; this now agrees.
    expect(done[0].reason).toBe('abort')
    expect(events.some(e => e.type === 'error')).toBe(false)
  })
})

describe('OpenClaudeClient — a run that actually answered', () => {
  let server: Server
  let port: number
  beforeAll(async () => {
    ({ server, port } = await serveLines([
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'here you go' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 3 } }),
    ]))
  })
  afterAll(() => { server.close() })

  it('still gets the plain success tick — the narrowing must not accuse a healthy run', async () => {
    const events = await collect(port)
    const done = events.find(e => e.type === 'done') as { reason: string; incomplete?: boolean }
    expect(done.reason).toBe('stop')
    expect(done.incomplete).toBeUndefined()
  })
})

// ── AND THE STREAM CAN DIE BETWEEN THE FIRST TOKEN AND THE LAST ──────────────
//
// The pre-stream trio above covers every way a /query fails to START. Nothing
// covered the way it fails to FINISH: the sidecar crashing, the machine
// sleeping, a proxy cutting a long run. `reader.read()` rejects, and the stream
// loop had a `finally` and no `catch`, so the rejection walked out of _stream
// past the accounting AND past the terminal block — the run ended with tokens
// spent, no ledger row, and no `done`. The last-ditch `.catch` in sendTask then
// emitted an `error`, which is not a terminal event in this vocabulary.
//
// The server here is the honest reproduction: real NDJSON bytes, then the
// socket destroyed with the chunked response unterminated, which is exactly
// what undici surfaces as a mid-stream failure.

/** Serve `lines`, then kill the socket without terminating the response. */
function serveThenDie(lines: string[]): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      for (const l of lines) res.write(l + '\n')
      // Long enough for the client to have decoded the lines above, so the test
      // is about an interrupted ANSWER rather than an interrupted handshake.
      setTimeout(() => req.socket.destroy(), 60)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

describe('OpenClaudeClient — the stream dies mid-answer', () => {
  let server: Server
  let port: number
  beforeAll(async () => {
    ({ server, port } = await serveThenDie([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'half an answ' }] } }),
    ]))
    ledgerCalls.length = 0
  })
  afterAll(() => { server.close() })

  it('ends the run, says the text is a fragment, and still records the spend', async () => {
    const events = await collectBounded(port)

    // The half-answer reached the transcript — this is not a run that failed to
    // start, and the test would be meaningless if it were.
    expect(events.filter(e => e.type === 'text')).not.toHaveLength(0)

    const err = events.find(e => e.type === 'error') as { message: string } | undefined
    expect(err, 'a stream that died owes the user a reason').toBeTruthy()
    expect(err!.message).toContain('cut off')
    // The sentence a user acts on: what is above them is a fragment.
    expect(err!.message).toContain('not where the model finished')
    expect(err!.message).toContain('openclaude.log')

    // THE PIN. This array was empty: the rejection skipped the terminal block
    // entirely, so a caller awaiting a verdict waited for one that never came.
    const done = events.filter(e => e.type === 'done') as { reason: string }[]
    expect(done).toHaveLength(1)
    expect(done[0].reason).toBe('error')

    // THE SECOND PIN, and the more expensive one: tokens were really consumed.
    // The rejection also skipped recordSpend, so the 30-day cap never saw them
    // — a ledger that under-counts is the one direction a spend cap may not err.
    expect(ledgerCalls, 'an interrupted run still spent tokens').toHaveLength(1)
    const [provider, model, promptTokens, completionTokens] = ledgerCalls[0] as [string, string, number, number]
    expect(provider).toBe('opengateway')
    expect(model).toBe('claude-sonnet-5')
    expect(promptTokens).toBeGreaterThan(0)
    // Estimated from the partial text, because no `result` message arrived to
    // report the real totals — the fragment is what we know was generated.
    expect(completionTokens).toBeGreaterThan(0)
  })
})

describe('OpenClaudeClient — stopped WHILE the answer was streaming', () => {
  let server: Server
  let port: number
  const sockets: import('node:net').Socket[] = []
  // Writes one line and then holds the connection open forever, so the only
  // thing that can end this run is the user's stop.
  beforeAll(async () => {
    await new Promise<void>(resolve => {
      server = createServer((req, res) => {
        sockets.push(req.socket)
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } }) + '\n')
      })
      server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve() })
    })
    ledgerCalls.length = 0
  })
  afterAll(() => { for (const s of sockets) s.destroy(); server.close() })

  it('ends on abort — a stop is not a torn connection, even though it tears one', async () => {
    const ctrl = new AbortController()
    const events: AgentEvent[] = []
    const done = await new Promise<{ reason: string }>(resolve => {
      new OpenClaudeClient(port).sendTask('.', 'do a thing', e => {
        events.push(e)
        // Stop the moment the first token lands: this is the user pressing stop
        // mid-answer, which rejects the pending read with AbortError.
        if (e.type === 'text') ctrl.abort()
        if (e.type === 'done') resolve(e as { reason: string })
      }, ctrl.signal)
    })

    expect(done.reason).toBe('abort')
    // THE PIN: aborting mid-stream reported "OpenClaude run failed", because
    // the rejection took the same path a crash does. A deliberate stop is not a
    // failure — the pre-stream abort check has always said so.
    expect(events.some(e => e.type === 'error')).toBe(false)
    // …and the tokens it did produce before the stop are still charged.
    expect(ledgerCalls).toHaveLength(1)
  })
})

describe('describeStreamInterruption', () => {
  it('warns about the fragment only when there IS one', () => {
    const cut = describeStreamInterruption('TypeError: terminated', true, 'C:\\userData\\openclaude.log')
    expect(cut).toContain('cut off')
    expect(cut).toContain('terminated')
    // The prefix carries nothing once we have said the stream died.
    expect(cut).not.toContain('TypeError:')

    const silent = describeStreamInterruption('fetch failed', false, null)
    expect(silent).toContain('dropped before it answered')
    // No fragment to warn about, so no sentence about one.
    expect(silent).not.toContain('not where the model finished')
    expect(silent).not.toContain('Full output')
  })

  it('never leaves the user with an empty reason', () => {
    expect(describeStreamInterruption('  ', true, null)).toContain('ended without saying why')
  })
})
