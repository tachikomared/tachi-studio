// packages/core/src/design/prompt.ts
//
// Pure builders for the Design tab: turn a brand preset (+ optional DESIGN.md
// override) into a system prompt that makes the model emit ONE production-grade,
// self-contained HTML document, and extract that document back out of the
// model's reply. No I/O — unit-testable, renderer-safe.

import type { BrandPreset, DesignSpec, RadiusScale, Density } from './types.js'
import { DESIGN_TASTE, PALETTE_DIRECTIVE } from './skills.js'

const RADIUS_PX: Record<RadiusScale, string> = {
  none: '0px', sm: '4px', md: '8px', lg: '14px', xl: '24px',
}
const DENSITY_HINT: Record<Density, string> = {
  compact: 'tight spacing, dense information layout',
  comfortable: 'balanced spacing',
  spacious: 'generous whitespace and large rhythm',
}

/** Render a DesignSpec into a compact, model-readable design-system block. */
export function renderSpec(spec: DesignSpec): string {
  const c = spec.colors
  const lines = [
    `Vibe: ${spec.vibe}`,
    `Palette: bg ${c.bg} · surface ${c.surface} · text ${c.text} · muted ${c.muted} · accent ${c.accent} (on-accent ${c.accentText}) · border ${c.border}`,
    `Type: headings "${spec.fonts.heading}", body "${spec.fonts.body}"${spec.fonts.mono ? `, mono "${spec.fonts.mono}"` : ''} (load non-system families from Google Fonts via <link>)`,
    `Corner radius: ${RADIUS_PX[spec.radius]}`,
    `Spacing: ${DENSITY_HINT[spec.density]}`,
    `Motion: ${spec.motion === 'none' ? 'no animation' : spec.motion === 'subtle' ? 'subtle, fast transitions only' : 'expressive, tasteful scroll/hover motion'}`,
  ]
  return lines.join('\n')
}

export interface DesignPromptOptions {
  /** Chosen brand preset (its spec is rendered into the prompt). */
  preset?: BrandPreset
  /** Freeform DESIGN.md content that augments/overrides the preset. */
  designMd?: string
  /** True when refining an existing document (the prior HTML is sent separately). */
  iterating?: boolean
  /** Art-direction brief from the planning pass — implemented EXACTLY. */
  brief?: string
}

/**
 * System prompt for the DISCOVERY pass — a senior designer that asks the FEWEST,
 * highest-leverage clarifying questions before designing (the Claude-Design-style
 * interview). Returns STRUCTURED questions (strict JSON) so the UI can render
 * clickable option chips instead of a wall of text; the user's picks are then
 * threaded into the build as binding direction.
 */
export function buildClarifySystemPrompt(mode: 'page' | 'animate' = 'page'): string {
  const focus = mode === 'animate'
    ? `the single message/takeaway; duration & mood; any must-hit beats; brand assets (logo, wordmark, colors) to use`
    : `who it's for + the ONE action you want them to take; the vibe in 2–3 adjectives (or a site/brand to match); must-have sections or content; brand colors / logo / fonts if any`
  return [
    `You are a senior product designer doing a brief discovery BEFORE you design. The user gave a short request. Ask only the questions whose answers would materially change the result — then stop.`,
    ``,
    `Reply with ONLY a JSON object — no prose, no markdown fences:`,
    `{"questions":[{"q":"<one short question>","options":["<answer>","<answer>","<answer>"],"default":"<one of the options>"}]}`,
    ``,
    `Rules:`,
    `- Ask 3–5 questions MAX, each "q" ONE short line, concrete and easy to answer. DO NOT produce any design yet.`,
    `- Give 2–4 "options" per question — short, concrete answers the user can pick with one click, most-likely FIRST. Set "default" to your recommendation. The UI adds a "you decide" choice automatically — never include it as an option.`,
    `- Cover the gaps that matter: ${focus}.`,
    `- If the user ALREADY specified something — or attached a reference image or pasted/loaded project code — do NOT ask about it. Only ask what is genuinely missing. If a strong reference or codebase is provided, ask at most 1–2 questions.`,
  ].join('\n')
}

/** One structured interview question from the discovery pass. */
export interface ClarifyQuestion {
  q: string
  options: string[]
  default?: string
}

/**
 * Parse the clarify reply into structured questions. Tolerant of fences and
 * stray prose around the JSON; returns null when nothing parseable comes back
 * (callers fall back to showing the raw text).
 */
export function parseClarifyReply(raw: string): ClarifyQuestion[] | null {
  if (!raw) return null
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { questions?: unknown }
    if (!Array.isArray(j.questions)) return null
    const out: ClarifyQuestion[] = []
    for (const x of j.questions as Array<Record<string, unknown>>) {
      const q = String(x?.q ?? '').trim()
      if (!q) continue
      const options = Array.isArray(x?.options)
        ? (x.options as unknown[]).map(o => String(o).trim()).filter(Boolean).slice(0, 6)
        : []
      const def = typeof x?.default === 'string' && x.default.trim() ? x.default.trim() : undefined
      out.push({ q, options, default: def })
    }
    return out.length > 0 ? out.slice(0, 6) : null
  } catch {
    return null
  }
}

/** Legacy plain-text rendering of structured questions (message text, history threading). */
export function clarifyQuestionsToText(questions: ClarifyQuestion[]): string {
  return questions
    .map((x, i) => `${i + 1}. ${x.q}${x.options.length ? ` (${x.options.join(' / ')}${x.default ? ` — default: ${x.default}` : ''})` : ''}`)
    .join('\n')
}

/**
 * System prompt for the DIRECTION pass — an art director that commits to a
 * concrete creative direction BEFORE anything is built. This is open-design's
 * planning gate, automated: making real decisions up front is what separates a
 * designed result from generic model output.
 */
export function buildBriefSystemPrompt(mode: 'page' | 'animate' = 'page'): string {
  const beats = mode === 'animate'
    ? `MOTION BEATS: 3–6 timed beats across the timeline (e.g. "0.0–0.6s: wordmark letters spring in, 3-frame stagger; 0.6–1.4s: hold + subtle drift; 1.4–2.0s: accent sweep + settle"). Give an easing per beat and a clear IN → HOLD → OUT arc. Decide duration & fps.`
    : `LAYOUT: the exact sections in order and their visual hierarchy (what dominates), the grid, and the spacing rhythm. Decide what the hero leads with.`
  return [
    `You are an award-winning art director. Given a request, commit to ONE specific, tasteful creative direction the implementer will follow EXACTLY. Make real decisions — not options, not hedging.`,
    ``,
    `Output these sections, terse and concrete (no code, under ~180 words total):`,
    `CONCEPT: one line — the core idea and the feeling.`,
    PALETTE_DIRECTIVE,
    `TYPE: heading + body families (real Google Fonts), the scale, and weights. Pick a pairing with personality.`,
    beats,
    `DETAILS: 2–3 craft touches used tastefully (depth/layering, gradient or grain, glow, motion-blur feel, micro-interactions).`,
    `AVOID: 3 anti-patterns specific to this brief (e.g. "everything fades in at once", "linear easing", "centered with no hierarchy", "generic stock layout").`,
  ].join('\n')
}

/**
 * Build the system prompt. The hard contract: output exactly ONE complete,
 * standalone HTML document in a single ```html fenced block, everything inlined,
 * no build step — so it drops straight into the sandboxed iframe preview.
 */
export function buildDesignSystemPrompt(opts: DesignPromptOptions = {}): string {
  const parts: string[] = [
    `You are an elite product designer and senior frontend engineer. You turn a request into a single, beautiful, production-quality web page.`,
    ``,
    `OUTPUT CONTRACT (strict):`,
    `- Reply with EXACTLY ONE complete, self-contained HTML document and NOTHING else.`,
    `- Wrap it in a single \`\`\`html fenced code block. No prose before or after.`,
    `- Start with <!doctype html>. Inline ALL CSS in one <style> tag in <head>. Inline any JS in a <script> tag.`,
    `- No build step, no bundler, no imports of local files. External resources only from public CDNs (Google Fonts, unpkg, cdn.tailwindcss.com) and they must be optional/progressive.`,
    `- Fully responsive (mobile-first), semantic HTML, accessible (labels, alt text, focus states, sufficient contrast).`,
    `- Use realistic, specific copy and data — never "Lorem ipsum" or "[placeholder]".`,
    `- Prefer real inline SVG for icons/illustration over icon-font CDNs.`,
    `- Progressive enhancement: the page MUST render FULLY VISIBLE without JS. Any scroll/entrance animation is an enhancement only — start content at its final visible state (or reveal via IntersectionObserver), and NEVER leave content stuck at opacity:0 if no observer/scroll handler fires. No hand-rolled scroll-position listeners gating visibility.`,
    ``,
    `DESIGN DISCIPLINE (this is a flagship design tool — aim for award-winning work). Honor all nine:`,
    `- COLOR: one confident, cohesive palette (a real bg/surface/text/muted/accent system). Never default-blue-on-white. Use color with intent.`,
    `- TYPOGRAPHY: a deliberate font pairing with personality (Google Fonts), a real modular type scale, tight display headings, comfortable body line-height.`,
    `- SPACING: a consistent spacing scale and vertical rhythm; generous, balanced whitespace; nothing cramped.`,
    `- LAYOUT: a clear grid and a strong focal hierarchy — the eye should know where to go first. Vary section rhythm (don't stack identical centered blocks).`,
    `- COMPONENTS: cohesive, reusable styling for buttons/cards/inputs; consistent radius, border, shadow language.`,
    `- MOTION: tasteful entrance/scroll/hover motion with real easing (cubic-bezier), never linear; subtle, not flashy.`,
    `- VOICE: specific, confident copy with a point of view — real product names, headlines, and numbers (never "Lorem ipsum").`,
    `- DEPTH & POLISH: layered depth via shadow/gradient/blur/borders; pixel-tight alignment; details that read as crafted.`,
    `- ANTI-PATTERNS to AVOID: generic centered hero + 3 equal feature cards; default system fonts; flat single-weight type; muddy/random colors; everything the same size; emoji as icons; walls of equal text; no hierarchy; AI-tells in copy (em-dashes used as connectors, "in today's fast-paced world", hedging/filler phrases) — write like a sharp human; content hidden behind scroll reveals that may never fire.`,
    `- A COMPLETE page: nav, hero, the requested sections, and a footer — never a bare fragment.`,
  ]

  // The taste layer (distilled design-skills) — always on, so even a preset-less
  // free-wheel generation avoids the AI-slop look (esp. the purple/cyan cliché).
  parts.push('', DESIGN_TASTE)

  // Honor what the user actually gave us — the whole point of the discovery step,
  // attached reference image, and loaded project code.
  parts.push(
    '',
    `CONTEXT IS BINDING: if the conversation includes discovery answers, a reference image, or the project's real code/content, treat them as REQUIREMENTS — match the stated audience, goal, brand name, palette, fonts, tone, and the existing project's visual language. Do not invent a different direction than what was asked for or shown.`,
  )

  if (opts.brief && opts.brief.trim()) {
    parts.push(``, `ART DIRECTION — implement this EXACTLY (it was chosen for this request):`, opts.brief.trim())
  }
  if (opts.preset) {
    parts.push(``, `DESIGN SYSTEM — "${opts.preset.label}":`, renderSpec(opts.preset.spec))
  }
  if (opts.designMd && opts.designMd.trim()) {
    parts.push(``, `ADDITIONAL DESIGN DIRECTION (overrides on conflict):`, opts.designMd.trim())
  }
  if (opts.iterating) {
    // Hard, surgical contract: field evidence (2026-07-22) showed strong models
    // treat a soft "preserve the rest" as license to redesign — a one-line
    // "change the video source" request came back as a different page.
    parts.push(
      ``,
      `You are REFINING an existing page the user already approved — this is a SURGICAL EDIT, not a redesign.`,
      `- Apply ONLY what the request explicitly asks for. Everything it does not name — layout, copy, class names, colors, styles, scripts, structure — must be carried over EXACTLY as-is.`,
      `- Do NOT re-architect, restyle, rewrite text, rename things, or "improve" untouched parts, even where the design contract or context blocks above would suggest ideas for a fresh build.`,
      `- Context blocks (attached assets, brand, files) describe available resources; on a refine turn they are reference material, never an instruction to rebuild.`,
      `- Return the FULL updated document, not a diff. A reviewer diffing your output against the current page should see changes ONLY where the request required them.`,
    )
  }
  return parts.join('\n')
}

/**
 * Extract the standalone HTML document from a model reply. Order of preference:
 *   1. a ```html fenced block,
 *   2. any fenced block that looks like a full doc (<!doctype / <html),
 *   3. a raw <!doctype html> … </html> (or to end) slice,
 *   4. a raw <html> … </html> slice,
 *   5. the trimmed text as-is (last resort).
 * Always returns a trimmed string; guarantees a leading <!doctype html> when the
 * result starts at <html>.
 */
export function extractHtmlDocument(reply: string): string {
  if (!reply) return ''
  const text = reply.replace(/\r\n/g, '\n')

  // 1. ```html fenced block.
  const htmlFence = /```html\s*\n([\s\S]*?)```/i.exec(text)
  if (htmlFence && htmlFence[1].trim()) return normalize(htmlFence[1])

  // 2. any fenced block containing a doc marker.
  const anyFence = /```[a-z]*\s*\n([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = anyFence.exec(text)) !== null) {
    const inner = m[1]
    if (/<!doctype html|<html[\s>]/i.test(inner)) return normalize(inner)
  }

  // 3. raw <!doctype html> … </html> (or to end).
  const doctypeIdx = text.search(/<!doctype html/i)
  if (doctypeIdx >= 0) {
    const end = text.search(/<\/html\s*>/i)
    return normalize(end >= 0 ? text.slice(doctypeIdx, end + text.slice(end).indexOf('>') + 1) : text.slice(doctypeIdx))
  }

  // 4. raw <html> … </html>.
  const htmlIdx = text.search(/<html[\s>]/i)
  if (htmlIdx >= 0) {
    const end = text.search(/<\/html\s*>/i)
    return normalize(end >= 0 ? text.slice(htmlIdx, end + text.slice(end).indexOf('>') + 1) : text.slice(htmlIdx))
  }

  // 5. fallback.
  return text.trim()
}

/** Trim, and guarantee a leading <!doctype html> when the slice begins at <html>. */
function normalize(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^<html[\s>]/i.test(t)) return `<!doctype html>\n${t}`
  return t
}
