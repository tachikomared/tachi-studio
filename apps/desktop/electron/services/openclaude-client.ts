import type { AgentEvent } from '@tachi/core'
// classifyTask is the SAME zero-LLM classifier the chat path feeds the ledger
// with (chat-service.ts: `classifyTask(messageText(message))` → record's 5th
// argument). Imported from core, not from chat-service: the two callers share a
// classifier, not a module.
import { estimateTokens, classifyTask, type TaskType } from '@tachi/core'
// Sidecar spend accounting (closes audit gap "sidecar spend unrecorded"): one
// usage event per completed /query into the cost ledger, using the token totals
// the SDK's terminal `result` message reports and falling back to a character
// estimate only when a gateway reports none. Lazy/dynamic require keeps this
// module electron-free for vitest (mirrors getCostLedger's own convention).
import { getCostLedger } from './cost-ledger'
// PRIVATE MODE Tier 2: per-request privacy mode forwarded to the wrapper.
// The wrapper inlines its own copy of the egress-policy denylist; this
// forwards the current main-process mode so a mid-session toggle takes
// effect on the very next /query without restarting the sidecar.
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'
// PRIVATE MODE Tier 4: per-request capability mode forwarded to the wrapper
// for symmetry with privacyMode and to keep future wrapper-side gates honest.
// The actual user-approval fork (modal vs inbox) lives in agent.ipc.ts, where
// the tool-call event is intercepted before the wrapper even runs canUseTool.
// This field is currently informational on the wrapper side — see the comment
// in openclaude-installer.ts WRAPPER_TEMPLATE.
import { capabilityService } from './capability-service'
// TERMINAL CLASSIFICATION — the SAME decision table the TACHI loop ends on
// (services/tachi/outcome.ts). Reused, not re-implemented: "the run said
// nothing" must read identically whichever harness produced the silence, and a
// second vocabulary would be a second thing to keep honest.
import { classifyRunEnd } from './tachi/outcome'

// ─── SDK message shapes (from @gitlawb/openclaude/sdk v0.14.0) ───────────────
//
// The SDK yields SDKMessage objects with the following top-level types:
//   "assistant" — LLM response: message.content[] holds text/tool_use blocks
//   "user"      — tool results and synthetic user turns
//   "result"    — terminal event: subtype "success" or "error_*"
//   "system"    — init info, retries, compaction events (subtype varies)
//
// Text and tool-call content is embedded inside assistant.message.content[],
// NOT as separate top-level "text"/"tool_use" messages.

interface ContentBlock {
  type: string
  text?: string
  // tool_use block
  id?: string
  name?: string
  input?: unknown
  // tool_result block
  tool_use_id?: string
  content?: unknown
}

interface SDKMessage {
  type: string
  // assistant message
  message?: {
    role: string
    content?: ContentBlock[] | string
  }
  /**
   * The assistant turn's error CATEGORY (`SDKAssistantMessageError`) — NOT a
   * message. Read out of the installed bundle (sdk.mjs
   * `createAssistantAPIErrorMessage`), its vocabulary is a closed set:
   * `unknown` · `invalid_request` · `rate_limit` · `authentication_failed` ·
   * `billing_error` · `max_output_tokens` · `invalid_grant`. The human-readable
   * cause lives in `message.content` (an `API Error: …` text block, or the
   * literal `(no content)` when the SDK had nothing), with the raw provider text
   * in `errorDetails`.
   *
   * We used to print `openclaude auth/billing error: ${error}` for EVERY value
   * of this field. See describeAssistantApiError for what that cost.
   */
  error?: unknown
  /** Raw provider text behind the categorised error, when the SDK kept it. */
  errorDetails?: unknown
  /** The SDK's own flag that this assistant turn IS an API error. */
  isApiErrorMessage?: boolean
  // result terminal event
  subtype?: string
  result?: string
  is_error?: boolean
  errors?: string[]
  /**
   * Anthropic-shaped token totals for the whole /query, present on BOTH result
   * subtypes (SDKResultSuccess / SDKResultError in the SDK's
   * coreTypes.generated.ts, typed `usage: Record<string, number>`). The wrapper
   * forwards each SDK message verbatim, so it reaches us intact.
   *
   * `input_tokens` is the FRESH slice only — the SDK subtracts cache reads
   * (buildAnthropicUsageFromRawUsage in sdk.mjs) and its own total-input
   * formula is input + cache_creation + cache_read. Also populated for
   * OpenAI-compatible gateways: the SDK normalises prompt_tokens /
   * completion_tokens / prompt_tokens_details.cached_tokens into this shape.
   */
  usage?: Record<string, number>
  // system/init info
  model?: string
  // SDK session id emitted in the init system event — used for session continuity
  session_id?: string
  // stream_event partial (Anthropic Messages SSE format)
  event?: {
    type: string
    index?: number
    delta?: { type: string; text?: string; partial_json?: string }
    content_block?: { type: string; name?: string; id?: string }
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class OpenClaudeClient {
  constructor(private readonly port: number) {}

  /**
   * Send a task to the openclaude HTTP server and stream AgentEvents.
   *
   * The server endpoint is POST /query, which streams NDJSON lines.
   * Each line is a serialised SDKMessage from @gitlawb/openclaude/sdk.
   *
   * @param sessionId  Optional SDK session id from a previous turn (for memory continuity).
   * @param resume     When true, tells the SDK to resume the prior conversation.
   * @param onSdkSessionId  Called with the SDK session_id when the wrapper emits the init
   *                        system event. Callers store this and pass it back as `sessionId`
   *                        on the next turn so conversation memory is preserved.
   */
  sendTask(
    workingDir: string,
    task: string,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    sessionId?: string,
    resume?: boolean,
    onSdkSessionId?: (id: string) => void,
    /**
     * The task category, classified BY THE CALLER from the user's own words.
     *
     * The caller is the only place that still holds them. By the time a task
     * reaches this client it has been wrapped in host-authored context —
     * workspace memory, a role block, a reflexion note, a slash instruction —
     * and one caller (approve-plan) sends a directive that contains no user
     * words at all. Classifying here would categorise OUR prose, which is
     * worse than the 'other' it replaces because it looks earned.
     *
     * `stripHostPreamble` remains as the fallback for a caller that supplies
     * nothing; it is a heuristic, and a heuristic is the second-best answer.
     */
    taskType?: TaskType,
  ): void {
    // ── EXACTLY ONE TERMINAL EVENT, FROM EVERY EXIT ─────────────────────────
    // The latch is the contract this method can actually promise its callers:
    // whatever happens downstream — a clean finish, a thrown mapper, a socket
    // reset, a rejected promise — the caller sees one `done` and never two, and
    // never none. Both production callers (agent.ipc.ts) resolve their awaiting
    // promise on `done || error`, so a missing terminal event is a run that
    // hangs and a duplicate is a run that resolves twice.
    let terminated = false
    const emit = (e: AgentEvent): void => {
      if (e.type === 'done') {
        if (terminated) return
        terminated = true
      }
      onEvent(e)
    }
    // Fire-and-forget async stream. This `.catch` used to emit an `error` and
    // stop there — an error is NOT a terminal event in this vocabulary, so a
    // rejection here left the run with no verdict at all. It is now the
    // last-ditch net (the stream loop handles its own transport failures
    // below), and it still has to end the run.
    this._stream(workingDir, task, emit, signal, sessionId, resume, onSdkSessionId, taskType).catch(err => {
      if (terminated) return
      // A stop pressed at the wrong instant is not a failure — same reading the
      // pre-stream and post-stream abort checks already make.
      if (signal.aborted || (err as Error)?.name === 'AbortError') {
        emit({ type: 'done', reason: 'abort' })
        return
      }
      emit({ type: 'error', message: String(err) })
      emit({ type: 'done', reason: 'error' })
    })
  }

  private async _stream(
    workingDir: string,
    task: string,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    sessionId?: string,
    resume?: boolean,
    onSdkSessionId?: (id: string) => void,
    /** See sendTask: classified by the caller, from the user's own words. */
    taskType?: TaskType,
  ): Promise<void> {
    // ── PRE-STREAM FAILURES MUST STILL END THE RUN ──────────────────────────
    // The three branches below (connect refused / non-2xx / no body) each used
    // to emit an `error` and `return`, with no terminal event at all. Every
    // OTHER exit from this method was given a terminal verdict on 2026-08-01 —
    // `done reason:'error'` after a failure, `'abort'` after a stop, the
    // classifyRunEnd verdict otherwise — and these were missed, because they sit
    // above the stream loop that the terminal block lives under.
    //
    // What that costs: a caller awaiting a TERMINAL event never gets one and
    // waits forever. It survived unnoticed because the one production caller
    // (agent.ipc.ts, both sendTask sites) resolves on `done || error`, so the
    // sidecar dying before it could answer looked survivable there — but the
    // contract this file documents is the TACHI vocabulary, and half a contract
    // is the kind that breaks under the next caller rather than this one.
    // `reason:'error'` also renders as "✗ Run failed" (AgentPage's done branch),
    // where nothing rendered before.
    const failBeforeStream = (message: string): void => {
      onEvent({ type: 'error', message })
      onEvent({ type: 'done', reason: 'error' })
    }

    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/query`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          prompt:    task,
          cwd:       workingDir,
          // Forward current PRIVATE MODE so the wrapper's inlined canUseTool
          // denylist (WebFetch / WebSearch / network shell commands) gates
          // tool calls correctly.
          privacyMode: getCurrentPrivacyMode(),
          // PRIVATE MODE Tier 4: forwarded for symmetry. The wrapper's
          // canUseTool decides egress + the workspace sandbox and allows the
          // rest; the USER-approval fork (modal vs inbox) is done in
          // agent.ipc.ts when the tool-call event arrives. Sent here so the
          // wrapper sees the field on every /query in case a future version
          // wants to gate on it.
          //
          // KNOWN ASYMMETRY, not fixed here: for OpenClaude that host gate is
          // POST-HOC — the SDK emits the tool_use block, we hold the event for
          // the user's answer, and the sidecar executes on its own clock
          // meanwhile. TACHI runs tools in this process so its gate pre-empts.
          // Closing it needs a decision channel back into the wrapper's
          // canUseTool (it is already an HTTP server; a pending-permission
          // round-trip is the shape), which is a bigger change than a mode fix.
          capabilityMode: capabilityService.getMode(),
          ...(sessionId ? { sessionId } : {}),
          ...(resume    ? { resume }    : {}),
        }),
        signal,
      })
    } catch (err: unknown) {
      // A stop pressed while the request was still in flight is not a failure,
      // and it gets the same terminal event the post-stream abort check emits —
      // a run aborted one millisecond later already ended on `'abort'`, and the
      // two should not disagree about what happened.
      if ((err as Error)?.name === 'AbortError') { onEvent({ type: 'done', reason: 'abort' }); return }
      failBeforeStream(`Cannot connect to openclaude: ${String(err)}`)
      return
    }

    if (!res.ok) {
      failBeforeStream(`openclaude returned HTTP ${res.status}`)
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      failBeforeStream('openclaude response had no body')
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    /**
     * Did this run surface a FAILURE? Set the moment an `error` event leaves the
     * mapper, and it is what stops the unconditional success tick below.
     *
     * Driver, 2026-08-02: the wrapper reported
     * `SDK permissionMode "bypassPermissions" requires allowDangerouslySkipPermissions`,
     * the stream carried that line, the mapper dropped it (no `error` case), the
     * body then closed normally — and the run was announced as "✓ Done (stop)".
     * A failed run rendering as a success is worse than the crash it replaced.
     */
    let failed = false
    // Per-stream state (NOT module-global) so concurrent OpenClaude sessions
    // don't corrupt each other's dedup flag / tool-name map (audit H4/C4).
    const state = newStreamState()

    // Spend accounting: accumulate the response text we surface to the user and
    // remember the backing model (from the SDK init system event) so we can
    // record the token spend once the /query stream finishes. The terminal
    // `result` message carries the REAL totals; the text accumulator is only
    // the fallback for a gateway that reported none.
    let responseText = ''
    let modelId = ''
    let reported: ReportedUsage | undefined

    try {
      while (!done) {
        if (signal.aborted) break
        const { done: streamDone, value } = await reader.read()
        if (streamDone) { done = true; break }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let msg: SDKMessage
          try { msg = JSON.parse(trimmed) } catch { continue }
          // Capture SDK session_id from the init system event and surface to caller.
          if (msg.type === 'system' && msg.session_id && onSdkSessionId) {
            onSdkSessionId(msg.session_id)
          }
          // Capture the backing model id from the INIT system event.
          //
          // `subtype === 'init'` is load-bearing, and its absence was a bug the
          // comment above it had already described correctly: 'system' also
          // covers retries and compaction events (see the message table at the
          // top of this file), the condition took the LAST one that carried a
          // model, and a mid-run system event is free to carry a different one.
          // The init event is the one that states what this run is backed by.
          if (msg.type === 'system' && msg.subtype === 'init'
              && typeof msg.model === 'string' && msg.model) {
            modelId = msg.model
          }
          // Capture the REPORTED token totals from the terminal result event.
          // Read before sdkMessageToAgentEvents, because an error result makes
          // the loop break — and an error result carries usage too.
          if (msg.type === 'result') {
            reported = parseReportedUsage(msg.usage) ?? reported
          }
          const events = sdkMessageToAgentEvents(msg, state)
          for (const e of events) {
            if (e.type === 'text') responseText += e.text
            if (e.type === 'error') {
              failed = true
              // Name the cause AND where the untruncated output lives — the same
              // contract explainSidecarExit holds for a sidecar that dies.
              onEvent({ type: 'error', message: describeQueryFailure(e.message, await openclaudeLogPathSafe()) })
              continue
            }
            onEvent(e)
          }
          if (events.some(e => e.type === 'done' || e.type === 'error')) {
            done = true
            break
          }
        }
      }
    } catch (err: unknown) {
      // ── THE STREAM CAN DIE MID-ANSWER, AND THAT USED TO END EVERYTHING ─────
      // This block did not exist: `try` had only a `finally`. A socket reset
      // between the first token and the last — the sidecar crashing, the box
      // sleeping, a proxy timing out a long run — rejects `reader.read()`, and
      // the rejection walked out of _stream past BOTH of the things that owe
      // the user something:
      //
      //   • recordSpend, so a run that consumed real tokens recorded NO spend.
      //     The 30-day cap governs on that ledger; silently under-counting is
      //     the one direction it may not err.
      //   • the terminal block, so the run ended with no `done` at all — the
      //     failure the whole 2026-08-01 pass was about, arriving through the
      //     one door that pass did not check.
      //
      // Swallowing it here is deliberate: control now falls through to the
      // accounting and the verdict, which is where every other exit already
      // goes. `failed` makes that verdict `'error'`.
      if (signal.aborted || (err as Error)?.name === 'AbortError') {
        // A stop pressed mid-stream is not a failure. The abort check below
        // gives it `'abort'`, the same word a stop one millisecond earlier got.
      } else {
        failed = true
        onEvent({
          type: 'error',
          message: describeStreamInterruption(String(err), responseText.length > 0, await openclaudeLogPathSafe()),
        })
      }
    } finally {
      reader.cancel().catch(() => {/* ignore */})
    }

    // KNOWN-WRONG PROVIDER LABEL, and not fixable from this file. 'openclaude'
    // The provider is the gateway that SERVED this run, not the harness's own
    // name. sidecar-manager captures it at SPAWN time (routing is fixed when
    // the env is built — re-reading getAgentProviderOverride() here would
    // report the NEXT spawn's gateway, not this process's) and exposes it via
    // getOpenClaudeLedgerProviderId(). 'openclaude' survives only as the
    // fallback for a run whose spawn predates the capture — an id no registry
    // entry carries, priced as unknown, which OVER-counts and is the safe
    // direction for a spend cap. Same defect class the TACHI loop had before
    // 64c837d; with the usage numbers now real, attribution was the last lie
    // in this record.
    // WRAPPED, because accounting must never decide whether a run finishes.
    // `recordSpend` has always documented itself as best-effort ("never break
    // the query") — but the two lookups that feed it sat OUTSIDE that guard, so
    // anything throwing here skipped the terminal event entirely and the run
    // hung with no done and no error. Not hypothetical: adding the model getter
    // below made four tests time out at once, because their sidecar-manager
    // mock did not export it yet. A stub is a module contract, and a run that
    // ANSWERED must still be reported as answered when the bookkeeping fails.
    try {
      const { getOpenClaudeLedgerProviderId, getOpenClaudeLedgerModelId } = await import('./sidecar-manager')
      const provider = getOpenClaudeLedgerProviderId() ?? 'openclaude'
      // AND THE MODEL COLUMN HAD THE SAME DEFECT, undisclosed. It read
      // `modelId || 'openclaude'`: a run that reported no model wrote the
      // HARNESS NAME into the model column — not a model, matching no rate row,
      // and a live ledger row still reads `"model":"openclaude"` because of it.
      // The spawn-time id is the honest answer: it is what this process was
      // pointed at, captured beside the gateway. 'unknown' only when even that
      // is missing, which prices as unknown and OVER-counts — the safe
      // direction for a spend cap, and the one thing a wrong name could not
      // promise.
      const model = modelId || getOpenClaudeLedgerModelId() || 'unknown'
      recordSpend(provider, model, task, responseText, reported, taskType)
    } catch { /* accounting is best-effort; the verdict below is not */ }

    // ── THE TERMINAL EVENT ───────────────────────────────────────────────────
    // It used to be one unconditional line: `done, reason 'stop'`. That single
    // line was the whole of FAILURE 1's second half — it fired after an error,
    // after an abort, and after a run that produced nothing, and each of those
    // rendered as the success tick.
    //
    // The shapes below are the TACHI loop's, verbatim (loop.ts terminal block),
    // so both harnesses end runs in one vocabulary.
    if (failed) {
      onEvent({ type: 'done', reason: 'error' })
      return
    }
    if (signal.aborted) {
      onEvent({ type: 'done', reason: 'abort' })
      return
    }
    // Facts this harness can actually measure. `completionAccepted` is false
    // because OpenClaude has no completion tool, and mutation counting is
    // TACHI's (its tools run in-process) — so of the table's rows only the
    // empty-text one can fire here, which is exactly the honest narrowing: a
    // stream that closed having said nothing is reported as such, and a run
    // that answered is left alone.
    const verdict = classifyRunEnd({
      terminal:           'stop',
      completionAccepted: false,
      mutatingIntent:     false,
      mutations:          0,
      finalText:          responseText,
    })
    // DISCLOSURE, NOT DIAGNOSIS. The sidecar flagged an API error on an
    // assistant turn and then reported the run successful, giving no text, no
    // details and its own `unknown` category — so the honest verdict is the
    // silent one, plus the fact that a flag was raised and where to read the
    // rest. This is the case that used to print "Provider quota or credits
    // exhausted"; the run failed and here is the log beats a confident wrong
    // noun.
    let detail = verdict.detail
    if (detail && state.apiErrorWithoutCause) {
      const log = await openclaudeLogPathSafe()
      detail = `${detail} — the sidecar also flagged an API error on that turn but reported no cause${log ? `; full output: ${log}` : ''}`
    }
    onEvent(verdict.outcome === 'incomplete'
      ? { type: 'done', reason: 'stop', incomplete: true, incompleteCode: verdict.code, incompleteDetail: detail }
      : { type: 'done', reason: 'stop' })
  }

  destroy(): void { /* stateless HTTP client — nothing to close */ }
}

// ─── Failure wording ─────────────────────────────────────────────────────────

/**
 * Turn a raw wrapper failure line into a sentence the operator can act on.
 *
 * Two jobs, both learned from `util/sidecar-exit.ts`: (1) never make the user
 * guess WHAT failed — the sidecar's own text is quoted, never replaced by a
 * category; (2) always say WHERE the full output is, because a one-line UI
 * error is a pointer, not a diagnosis.
 *
 * Pure (the log path is passed in) so it is testable without electron.
 * Exported for unit tests.
 */
export function describeQueryFailure(raw: string, logPath?: string | null): string {
  // The wrapper stringifies an Error, so most lines arrive as "Error: …".
  // The prefix carries no information once we have said "failed".
  const cause = (raw ?? '').trim().replace(/^Error:\s*/i, '').trim()
  const what = cause || 'the sidecar reported no reason'
  const where = logPath ? ` Full output: ${logPath}` : ''
  return `OpenClaude run failed — ${what}.${where}`
}

/**
 * Wording for a stream that DIED PART WAY THROUGH, which is a different event
 * from a run that failed to start and has to read as one.
 *
 * `sawText` is the whole point. When the transcript already holds half an
 * answer, the user's next move depends on knowing that what they are looking at
 * is a fragment — a paragraph that simply stops looks exactly like a model that
 * finished early, and they would act on it. When nothing was said, there is no
 * fragment to warn about and the extra sentence would be noise.
 *
 * Plain words on purpose: this sentence is read by whoever is sitting in front
 * of the app, not by whoever wrote the transport. "The connection dropped" is
 * something anyone can act on; "the stream died mid-answer" is us describing
 * our own plumbing to someone who did not ask about it.
 *
 * The cause is quoted, never replaced by a category — same rule
 * describeQueryFailure holds. Node's fetch reports these as bare `TypeError:
 * terminated` / `fetch failed`, which says little, so the sentence around it
 * carries the meaning the cause cannot. Exported for unit tests.
 */
export function describeStreamInterruption(raw: string, sawText: boolean, logPath?: string | null): string {
  const cause = (raw ?? '').trim().replace(/^(?:Error|TypeError):\s*/i, '').trim()
  const what = cause || 'the connection ended without saying why'
  const where = logPath ? ` Full output: ${logPath}` : ''
  return sawText
    ? `The answer above was cut off — ${what}. It stops where the connection dropped, not where the model finished.${where}`
    : `The connection to OpenClaude dropped before it answered — ${what}.${where}`
}

/**
 * The rolling openclaude log path, or null when it cannot be resolved (vitest,
 * where electron's `app` does not exist). Never throws: a failure message that
 * cannot name the log is still worth showing.
 */
async function openclaudeLogPathSafe(): Promise<string | null> {
  try {
    const { openclaudeLogPath } = await import('./sidecar-manager')
    return openclaudeLogPath()
  } catch {
    return null
  }
}

// ─── Sidecar spend accounting ───────────────────────────────────────────────
//
// ONE usage event per completed /query into the cost ledger. Resilient by
// design: any failure (empty input, ledger/persistence error) is swallowed so a
// spend-accounting hiccup never breaks the agent query. Exported for unit tests.
//
// PREFER WHAT THE PROVIDER REPORTED. This used to always ESTIMATE both counts
// from character length, on the belief that "the wrapper does not report token
// usage" — it does. The SDK's terminal `result` message carries the real
// totals, the wrapper forwards it verbatim, and an estimate that disagrees with
// them is spend the 30-day cap is governed by. The estimate survives only as
// the fallback for a gateway that reported nothing.

/** Real token counts read off the SDK's terminal result message. */
export interface ReportedUsage {
  /** TOTAL input, cache reads included — the ledger's promptTokens contract. */
  promptTokens: number
  completionTokens: number
  /** Cache-read hits: a SUBSET of promptTokens, re-priced (never added) by the ledger. */
  cachedTokens?: number
}

/**
 * Map the SDK's Anthropic-shaped `usage` onto the ledger's contract, or
 * undefined when the object is missing/empty/all-zero — in which case the
 * caller falls back to the character estimate rather than recording a
 * confident zero.
 *
 * input_tokens there is the FRESH slice only, so total input is
 * input + cache_creation + cache_read — the SDK's own formula (sdk.mjs
 * computes totalInput exactly that way for its cache hit-rate). Cache
 * CREATION tokens are counted as ordinary input: they are really sent, and we
 * have no write-premium rate to price them at. Exported for unit tests.
 */
export function parseReportedUsage(usage: Record<string, number> | undefined): ReportedUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const fresh    = num(usage.input_tokens)
  const created  = num(usage.cache_creation_input_tokens)
  const cached   = num(usage.cache_read_input_tokens)
  const output   = num(usage.output_tokens)
  const promptTokens = fresh + created + cached
  if (promptTokens === 0 && output === 0) return undefined
  return { promptTokens, completionTokens: output, ...(cached > 0 ? { cachedTokens: cached } : {}) }
}

/**
 * The user's own words, with the preamble the HOST prepended stripped off —
 * for CLASSIFICATION ONLY. Never used for token counting: the preamble is real
 * input, really paid for, and removing it from the estimate would under-count
 * spend.
 *
 * agent.ipc.ts composes the string we are handed. On the first turn of a session
 * it prepends `<workspace-memory>` (up to 6000 chars of recalled prior-session
 * notes), then `<reflexion>`, then `<role>`, and a `[SLASH COMMAND: /x]`
 * instruction block goes in front of all of it. classifyTask only scans the
 * first 2000 characters, so classifying the raw string would tag most first
 * turns by the recalled notes — a category derived from text the user never
 * wrote, which is exactly the kind of plausible-but-unearned value this ledger
 * must not carry. The task itself is always LAST, so stripping the known
 * wrappers leaves it.
 *
 * The non-greedy close-tag match is safe rather than lucky: recalled memory goes
 * through agent.ipc's fenceUntrusted(), which defangs any
 * `</workspace-memory>` / `</reflexion>` inside the notes precisely so the block
 * cannot be closed early.
 *
 * Anything unrecognised is returned untouched — a preamble shape we do not know
 * about degrades to today's behaviour, never to a wrong answer about the
 * classifier's input. Exported for unit tests.
 */
export function stripHostPreamble(task: string): string {
  if (typeof task !== 'string') return ''
  let out = task
  // Bounded rather than `while (true)`: there are at most four wrappers, and a
  // loop whose exit depends on a regex never matching is a hang waiting for an
  // input nobody predicted. The `out === before` check is the real exit.
  for (let i = 0; i < 8; i++) {
    const before = out
    out = out.replace(/^\s*<(workspace-memory|reflexion|role)>[\s\S]*?<\/\1>\s*/i, '')
    // The slash-command instruction is one unbroken paragraph in all four of
    // buildSlashCommandInstruction's templates, and agent.ipc joins it to the
    // task with a blank line — so the first blank line is its end.
    out = out.replace(/^\s*\[SLASH COMMAND:[\s\S]*?\n[ \t]*\n/, '')
    if (out === before) break
  }
  return out
}

export function recordSpend(
  provider: string,
  model: string,
  promptText: string,
  responseText: string,
  reported?: ReportedUsage,
  /** From the caller when it knows; the preamble heuristic below when it does not. */
  taskType?: TaskType,
): void {
  try {
    const promptTokens     = reported ? reported.promptTokens     : estimateTokens(promptText)
    const completionTokens = reported ? reported.completionTokens : estimateTokens(responseText)
    // TASK TYPE, which this record used to omit — a hardcoded `undefined` in the
    // 5th slot. The ledger buckets a taskType-less event under 'other', so the
    // dashboard's "by task type" view reported EVERY sidecar run as 'other' and
    // the whole OpenClaude harness was invisible in that dimension. Same
    // classifier the chat path uses, on the same kind of input (the task text),
    // so the two harnesses' rows are comparable rather than merely both present.
    getCostLedger().record(
      provider, model, promptTokens, completionTokens,
      taskType ?? classifyTask(stripHostPreamble(promptText)), reported?.cachedTokens,
    )
  } catch { /* spend accounting is best-effort — never break the query */ }
}

// ─── SDK message → AgentEvent ─────────────────────────────────────────────────

/**
 * Per-stream state (one instance per _stream call). Previously two of these were
 * module-level globals, which corrupted concurrent OpenClaude sessions (the
 * parallel-agent feature): one stream flipped another's dedup flag, and all
 * tool results were emitted with name 'tool' so the renderer mispaired parallel
 * tool calls (audit C4/H4). Keeping them per-stream fixes both.
 */
export interface StreamState {
  /** Suppress the duplicate full-message text once partial deltas have arrived. */
  streamedThisTurn: boolean
  /** tool_use_id → tool name, so tool_result can emit the REAL tool name. */
  toolNames: Map<string, string>
  /**
   * An assistant turn was flagged as an API error that carried NO cause — no
   * text, no details, and the SDK's own `unknown` category. That is evidence
   * that something went wrong and no evidence of what, so it does not become a
   * failure with an invented reason; it is carried here and disclosed on the
   * terminal verdict beside the honest "the run said nothing" classification.
   */
  apiErrorWithoutCause: boolean
}

export function newStreamState(): StreamState {
  return { streamedThisTurn: false, toolNames: new Map(), apiErrorWithoutCause: false }
}

/**
 * What we may honestly say about an assistant turn the SDK flagged as an API
 * error — or `null` when the answer is "nothing".
 *
 * WHAT THIS REPLACES. The old line was
 * `openclaude auth/billing error: ${String(msg.error)}`, and it fired for every
 * category. On 2026-08-02 a driver's run produced, on screen:
 *
 *     Provider quota or credits exhausted — check your plan or switch provider.
 *     openclaude auth/billing error: unknown
 *
 * …over a log reading `msg 1 system init / msg 2 assistant / msg 3 result
 * success`. Three separate errors compounded there:
 *
 *   1. `error` is a CATEGORY, not a message — `unknown` is the SDK's own word
 *      for "we could not tell", and we printed it as the cause;
 *   2. we called every category "auth/billing", including that one;
 *   3. our own prefix then FED THE CLASSIFIER: classifyProviderError matches
 *      /billing/, so the word we wrote ourselves is what produced the confident
 *      quota diagnosis. The user was sent to check a billing page that was fine.
 *
 * The rule now: quote the SDK's own words, and pass its own category through
 * verbatim. That is what makes the classification honest rather than circular —
 * `billing_error` classifies as quota because the SDK said billing_error,
 * `authentication_failed` as auth, and `unknown` matches nothing, so the raw
 * sentence is shown as-is instead of being upgraded to a diagnosis.
 *
 * Exported for unit tests.
 */
export function describeAssistantApiError(msg: SDKMessage): string | null {
  const category = typeof msg.error === 'string' ? msg.error.trim() : String(msg.error ?? '').trim()
  // The SDK's placeholder for "the error message was empty" — it is not a cause,
  // and treating it as one is how "(no content)" would have become a diagnosis.
  const NO_CONTENT = '(no content)'
  const parts: string[] = []
  const content = msg.message?.content
  if (typeof content === 'string') {
    if (content.trim() && content.trim() !== NO_CONTENT) parts.push(content.trim())
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && b.text.trim() !== NO_CONTENT) {
        parts.push(b.text.trim())
      }
    }
  }
  if (typeof msg.errorDetails === 'string' && msg.errorDetails.trim()) parts.push(msg.errorDetails.trim())

  const words = parts.join(' — ')
  // THE SDK'S OWN WORDS, AND NOTHING OF OURS. Not even its category, when there
  // are words: `classifyProviderError` reads whatever string we return, and its
  // rate-limit rule is checked before its quota rule — so appending the SDK's
  // `rate_limit` tag to its own sentence "Provider quota … enable billing"
  // downgraded a genuine quota failure to a rate limit. That is the SAME defect
  // as the original, one notch subtler: text we add steering a diagnosis about
  // text the provider wrote. Anything we would append lives in the log already.
  if (words) return words
  // No words, but a category that means something — say exactly that much.
  if (category && category !== 'unknown') {
    return `the sidecar flagged an API error categorised \`${category}\` and reported no message`
  }
  // Neither. There is no cause to name, and naming one anyway is the defect
  // this function exists to delete.
  return null
}

// Exported for unit testing (regression coverage for the C4/H4 tool-pairing +
// per-stream-isolation fix). The HTTP transport stays internal.
export function sdkMessageToAgentEvents(msg: SDKMessage, state: StreamState): AgentEvent[] {
  const t = msg.type

  // ── Wrapper-level failure line ────────────────────────────────────────────
  // `{"type":"error","error":"…"}` is OUR wrapper's shape, not an SDK message
  // type — written when the /query handler throws (a rejected SDK option, a
  // missing workspace directory) and by the two workspace guards before the
  // query even starts. There was no case for it here, so every one of those
  // lines fell through all five SDK branches to the bare `return []` at the
  // bottom and was silently DISCARDED. That is why the operator saw a run that
  // errored, produced nothing, and still claimed success.
  //
  // Read `error` first (what the wrapper writes) and `message` second (what an
  // AgentEvent-shaped line would carry) so either survives the trip.
  if (t === 'error') {
    const m = msg as unknown as { error?: unknown; message?: unknown }
    const raw = typeof m.error === 'string' ? m.error
      : typeof m.message === 'string' ? m.message
      : m.error !== undefined ? String(m.error)
      : ''
    return [{ type: 'error', message: raw }]
  }

  // ── Partial stream events (token-by-token streaming) ──
  // SDK emits these when includePartialMessages:true. Forward text deltas
  // so the UI can render the assistant message as it streams in.
  if (t === 'stream_event') {
    const ev = msg.event
    if (!ev) return []
    // Anthropic-format text delta
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      state.streamedThisTurn = true
      return [{ type: 'text', text: ev.delta.text }]
    }
    return []
  }

  // ── Assistant turn: extract text and tool_use content blocks ──
  if (t === 'assistant') {
    const events: AgentEvent[] = []

    // An API-error turn. Its `content` IS the error text, so it is reported
    // once, as an error, and never also as assistant prose.
    if (msg.error || msg.isApiErrorMessage) {
      const cause = describeAssistantApiError(msg)
      if (cause !== null) return [{ type: 'error', message: cause }]
      // Flagged, but with nothing behind the flag. Do NOT manufacture a
      // failure: a result the sidecar goes on to call successful, carrying no
      // assistant text, is the SILENT-FINISH case this repo already has words
      // for (classifyRunEnd → ENDED-INCOMPLETE). The flag itself is remembered
      // and disclosed on the terminal event, so nothing is swallowed.
      state.apiErrorWithoutCause = true
      return []
    }

    const content = msg.message?.content
    if (!content) return []

    if (typeof content === 'string') {
      if (content) events.push({ type: 'text', text: content })
      return events
    }

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        // If we already streamed token deltas for this turn, the final
        // assistant message duplicates the text we already showed.
        // Reset and skip — the deltas already produced the full text.
        if (state.streamedThisTurn) {
          state.streamedThisTurn = false
        } else {
          events.push({ type: 'text', text: block.text })
        }
      }
      if (block.type === 'tool_use') {
        const inputStr = typeof block.input === 'string'
          ? block.input
          : JSON.stringify(block.input ?? {})
        const name = block.name ?? 'unknown'
        // Remember the id→name so the matching tool_result emits the real name
        // (the SDK can run several tools in one turn; without this they'd all
        // come back as 'tool' and the renderer would pair them wrong — C4).
        if (block.id) state.toolNames.set(block.id, name)
        events.push({ type: 'tool-call', name, input: inputStr })
      }
    }
    return events
  }

  // ── User turn: only care about tool_result blocks ──
  if (t === 'user') {
    const events: AgentEvent[] = []
    const content = msg.message?.content
    if (!Array.isArray(content)) return []
    for (const block of content) {
      if (block.type === 'tool_result') {
        // content inside a tool_result can be an array of {type:"text",text:"..."} or a string
        const inner = block.content
        let output = ''
        if (typeof inner === 'string') {
          output = inner
        } else if (Array.isArray(inner)) {
          output = (inner as ContentBlock[])
            .filter(c => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text ?? '')
            .join('')
        }
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        const name = (id && state.toolNames.get(id)) || 'tool'
        events.push({ type: 'tool-done', name, output })
      }
    }
    return events
  }

  // ── Terminal result event — signals completion (or error) ──
  if (t === 'result') {
    if (msg.is_error || (msg.subtype && msg.subtype.startsWith('error_'))) {
      const errMsg = msg.errors?.join('; ') ?? msg.result ?? 'openclaude error'
      return [{ type: 'error', message: errMsg }]
    }
    // Successful result: let the outer loop emit 'done' after the for-await loop ends
    return []
  }

  // ── System messages: ignore most, but surface api_retry as transient info ──
  // (no AgentEvent type for "info", so we skip these)
  if (t === 'system') return []

  return []
}
