// apps/desktop/electron/services/design-generate.ts
//
// The Design tab's generation core (TACHI Design — the open-source Claude-Design
// surface). One OpenAI-compatible /chat/completions call that turns a prompt +
// brand preset into ONE self-contained HTML document, streamed token-by-token so
// the UI can show the page building. Mirrors compatVisionChat for endpoint/auth
// resolution and reuses the SAME provider registry + egress gate, so it never
// invents a new credential or egress path.
//
// Supported providers: any fixed-baseUrl OpenAI-compatible gateway in the
// registry (Bankr / Surplus / OpenGateway / Venice) + local Ollama. PRIVATE MODE
// is enforced via enforceProviderEgress() exactly like every other network call.

import {
  getProvider, buildDesignSystemPrompt, extractHtmlDocument, isVisionModel, getPreset,
  buildAnimationSystemPrompt, extractCompositionCode, buildRemotionHtml, buildRemotionHtmlFromJs,
  sanitizeComposition, buildBriefSystemPrompt, buildClarifySystemPrompt, resolveContextWindow,
  buildHyperframesSystemPrompt, extractHyperframesHtml, buildHyperframesPreviewHtml,
  parseClarifyReply, clarifyQuestionsToText, type ClarifyQuestion,
} from '@tachi/core'

// The preview loads vendored GSAP from this in-app scheme (offline/private-safe).
const HYPERFRAMES_GSAP_URL = 'tachi-preview://asset/gsap.min.js'
// R8b: the TypeScript compiler is loaded ON FIRST TRANSPILE, not at boot.
// Measured 90 ms of the 1317 ms pre-STARTUP_T0 prelude (main.ts →
// design.ipc.ts → here) for a package used at exactly ONE call site,
// compileComposition() — which only runs when the user generates an `animate`
// design with the Remotion engine. Bare specifier ⇒ `require()` (allowed; see
// test/unit/noRuntimeRelativeRequire.test.ts) so compileComposition stays
// SYNCHRONOUS and its caller chain (buildAnimationHtml → extractAnimation, 3
// sync call sites) keeps its exact shape. A load failure surfaces through
// buildAnimationHtml's existing try/catch → the Babel scaffold fallback, the
// same path a transpile failure has always taken.
import { stitchContinuation, animationValid, repairPrompt } from './design-continue'
import { retrieveKey } from './keychain'
import { listDesignAudio } from './design-audio'
import { enforceProviderEgress } from './egress-policy'
import { anthropicVisionChat, prefersAnthropicVision } from './vision-chat'

// Token budgets derived from the model's REAL capability (same registry the chat +
// agent use), instead of arbitrary hardcodes. contextWindow is the INPUT window
// (Claude 200k, Gemini 1M, GPT 128k); model OUTPUT caps are far smaller, so the
// output is a generous fixed ceiling for big models. ~3.5 chars/token, reserving
// headroom for the system prompt + the response.
function designBudgets(model: string): { ctxChars: number; outMax: number } {
  // resolveContextWindow, not the raw row: an uncatalogued id has no window, and
  // budgeting against a 32k assertion it never earned truncated the brief. The
  // assumed number is still what we divide by, but it is now labelled as such at
  // the source rather than masquerading as the model's limit.
  const ctx = resolveContextWindow(model).tokens
  // Output ceiling first — generous for big models, but never more than a quarter
  // of the window for small ones (a 32k model must not be asked for 16k output).
  const outMax = Math.min(
    ctx >= 128_000 ? 32_000 : ctx >= 32_000 ? 16_000 : 4_096,
    Math.floor(ctx * 0.25),
  )
  // Input budget in chars (~3.5 chars/token). Reserve headroom for the system
  // prompt + the response (outMax), scaled to the model — NOT a flat 48k, which
  // overflowed small-context models. Then cap so the input alone can never exceed
  // ~60% of the whole window (leaves room for prompt + reply).
  const reserveTokens = Math.min(48_000, outMax + Math.round(ctx * 0.15))
  const ctxChars = Math.max(8_000, Math.min(
    Math.round((ctx - reserveTokens) * 3.5),
    Math.round(ctx * 0.6 * 3.5),
  ))
  return { ctxChars, outMax }
}

let tsModule: typeof import('typescript') | null = null
/** The TypeScript compiler, loaded on first transpile (see header). Memoized. */
function typescriptCompiler(): typeof import('typescript') {
  return (tsModule ??= require('typescript') as typeof import('typescript'))
}

/**
 * Transpile a generated Remotion composition (TSX) → plain JS in the MAIN process,
 * using classic JSX (React.createElement, no jsx-runtime import) so the output drops
 * straight into the Babel-free scaffold (buildRemotionHtmlFromJs). This removes the
 * ~3 MB @babel/standalone download + in-browser transpile that made the live preview
 * slow to load. Falls back to the Babel scaffold if transpile ever throws.
 */
function compileComposition(tsx: string): string {
  const ts = typescriptCompiler()
  const sanitized = sanitizeComposition(tsx)
  return ts.transpileModule(sanitized, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
  }).outputText
}
function buildAnimationHtml(tsx: string): string {
  try { return buildRemotionHtmlFromJs(compileComposition(tsx)) }
  catch { return buildRemotionHtml(tsx) }
}

export interface GenerateDesignInput {
  /** CANONICAL provider id (bankr-gateway / surplus / opengateway / venice / ollama-local). */
  providerId: string
  model: string
  prompt: string
  /** Brand preset id (resolved to a spec for the system prompt). */
  presetId?: string
  /** Freeform DESIGN.md direction layered on top of the preset. */
  designMd?: string
  /** Existing document to refine (iteration) — sent to the model in full. */
  currentHtml?: string
  /** Optional reference image (data: URL or https) — used only for vision models. */
  refImage?: string
  /** Attached project/brand context (dropped files + picked folder) the design should serve. */
  context?: string
  /** 'page' (default) = static HTML design; 'animate' = a motion composition. */
  mode?: 'page' | 'animate'
  /** Animation engine (only in 'animate' mode). 'remotion' (default) = React/
   *  frame-based → MP4; 'hyperframes' = HTML/GSAP-timeline composition. */
  engine?: 'remotion' | 'hyperframes'
  /** Prior turns in the thread (e.g. the discovery Q&A) — threaded in so the build honors them. */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
}

/** Resolve the OpenAI-compatible base URL + bearer key for a provider. */
function resolveEndpoint(providerId: string): { base: string; key: string | null; label: string } {
  const desc = getProvider(providerId)
  if (desc?.baseUrl && desc.openaiCompatible) {
    return {
      base: desc.baseUrl.replace(/\/+$/, ''),
      key: desc.keychainId ? retrieveKey(desc.keychainId) : null,
      label: desc.label,
    }
  }
  // Ollama exposes an OpenAI-compatible surface on a fixed loopback port; the
  // registry leaves baseUrl undefined for local providers, so resolve it here.
  if (providerId === 'ollama-local' || providerId === 'ollama') {
    return { base: 'http://127.0.0.1:11434/v1', key: null, label: 'Ollama' }
  }
  throw new Error(
    `Design generation isn't wired for "${providerId}" yet — use Bankr, Surplus, OpenGateway, Venice, or Ollama.`,
  )
}

/** Build the chat messages (system design contract + user request, multimodal when a ref image is present). */
function buildMessages(input: GenerateDesignInput, brief?: string, ctxChars = 120_000): Array<Record<string, unknown>> {
  const animate = input.mode === 'animate'
  const hyperframes = animate && input.engine === 'hyperframes'
  const system = !animate
    ? buildDesignSystemPrompt({ preset: getPreset(input.presetId), designMd: input.designMd, brief, iterating: !!input.currentHtml?.trim() })
    : hyperframes
      ? buildHyperframesSystemPrompt({ brief })
      // Remotion compositions may score themselves with the user's design-audio
      // files (Voiceover panel) — the contract pins the exact allowlist.
      : buildAnimationSystemPrompt({ brief, audioFiles: listDesignAudio().map(f => f.name) })

  let userText = input.prompt.trim() || (animate ? 'Create a short, polished animation.' : 'Design a beautiful, modern landing page.')
  if (input.currentHtml && input.currentHtml.trim()) {
    // For hyperframes the "current" doc is the composition HTML (```html); for
    // remotion it's the TSX module (```tsx); for pages it's the page HTML.
    const lang = animate && !hyperframes ? 'tsx' : 'html'
    const noun = hyperframes ? 'HyperFrames composition' : animate ? 'Remotion composition' : 'page'
    userText += `\n\nHere is the current ${noun} — apply my change and return the FULL updated ${lang === 'tsx' ? 'module' : 'document'}:\n\n\`\`\`${lang}\n${input.currentHtml.trim()}\n\`\`\``
  }

  const useImage = !!input.refImage && isVisionModel(input.model)
  if (useImage) {
    userText += animate
      ? `\n\n(A reference image is ATTACHED — study it and USE it: match its exact palette and visual style, and if it shows a logo/mark/subject, recreate it faithfully as the hero of the animation using inline SVG / divs.)`
      : `\n\n(A reference image is ATTACHED — study it and USE it: match its exact palette and visual style, and recreate any logo/subject from it faithfully in the design.)`
  }
  const userContent: unknown = useImage
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: input.refImage } },
      ]
    : userText

  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
  // Attached context (dropped files / picked folder) → a second system message so
  // the model designs FOR the user's actual project/content, not in a vacuum.
  if (input.context && input.context.trim()) {
    messages.push({
      role: 'system',
      content:
        `CONTEXT — you are designing for this existing project/content. Match its purpose, ` +
        `domain language, naming, and any brand cues you can infer:\n\n${input.context.trim().slice(0, ctxChars)}`,
    })
  }
  // Prior thread turns (the discovery Q&A, earlier asks) so the build honors them.
  for (const h of input.history ?? []) {
    if (h.text && h.text.trim()) messages.push({ role: h.role, content: h.text.slice(0, 12_000) })
  }
  messages.push({ role: 'user', content: userContent })
  return messages
}

/**
 * fetch with automatic retry on gateway errors (502/503/504). Bankr's gateway
 * times out long design generations under load — a bare 504 bubbled straight
 * into the thread as raw HTML and the user had to resend by hand. Backoff is
 * short (the gateway already made us wait); an abort mid-retry propagates.
 */
async function fetchWithGatewayRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | null = null
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init)
    if (![502, 503, 504].includes(res.status)) return res
    last = res
    console.warn(`[design] gateway ${res.status} (attempt ${i + 1}/${tries}) — retrying`)
    if (i < tries - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)))
  }
  return last!
}

/** One non-streaming completion (fallback for gateways that ignore stream:true). */
async function nonStreaming(base: string, key: string | null, label: string, model: string, messages: Array<Record<string, unknown>>, signal?: AbortSignal, maxTokens = 8192): Promise<{ text: string; finish: string | null }> {
  const res = await fetchWithGatewayRetry(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, stream: false, temperature: 0.7, max_tokens: maxTokens }),
    signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label} design generation ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }> }
  const c = json.choices?.[0]?.message?.content
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
    : ''
  return { text, finish: json.choices?.[0]?.finish_reason ?? null }
}

/**
 * One STREAMING completion with the idle-timeout guard. Some gateways (Bankr,
 * observed in the wild) stall mid-stream: they stop sending bytes but never
 * send [DONE] nor close the socket, which would hang `reader.read()` FOREVER
 * (UI stuck on "designing…"). If no chunk arrives for IDLE_MS the read is
 * cancelled and `stalled` is set so the caller can fall back cleanly.
 * `finish` carries the gateway's finish_reason — 'length' means the reply was
 * CUT at the output ceiling and the caller should auto-continue it.
 */
async function streamOnce(
  base: string, key: string | null, label: string, model: string,
  messages: Array<Record<string, unknown>>, maxTokens: number,
  onDelta?: (chunk: string) => void, signal?: AbortSignal,
): Promise<{ text: string; finish: string | null; stalled: boolean }> {
  const res = await fetchWithGatewayRetry(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7, max_tokens: maxTokens }),
    signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label} design generation ${res.status}: ${body.slice(0, 300)}`)
  }
  let text = ''
  let finish: string | null = null
  let stalled = false
  if (!res.body) return { text, finish, stalled }
  const IDLE_MS = 60_000
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done = false
  while (!done) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), IDLE_MS) })
    const r = await Promise.race([reader.read(), idle])
    if (timer) clearTimeout(timer)
    if ('timedOut' in r) { stalled = true; try { await reader.cancel() } catch { /* ignore */ } break }
    const { value, done: d } = r
    if (d) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') { done = true; break }
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }> }
        const piece = json.choices?.[0]?.delta?.content
        if (typeof piece === 'string' && piece) { text += piece; onDelta?.(piece) }
        const fr = json.choices?.[0]?.finish_reason
        if (typeof fr === 'string' && fr) finish = fr
      } catch { /* partial/non-JSON keep-alive line — ignore */ }
    }
  }
  return { text, finish, stalled }
}

// Continuation stitching, animate validity, and the repair prompt are PURE and
// live in ./design-continue (unit-tested under apps/desktop/test/).

/** Direction pass: a short non-streaming call that returns a concrete creative brief. */
async function generateBrief(base: string, key: string | null, _label: string, input: GenerateDesignInput, signal?: AbortSignal): Promise<string> {
  const sys = buildBriefSystemPrompt(input.mode === 'animate' ? 'animate' : 'page')
  let userText = input.prompt.trim() || (input.mode === 'animate' ? 'A short, polished motion graphic.' : 'A modern landing page.')
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: sys }]
  if (input.context && input.context.trim()) {
    messages.push({ role: 'system', content: `PROJECT CONTEXT (design for this):\n${input.context.trim().slice(0, 60_000)}` })
  }
  const useImage = !!input.refImage && isVisionModel(input.model)
  if (useImage) userText += `\n\n(A reference image is ATTACHED — derive the palette and visual style from it, and plan to recreate any logo/subject it shows.)`
  // Bankr drops base64 images on /chat/completions → use the native /v1/messages path.
  if (useImage && prefersAnthropicVision(input.providerId, input.model)) {
    try {
      const fullSys = input.context?.trim() ? `${sys}\n\nPROJECT CONTEXT:\n${input.context.trim().slice(0, 60_000)}` : sys
      const { text } = await anthropicVisionChat({ providerId: input.providerId, model: input.model, system: fullSys, userText, imageUrls: [input.refImage!], maxTokens: 700, signal })
      return text.trim()
    } catch { return '' }
  }
  messages.push({ role: 'user', content: useImage ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: input.refImage } }] : userText })

  const res = await fetchWithGatewayRetry(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: input.model, messages, stream: false, temperature: 0.85, max_tokens: 700 }),
    signal,
  })
  if (!res.ok) return ''
  const json = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: unknown } }> }
  const c = json.choices?.[0]?.message?.content
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
    : ''
  return text.trim()
}

/**
 * DISCOVERY pass (Claude-Design-style): one short non-streaming call that returns a
 * few targeted clarifying questions for the user to answer BEFORE the build. Honors
 * an attached reference image (vision) + project context so it doesn't ask about
 * what's already provided. Returns structured questions (for the interactive
 * interview card) plus a plain-text rendering (message body / history threading);
 * `structured` is null when the model ignored the JSON contract.
 */
export async function clarifyDesign(
  input: GenerateDesignInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{ text: string; structured: ClarifyQuestion[] | null }> {
  if (!input.model || input.model === 'auto') throw new Error('Pick a specific model first (not "auto").')
  enforceProviderEgress(input.providerId)
  const { base, key } = resolveEndpoint(input.providerId)
  const sys = buildClarifySystemPrompt(input.mode === 'animate' ? 'animate' : 'page')
  const userText = input.prompt.trim() || (input.mode === 'animate' ? 'A short animation.' : 'A landing page.')
  const useImage = !!input.refImage && isVisionModel(input.model)

  // Bankr+Claude drops base64 on /chat/completions → native /v1/messages so the
  // questions can actually reference the attached reference image.
  if (useImage && prefersAnthropicVision(input.providerId, input.model)) {
    const fullSys = input.context?.trim() ? `${sys}\n\nPROJECT CONTEXT:\n${input.context.trim().slice(0, 60_000)}` : sys
    const { text } = await anthropicVisionChat({ providerId: input.providerId, model: input.model, system: fullSys, userText, imageUrls: [input.refImage!], maxTokens: 600, signal: opts.signal })
    return toClarifyResult(text.trim())
  }

  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: sys }]
  if (input.context && input.context.trim()) messages.push({ role: 'system', content: `PROJECT CONTEXT (design for this):\n${input.context.trim().slice(0, 60_000)}` })
  messages.push({ role: 'user', content: useImage ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: input.refImage } }] : userText })

  const res = await fetchWithGatewayRetry(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: input.model, messages, stream: false, temperature: 0.6, max_tokens: 600 }),
    signal: opts.signal,
  })
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`Discovery ${res.status}: ${b.slice(0, 200)}`) }
  const json = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: unknown } }> }
  const c = json.choices?.[0]?.message?.content
  const raw = (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('') : '').trim()
  return toClarifyResult(raw)
}

/** Parse the clarify reply: structured questions when the JSON contract was
 *  honored, with the plain-text rendering alongside (raw as-is otherwise). */
function toClarifyResult(raw: string): { text: string; structured: ClarifyQuestion[] | null } {
  const structured = parseClarifyReply(raw)
  return { text: structured ? clarifyQuestionsToText(structured) : raw, structured }
}

/**
 * Generate (or refine) a self-contained HTML design. Streams assistant text via
 * `onDelta`; returns the extracted document plus the raw reply. Falls back to a
 * single non-streaming request if streaming yields nothing.
 */
export async function generateDesign(
  input: GenerateDesignInput,
  opts: { onDelta?: (chunk: string) => void; signal?: AbortSignal } = {},
): Promise<{ html: string; raw: string; code?: string; finish?: string | null }> {
  if (!input.model || input.model === 'auto') {
    throw new Error('Pick a specific model for design generation (not "auto").')
  }
  enforceProviderEgress(input.providerId) // PRIVATE MODE / egress gate (throws if blocked)
  const { base, key, label } = resolveEndpoint(input.providerId)
  const { ctxChars, outMax } = designBudgets(input.model) // model-aware context + output budgets

  // DIRECTION PASS (open-design's planning gate): for a FRESH design an art
  // director commits to a concrete creative direction first; the build then
  // implements it exactly. This is the main lever that turns generic model output
  // into something designed. Skipped on refine; non-fatal if it fails.
  let brief = ''
  if (!input.currentHtml?.trim()) {
    try {
      brief = await generateBrief(base, key, label, input, opts.signal)
      if (brief) opts.onDelta?.(`/* ART DIRECTION\n${brief}\n*/\n\n`)
    } catch { /* build without a brief */ }
  }
  const messages = buildMessages(input, brief, ctxChars)

  // BUILD with an image on Bankr+Claude: the OpenAI /chat/completions path drops
  // the image, so use the native /v1/messages vision endpoint (non-streamed) — the
  // model actually SEES the reference. Reconstruct system+user from `messages`.
  if (input.refImage && isVisionModel(input.model) && prefersAnthropicVision(input.providerId, input.model)) {
    const sys = messages.filter(m => m.role === 'system').map(m => String((m as { content?: unknown }).content ?? '')).join('\n\n')
    const userMsg = messages.find(m => m.role === 'user')
    const uc = (userMsg as { content?: unknown } | undefined)?.content
    const userText = typeof uc === 'string' ? uc
      : Array.isArray(uc) ? (uc as Array<{ type?: string; text?: string }>).filter(p => p.type === 'text').map(p => p.text ?? '').join('') : ''
    const { text } = await anthropicVisionChat({ providerId: input.providerId, model: input.model, system: sys, userText, imageUrls: [input.refImage], maxTokens: outMax, signal: opts.signal })
    if (text) opts.onDelta?.(text)
    if (input.mode === 'animate') return extractAnimation(text, input.engine)
    return { html: extractHtmlDocument(text), raw: text }
  }

  // Output ceiling from the model's capability (generous for big models) so a full
  // multi-section page or a 30–60s multi-scene Remotion module isn't truncated.
  const maxTokens = outMax
  const first = await streamOnce(base, key, label, input.model, messages, maxTokens, opts.onDelta, opts.signal)
  let raw = first.text
  let finish = first.finish

  // No stream output, OR the stream stalled mid-flight (the partial is unreliable
  // — almost always cut mid-tag) → one clean non-streaming request.
  if (first.stalled || !raw.trim()) {
    const nr = await nonStreaming(base, key, label, input.model, messages, opts.signal, maxTokens)
    raw = nr.text
    finish = nr.finish
    if (raw) opts.onDelta?.(raw)
  }

  // AUTO-CONTINUE a reply cut at the output ceiling (finish_reason 'length'):
  // resend with the partial as an assistant turn and stitch the remainder on.
  // Two rounds max — beyond that the module is unreasonably large anyway.
  for (let i = 0; i < 2 && finish === 'length' && raw.trim(); i++) {
    console.warn(`[design] reply hit the output limit — auto-continuing (round ${i + 1}/2)`)
    const contMessages = [
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: 'Your reply was cut off by the output limit. Continue EXACTLY where it stopped — output ONLY the remaining text (no repetition, no commentary, do not reopen the code fence).' },
    ]
    const cont = await streamOnce(base, key, label, input.model, contMessages, maxTokens, opts.onDelta, opts.signal)
    finish = cont.finish
    if (!cont.text.trim()) break
    raw = stitchContinuation(raw, cont.text)
    if (cont.stalled) break
  }

  // Animation mode → the model wrote a composition; wrap it for live preview and
  // keep the source (`code`) for refine + export.
  if (input.mode === 'animate') {
    const out = extractAnimation(raw, input.engine)
    if (animationValid(out.code, input.engine)) return { ...out, finish }
    // No playable composition in the reply (conversational answer, mangled
    // fences, hard truncation…) → ONE corrective round-trip instead of dumping
    // "try a stronger model" at the user.
    console.warn(`[design] no valid ${input.engine ?? 'remotion'} composition in the reply (finish=${finish ?? '?'}) — auto-retrying once`)
    opts.onDelta?.('\n\n/* RETRY — the reply had no complete composition; asking the model to re-emit the full module */\n\n')
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: raw.slice(0, 24_000) },
      { role: 'user', content: repairPrompt(input.engine) },
    ]
    try {
      const rep = await streamOnce(base, key, label, input.model, repairMessages, maxTokens, opts.onDelta, opts.signal)
      let rraw = rep.text
      let rfinish = rep.finish
      if (rep.stalled || !rraw.trim()) {
        const nr = await nonStreaming(base, key, label, input.model, repairMessages, opts.signal, maxTokens)
        rraw = nr.text
        rfinish = nr.finish
        if (rraw) opts.onDelta?.(rraw)
      }
      const out2 = extractAnimation(rraw, input.engine)
      if (animationValid(out2.code, input.engine)) return { ...out2, finish: rfinish }
      finish = rfinish ?? finish
    } catch (err) {
      // Keep the original result — the caller reports the extraction failure.
      console.warn('[design] repair round-trip failed:', err instanceof Error ? err.message : err)
    }
    return { ...out, finish }
  }
  return { html: extractHtmlDocument(raw), raw, finish }
}

/**
 * Turn a model reply into { html (preview-playable), code (source), raw }.
 *   remotion    → code = TSX module,   html = Remotion <Player> scaffold.
 *   hyperframes → code = composition HTML, html = composition + vendored GSAP
 *                 + auto-play/loop bootstrap.
 */
function extractAnimation(raw: string, engine: GenerateDesignInput['engine']): { html: string; raw: string; code: string } {
  if (engine === 'hyperframes') {
    const code = extractHyperframesHtml(raw)
    return { html: buildHyperframesPreviewHtml(code, HYPERFRAMES_GSAP_URL), raw, code }
  }
  const code = extractCompositionCode(raw)
  return { html: buildAnimationHtml(code), raw, code }
}
