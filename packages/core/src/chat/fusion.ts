// FUSION — provider-agnostic "panel → judge analysis → grounded synthesis".
//
// Faithful to OpenRouter's Fusion ("Fusion beats frontier"): a single prompt is
// answered by a PANEL of several models in parallel; a JUDGE then produces a
// STRUCTURED ANALYSIS of the candidates (consensus / contradictions / partial
// coverage / unique insights / blind spots); finally the synthesizer writes ONE
// answer GROUNDED in that analysis. The explicit analysis stage is what lifts the
// fused output past any single frontier model. (Their panel members also run with
// web-search enabled; our OpenAI-compat backends don't forward tools, so panels
// here are pure text — a deliberate difference, not faked.)
//
// Runs over any ChatBackend, so it's a pure, unit-testable function: pass a
// backend + key + model ids, get back a single ChatChunk stream identical in
// shape to a normal reply (the renderer needs no new contract).
import type {
  ChatBackend,
  ChatChunk,
  ChatMessage,
  ChatPanelMember,
  FriendlyProviderError,
  TokenUsage,
} from './backend.js'

export interface FusionOptions {
  /** The chat turn's messageId — every yielded chunk is stamped with it. */
  messageId: string
  /** Conversation turns (user/assistant); the system prompt is passed separately. */
  messages: ChatMessage[]
  /** Shared system prompt for the panel; also folded into the judge stages. */
  system?: string
  /** Model ids to fan out over (the panel). */
  panel: string[]
  /** Model that produces the analysis AND writes the grounded final answer. */
  judgeModel: string
  maxTokens?: number
  /**
   * How to combine the panel into one answer:
   *  - 'synthesize' (default) — judge writes a NEW fused answer (best for
   *    complementary / long-form). Optionally two-stage (see analysisStage).
   *  - 'best_of_n' — judge picks the single STRONGEST candidate, served verbatim
   *    (best for code / factual; one model is likely fully right). 1 judge call.
   *  - 'majority' — vote by agreement across legs, served verbatim, NO extra LLM
   *    (best for extraction / classification).
   *  - 'compare' — NO combining at all: every panel answer is delivered
   *    side-by-side via a `panel` chunk and the USER picks (no judge call).
   */
  arbiter?: 'synthesize' | 'best_of_n' | 'majority' | 'compare'
  /**
   * What the panel is producing. 'synthesis' (default) fuses several answers into
   * one. 'plan' fuses several INDEPENDENT implementation plans for the same task
   * into ONE clean, actionable plan: the analysis stage compares the plans (steps
   * they agree on, gaps/risks each missed, conflicts, unique good ideas) and the
   * synthesizer emits ONLY the final plan — no "Plan A / Plan B" meta. Only
   * affects the 'synthesize' arbiter. Used by the agent's fuse_plan tool.
   */
  mode?: 'synthesis' | 'plan'
  /**
   * For 'synthesize' only: run the explicit structured-analysis stage before
   * synthesis (OpenRouter's approach). Default true. When false, a single judge
   * call reads the candidates and writes the answer directly (one fewer call).
   */
  analysisStage?: boolean
  /**
   * Optional predicate to drop a panel member (model id) BEFORE fanning out — e.g.
   * a caller-side circuit breaker that skips a model id which keeps erroring. Pure:
   * runFusion only filters; it never tracks state. If filtering would remove EVERY
   * member, the predicate is ignored and the full panel runs (Fusion never
   * dead-ends). Absent => no filtering (existing behavior unchanged).
   */
  skipMember?: (modelId: string) => boolean
  /**
   * Fired once per panel member after it settles, with whether it produced a
   * usable answer — lets the caller record outcomes (e.g. open/close a breaker).
   * Called for every fanned-out member, before onPanel/the arbiter.
   */
  onMemberResult?: (modelId: string, ok: boolean) => void
  /** Fired once after the panel settles, before the arbiter runs (observability). */
  onPanel?: (members: FusionPanelMember[]) => void
  /** Fired once with the structured analysis text (synthesize stage), if produced. */
  onAnalysis?: (analysis: string) => void
  /** Fired with the winning leg for best_of_n / majority (observability). */
  onWinner?: (member: FusionPanelMember) => void
}

export interface FusionPanelMember {
  model: string
  text: string
  ok: boolean
  error?: FriendlyProviderError
  usage?: TokenUsage
  /** Wall time for this member's full answer, ms (measured around its stream). */
  ms?: number
  /**
   * Time-to-first-token, ms — from the leg's request start to its first delta.
   * Undefined when no delta ever arrived (leg failed before streaming), so
   * consumers can render "—" instead of a fabricated number.
   */
  ttftMs?: number
}

/**
 * Drain a ChatChunk stream to a full string. Concatenates `delta` text, keeps
 * the last `usage`, and surfaces the first `error` (with whatever text arrived
 * before it). The gateway has no non-streaming call, so panel members + the
 * analysis stage are produced by draining a stream.
 *
 * Also measures `ttftMs` — wall time from this call to the FIRST delta chunk —
 * so compare columns can show a truthful time-to-first-token. Undefined when
 * the stream never produced a delta.
 */
export async function collectStream(
  iter: AsyncIterable<ChatChunk>,
): Promise<{ text: string; usage?: TokenUsage; error?: FriendlyProviderError; ttftMs?: number }> {
  const started = Date.now()
  let ttftMs: number | undefined
  let text = ''
  let usage: TokenUsage | undefined
  let error: FriendlyProviderError | undefined
  for await (const chunk of iter) {
    switch (chunk.type) {
      case 'delta':
        if (ttftMs === undefined && chunk.text.length > 0) ttftMs = Date.now() - started
        text += chunk.text
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'error':
        if (!error) error = chunk.error
        break
      default:
        break
    }
    if (error) break
  }
  return { text, usage, error, ttftMs }
}

/**
 * Re-run ONE panel member (model) in isolation — the building block behind the
 * Fusion panel's RE-RUN affordance. Pure and electron-free (backend + key are
 * injected, usage is metered via an optional callback) so it's unit-testable.
 *
 * Sends `brief` as a single user message to `model`, drains the stream, and
 * reports whether the leg produced a usable answer:
 *   - a thrown error (before or during streaming) → { ok: false, error }
 *   - a streamed error chunk                       → { ok: false, error }
 *   - an empty / whitespace-only answer            → { ok: false, error }
 *   - otherwise                                    → { ok: true, chars }
 * `meter` (when supplied) is called with the leg's TokenUsage on any successful
 * stream that reported usage, mirroring how runFusion meters its legs.
 */
export async function rerunFusionMember(opts: {
  backend: ChatBackend
  key:     string | null
  model:   string
  brief:   string
  meter?:  (usage: TokenUsage) => void
}): Promise<{ ok: boolean; chars: number; error?: string }> {
  try {
    const { text, usage, error } = await collectStream(
      opts.backend.sendMessage(
        { messages: [{ role: 'user', content: opts.brief }], model: opts.model },
        opts.key ?? '',
      ),
    )
    if (usage) { try { opts.meter?.(usage) } catch { /* best-effort metering */ } }
    if (error) return { ok: false, chars: 0, error: error.message }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, chars: 0, error: 'Empty response' }
    return { ok: true, chars: trimmed.length }
  } catch (err) {
    return { ok: false, chars: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

const ANALYSIS_DIMENSIONS = 'consensus points, contradictions, partial coverage, unique insights, and blind spots'

/** Judge stage: read the candidates, emit a structured analysis (no final answer). */
export const FUSION_ANALYSIS_SYSTEM = [
  'You are the FUSION judge.',
  'Below are several candidate answers to the user\'s request, produced independently by different models.',
  'Read them all and produce a STRUCTURED ANALYSIS ONLY — do NOT write the final answer yet.',
  `Cover exactly these five dimensions as short labelled sections: 1) Consensus points 2) Contradictions 3) Partial coverage 4) Unique insights 5) Blind spots.`,
  'Be concise and specific; note which candidate each point comes from where it helps.',
].join(' ')

/** Synthesis stage: write the final answer grounded in the analysis. */
export const FUSION_SYNTH_SYSTEM = [
  `You are the FUSION synthesizer. Below is a structured analysis (${ANALYSIS_DIMENSIONS}) of several candidate answers to the user\'s request.`,
  'Write the ONE best final answer to the user\'s request, GROUNDED in that analysis:',
  'resolve contradictions with the most defensible reasoning, incorporate the unique insights, and cover the blind spots.',
  'Answer directly as the assistant — do not mention the panel, the candidates, or the analysis.',
].join(' ')

/** Single-call fallback (analysisStage:false): weigh candidates and answer in one pass. */
export const FUSION_JUDGE_SYSTEM = [
  'You are the FUSION synthesizer.',
  'Below are several candidate answers to the user\'s request, produced independently by different models and given to you only as reference material.',
  `Silently weigh them across ${ANALYSIS_DIMENSIONS} (resolving conflicts in favor of the most defensible reasoning, not the majority).`,
  'Then write ONE single, definitive best answer to the user\'s request.',
  'Do not mention the panel, the candidates, or that you are synthesizing — answer directly as the assistant.',
].join(' ')

// ── PLAN mode — fuse several INDEPENDENT implementation plans into one clean
// plan. The agent's fuse_plan tool runs these instead of the prose-answer prompts
// above. The synthesizer is told to emit ONLY the plan (no hedge / no "Plan A
// said") — the measured sweet-spot for fusion: independent frontier plans, merged,
// surface steps a single model misses.

/** PLAN judge stage: compare several independent plans (no final plan yet). */
export const FUSION_PLAN_ANALYSIS_SYSTEM = [
  'You are the FUSION plan judge.',
  'Below are several candidate IMPLEMENTATION PLANS for the SAME task, drafted independently by different models.',
  'Read them all and produce a STRUCTURED ANALYSIS ONLY — do NOT write the final plan yet.',
  'Cover exactly these five dimensions as short labelled sections: 1) Steps every plan agrees on 2) Conflicting or contradictory steps 3) Gaps — necessary steps that some plans missed 4) Unique good ideas only one plan had 5) Risks, wrong assumptions, or ordering hazards any plan made.',
  'Be concrete: reference the real files/functions/steps, and note which candidate each point comes from where it helps.',
].join(' ')

/** PLAN synthesis stage: emit ONE final actionable plan grounded in the analysis. */
export const FUSION_PLAN_SYNTH_SYSTEM = [
  'You are the FUSION plan synthesizer. Below is a structured analysis of several candidate implementation plans for the user\'s task.',
  'Produce ONE final, actionable, step-by-step implementation plan GROUNDED in that analysis:',
  'keep the steps the plans agreed on, resolve conflicts in favour of the most defensible approach, ADD the gaps that were missed, fold in the unique good ideas, and account for the risks and ordering hazards.',
  'Output ONLY the final plan as ordered steps, referencing concrete files/functions where known.',
  'Do NOT mention the candidate plans, the models, "Plan A/B", or that several plans existed — no preamble and no commentary, just the plan.',
].join(' ')

/** PLAN single-call fallback (analysisStage:false): weigh the plans + write one in a single pass. */
export const FUSION_PLAN_JUDGE_SYSTEM = [
  'You are the FUSION plan synthesizer.',
  'Below are several candidate IMPLEMENTATION PLANS for the SAME task, drafted independently by different models and given to you only as reference material.',
  'Silently weigh them: keep the steps they agree on, resolve conflicts in favour of the most defensible approach, add the necessary steps some missed, fold in unique good ideas, and account for risks and ordering hazards.',
  'Then write ONE final, actionable, step-by-step implementation plan, referencing concrete files/functions where known.',
  'Do NOT mention the candidate plans, the models, or that you are synthesizing — output only the plan.',
].join(' ')

const candidateBlock = (members: FusionPanelMember[]): string =>
  members.map((m, i) => `--- Candidate ${i + 1} (model: ${m.model}) ---\n${m.text}`).join('\n\n')

/** Judge analysis system: original system + analysis instructions + candidates. */
export function buildAnalysisSystem(system: string | undefined, members: FusionPanelMember[], mode: 'synthesis' | 'plan' = 'synthesis'): string {
  const head = system ? `${system}\n\n` : ''
  const instr = mode === 'plan' ? FUSION_PLAN_ANALYSIS_SYSTEM : FUSION_ANALYSIS_SYSTEM
  return `${head}${instr}\n\n${candidateBlock(members)}`
}

/** Synthesizer system: original system + synth instructions + the analysis. */
export function buildSynthSystem(system: string | undefined, analysis: string, mode: 'synthesis' | 'plan' = 'synthesis'): string {
  const head = system ? `${system}\n\n` : ''
  const instr = mode === 'plan' ? FUSION_PLAN_SYNTH_SYSTEM : FUSION_SYNTH_SYSTEM
  return `${head}${instr}\n\n--- ANALYSIS ---\n${analysis}`
}

/** Single-call fallback system: original system + judge instructions + candidates. */
export function buildJudgeSystem(system: string | undefined, members: FusionPanelMember[], mode: 'synthesis' | 'plan' = 'synthesis'): string {
  const head = system ? `${system}\n\n` : ''
  const instr = mode === 'plan' ? FUSION_PLAN_JUDGE_SYSTEM : FUSION_JUDGE_SYSTEM
  return `${head}${instr}\n\n${candidateBlock(members)}`
}

/** best_of_n judge: pick the single strongest candidate, reply with ONLY its number. */
export const FUSION_SELECT_SYSTEM = [
  'You are the FUSION judge.',
  'Below are several candidate answers to the user\'s request, produced independently by different models.',
  `Weigh them across ${ANALYSIS_DIMENSIONS}, then choose the SINGLE strongest candidate.`,
  'Reply with ONLY its number (for example: 2) — no other text, no explanation, no punctuation.',
].join(' ')

/** best_of_n judge system: original system + select instructions + candidates. */
export function buildSelectSystem(system: string | undefined, members: FusionPanelMember[]): string {
  const head = system ? `${system}\n\n` : ''
  return `${head}${FUSION_SELECT_SYSTEM}\n\n${candidateBlock(members)}`
}

/** Parse the judge's 1-based choice into a 0-based index, clamped to [0, n-1]. */
export function parseSelectionIndex(text: string, n: number): number {
  const m = text.match(/\d+/)
  if (!m) return 0
  const one = Number.parseInt(m[0], 10)
  if (!Number.isFinite(one) || one < 1 || one > n) return 0
  return one - 1
}

/**
 * Majority vote (no LLM): group legs by normalized text and return the
 * representative of the largest group. Ties (incl. all-unique) resolve to the
 * earliest leg in panel order — i.e. the strongest model is the default winner.
 */
export function pickMajority(members: FusionPanelMember[]): FusionPanelMember {
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
  const groups = new Map<string, FusionPanelMember[]>()
  for (const m of members) {
    const k = norm(m.text)
    const g = groups.get(k)
    if (g) g.push(m)
    else groups.set(k, [m])
  }
  let best = members[0]
  let bestSize = 0
  for (const g of groups.values()) {
    if (g.length > bestSize) {
      bestSize = g.length
      best = g[0]
    }
  }
  return best
}

const addUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined => {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/** Label rendered in the model chip under the reply. */
export function fusionLabel(judgeModel: string, panelSize: number, arbiter: string = 'synthesize'): string {
  if (arbiter === 'compare') return `compare (${panelSize})` // no judge involved
  const tag = arbiter === 'synthesize' ? 'fusion' : `fusion/${arbiter}`
  return `${tag}:${judgeModel} (${panelSize})`
}

/**
 * Run a Fusion turn. Fans the prompt out to every `panel` model concurrently,
 * drops members that error or come back empty, has the judge produce a structured
 * analysis, then streams the judge's answer grounded in that analysis. Yields a
 * normal ChatChunk stream (one messageId): start → synthesis deltas → summed
 * usage → done. Emits an error chunk (and skips the judge) only if the entire
 * panel fails.
 */
export async function* runFusion(
  backend: ChatBackend,
  apiKey: string,
  opts: FusionOptions,
): AsyncIterable<ChatChunk> {
  const { messageId, messages, system, panel, judgeModel, maxTokens, skipMember, onMemberResult, onPanel, onAnalysis, onWinner } = opts
  const analysisStage = opts.analysisStage !== false
  const arbiter = opts.arbiter ?? 'synthesize'
  const mode = opts.mode ?? 'synthesis'

  // Apply the caller's skip predicate (e.g. a circuit breaker) BEFORE fanning out.
  // If it would drop EVERY member, ignore it and run the full panel so Fusion
  // never dead-ends. Filtering never mutates caller state (core stays pure).
  let activePanel = panel
  if (skipMember) {
    const kept = panel.filter((model) => !skipMember(model))
    if (kept.length > 0) activePanel = kept
  }

  yield { type: 'start', messageId, model: fusionLabel(judgeModel, activePanel.length, arbiter) }

  const panelMessages: ChatMessage[] = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages

  const settled = await Promise.allSettled(
    activePanel.map(async (model) => {
      const started = Date.now()
      const out = await collectStream(backend.sendMessage({ messages: panelMessages, model, maxTokens }, apiKey))
      return { ...out, ms: Date.now() - started }
    }),
  )

  const members: FusionPanelMember[] = settled.map((res, i) => {
    const model = activePanel[i]
    if (res.status === 'rejected') {
      return { model, text: '', ok: false, error: { code: 'PANEL_THREW', message: String(res.reason) } }
    }
    const { text, usage, error, ms, ttftMs } = res.value
    return { model, text, usage, error, ms, ttftMs, ok: !error && text.trim().length > 0 }
  })

  if (onMemberResult) for (const m of members) onMemberResult(m.model, m.ok)
  onPanel?.(members)

  const usable = members.filter((m) => m.ok)

  if (usable.length === 0) {
    const firstErr = members.find((m) => m.error)?.error
    yield {
      type: 'error',
      messageId,
      error: firstErr ?? { code: 'FUSION_NO_PANEL', message: 'Every model in the Fusion panel failed to answer.' },
    }
    yield { type: 'done', messageId }
    return
  }

  let runningUsage = usable.reduce<TokenUsage | undefined>((acc, m) => addUsage(acc, m.usage), undefined)

  // COMPARE — no combining at all: deliver every usable answer side-by-side via
  // a `panel` chunk and let the USER pick a column in the UI. The tiny delta
  // below is a fallback body (old saves / surfaces without panel rendering);
  // the renderer replaces it with the chosen column's text on pick.
  if (arbiter === 'compare') {
    const panelChunkMembers: ChatPanelMember[] = usable.map((m) => ({
      model: m.model,
      text: m.text,
      ok: m.ok,
      ms: m.ms ?? 0,
      tokens: m.usage?.completionTokens,
      ttftMs: m.ttftMs,
      error: m.error?.message,
    }))
    yield { type: 'panel', messageId, members: panelChunkMembers }
    yield { type: 'delta', messageId, text: `⚖ ${usable.length} models answered — pick an answer in the columns above.` }
    if (runningUsage && runningUsage.totalTokens > 0) yield { type: 'usage', messageId, usage: runningUsage }
    yield { type: 'done', messageId }
    return
  }

  // MAJORITY — vote by agreement, NO extra LLM. Serve the winning leg verbatim.
  if (arbiter === 'majority') {
    const winner = pickMajority(usable)
    onWinner?.(winner)
    yield { type: 'delta', messageId, text: winner.text }
    if (runningUsage && runningUsage.totalTokens > 0) yield { type: 'usage', messageId, usage: runningUsage }
    yield { type: 'done', messageId }
    return
  }

  // BEST_OF_N — one judge call returns the strongest leg's index; serve it verbatim.
  if (arbiter === 'best_of_n') {
    const sel = await collectStream(
      backend.sendMessage(
        { messages: [{ role: 'system', content: buildSelectSystem(system, usable) }, ...messages], model: judgeModel, maxTokens },
        apiKey,
      ),
    )
    runningUsage = addUsage(runningUsage, sel.usage)
    const winner = usable[parseSelectionIndex(sel.text, usable.length)]
    onWinner?.(winner)
    yield { type: 'delta', messageId, text: winner.text }
    if (runningUsage && runningUsage.totalTokens > 0) yield { type: 'usage', messageId, usage: runningUsage }
    yield { type: 'done', messageId }
    return
  }

  // SYNTHESIZE (default) — judge writes a NEW fused answer (optionally two-stage).
  // Stage 2 (optional but default): structured analysis of the candidates.
  let synthSystem: string
  if (analysisStage) {
    const analysisMessages: ChatMessage[] = [
      { role: 'system', content: buildAnalysisSystem(system, usable, mode) },
      ...messages,
    ]
    const analysis = await collectStream(
      backend.sendMessage({ messages: analysisMessages, model: judgeModel, maxTokens }, apiKey),
    )
    runningUsage = addUsage(runningUsage, analysis.usage)
    onAnalysis?.(analysis.text)
    synthSystem = buildSynthSystem(system, analysis.text || '(no analysis produced)', mode)
  } else {
    synthSystem = buildJudgeSystem(system, usable, mode)
  }

  // Stage 3: stream the grounded final answer.
  const synthMessages: ChatMessage[] = [{ role: 'system', content: synthSystem }, ...messages]
  let synthUsage: TokenUsage | undefined
  for await (const chunk of backend.sendMessage({ messages: synthMessages, model: judgeModel, maxTokens }, apiKey)) {
    switch (chunk.type) {
      case 'delta':
        yield { type: 'delta', messageId, text: chunk.text }
        break
      case 'usage':
        synthUsage = chunk.usage
        break
      case 'error':
        yield { type: 'error', messageId, error: chunk.error }
        yield { type: 'done', messageId }
        return
      default:
        break
    }
  }

  const total = addUsage(runningUsage, synthUsage)
  if (total && total.totalTokens > 0) {
    yield { type: 'usage', messageId, usage: total }
  }
  yield { type: 'done', messageId }
}
