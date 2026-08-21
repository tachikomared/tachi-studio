// packages/core/src/design/hyperframes.ts
//
// HyperFrames engine for the Design tab's animate mode (referencing
// heygen-com/hyperframes). Unlike Remotion (React frame-by-frame), a HyperFrames
// composition is a COMPLETE HTML document whose DOM declares timing via data-*
// attributes and whose motion is ONE paused, seekable GSAP timeline registered
// as window.__timelines["<id>"]. This makes it deterministic + host-renderable.
//
// v1 scope: generate + live-preview only. GSAP is the sole runtime (keeps the
// preview CSP/offline surface to one dependency); MP4 export is a later phase.
//
// Pure + renderer-safe (no I/O) — unit-testable, imported via the
// `@tachi/core/src/design/...` subpath.

import { DESIGN_SCAFFOLD_MARK } from './scaffold.js'

export const HYPERFRAMES_COMPOSITION_ID = 'design'

/**
 * System prompt for HyperFrames mode: emit ONE complete HTML composition.
 * Distilled from the hyperframes-core contract + the prompting guide; the
 * numbered rules are the documented SILENT-FAILURE classes (lint won't catch).
 */
export function buildHyperframesSystemPrompt(opts: { context?: string; brief?: string } = {}): string {
  const id = HYPERFRAMES_COMPOSITION_ID
  const parts = [
    `You are a motion designer who authors HyperFrames (heygen.com/hyperframes) compositions — a single self-contained HTML document animated by ONE seekable GSAP timeline.`,
    ``,
    `OUTPUT CONTRACT (strict):`,
    `- Reply with EXACTLY ONE code block — a single \`\`\`html fenced block — and NOTHING else (no prose).`,
    `- Output a COMPLETE HTML document: <!doctype html><html><head>…</head><body>…</body></html>. Never abbreviate or use "…".`,
    `- GSAP is ALREADY loaded (window.gsap is available). Do NOT add a <script src> for gsap. You MAY add other inline <style>/<script>, but NO external <script src> tags and NO imports.`,
    ``,
    `COMPOSITION CONTRACT (each rule below is a silent-failure if broken):`,
    `1. ROOT: one root element \`<div id="${id}" data-composition-id="${id}" data-width="1280" data-height="720" data-duration="5" style="position:relative;width:1280px;height:720px;overflow:hidden">\`. Real pixel size. Pick your own duration in SECONDS.`,
    `2. CLIPS: every timed/visible child needs class="clip" + a unique id + data-start (seconds) + data-duration (seconds), and MUST be a DIRECT child of the root (a wrapped clip silently un-registers, and a child WITHOUT class="clip" stays visible the whole video).`,
    `3. TIMELINE: exactly ONE \`const tl = gsap.timeline({ paused: true });\` built SYNCHRONOUSLY at load (never inside async/setTimeout/Promise/DOMContentLoaded). Register it EXACTLY as \`window.__timelines = window.__timelines || {}; window.__timelines["${id}"] = tl;\`. NEVER call tl.play() — the host drives playback.`,
    `4. DETERMINISM: forbidden — Date.now(), performance.now(), unseeded Math.random(), fetch, reading live input state, and infinite repeats (repeat:-1). Use finite repeat counts. Same seek → same pixels, always.`,
    `5. ANIMATE ONLY: opacity, x, y, scale, rotation, color, backgroundColor, borderRadius (via gsap.to/from/fromTo on the timeline). NEVER animate layout props (width/height/top/left/display/visibility) — build the static end-state in HTML/CSS, then animate from/to it.`,
    `6. LAYOUT: transformed elements must be display:block and sized. Full-screen fills go on a CHILD, never the root (the frame compositor drops root backgrounds). No <br> inside animated text.`,
    `7. MEDIA: <video>/<audio> must be direct children of the ROOT, muted + playsinline; never call .play()/.pause()/.seek() on them from script (the framework owns media playback). Prefer pure CSS/SVG/typography — a complete composition needs zero external assets.`,
    ``,
    `CRAFT (make it genuinely good, not a template):`,
    `- Stagger entrances (0.06–0.12s offsets), ease everything (power2/power3/back/elastic — never linear), respect the 12 principles (anticipation, follow-through, overlapping action).`,
    `- Strong type hierarchy; generous negative space; a deliberate, cohesive palette. BANNED: the generic "AI purple" gradient (#6366f1→#a855f7) and lazy full-bleed purple. Choose a palette that fits the subject.`,
    `- Time it to breathe: a clear beginning/middle/end across the duration, not everything at once in the first 0.5s.`,
    ``,
    `MINIMAL SHAPE (follow this structure exactly):`,
    '```html',
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0b0b10}</style></head>`,
    `<body>`,
    `  <div id="${id}" data-composition-id="${id}" data-width="1280" data-height="720" data-duration="3" style="position:relative;width:1280px;height:720px;overflow:hidden;background:#0b0b10">`,
    `    <div class="clip" id="title" data-start="0" data-duration="3" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e8e8f0;font:800 96px/1 system-ui">HELLO</div>`,
    `  </div>`,
    `  <script>`,
    `    const tl = gsap.timeline({ paused: true });`,
    `    tl.from("#title", { opacity: 0, y: 40, scale: 0.9, duration: 0.8, ease: "back.out(1.7)" });`,
    `    window.__timelines = window.__timelines || {}; window.__timelines["${id}"] = tl;`,
    `  </script>`,
    `</body></html>`,
    '```',
  ]
  if (opts.brief && opts.brief.trim()) {
    parts.push(``, `ART DIRECTION (honor this brief):`, opts.brief.trim())
  }
  if (opts.context && opts.context.trim()) {
    parts.push(``, `PROJECT CONTEXT (design for this):`, opts.context.trim())
  }
  return parts.join('\n')
}

export interface HyperframesMeta {
  width: number
  height: number
  /** Composition duration in seconds. */
  duration: number
}

/**
 * Read the composition's declared size/duration from the root's data-*
 * attributes (the contract requires data-width/data-height/data-duration).
 * Defensive: missing/garbage attributes fall back to 1280×720 @ 5s, and values
 * are clamped to sane bounds so a hallucinated "duration=99999" can't spin a
 * frame-capture loop for hours.
 */
export function extractHyperframesMeta(composition: string): HyperframesMeta {
  const attr = (name: string): number | null => {
    const m = new RegExp(`${name}\\s*=\\s*"([\\d.]+)"`, 'i').exec(composition)
    if (!m) return null
    const v = Number.parseFloat(m[1])
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return {
    width: clamp(Math.round(attr('data-width') ?? 1280), 16, 3840),
    height: clamp(Math.round(attr('data-height') ?? 720), 16, 2160),
    duration: clamp(attr('data-duration') ?? 5, 0.5, 120),
  }
}

/**
 * Host-side CLIP WINDOWING (contract rule 2): a `.clip` direct child of the
 * root is visible ONLY within [data-start, data-start+data-duration). The
 * composition's own timeline never toggles scenes — the HOST enforces the
 * windows (this was promised by the prompt contract but unimplemented in v1,
 * so stacked opaque scenes left only the LAST one visible for the whole
 * video). Defines an idempotent `window.__hfApplyClips(t)` used by both the
 * preview play-loop and the capture seek loop. Visibility (not display) so
 * layout/transform state is untouched.
 */
export function buildClipWindowScript(id = HYPERFRAMES_COMPOSITION_ID): string {
  return `<script>
window.__hfApplyClips = function (t) {
  var root = document.getElementById(${JSON.stringify(id)}) || document.querySelector('[data-composition-id]');
  if (!root) return;
  var total = parseFloat(root.getAttribute('data-duration')) || 0;
  for (var i = 0; i < root.children.length; i++) {
    var el = root.children[i];
    if (!el.classList || !el.classList.contains('clip')) continue;
    var start = parseFloat(el.getAttribute('data-start')); if (!isFinite(start)) start = 0;
    var dur = parseFloat(el.getAttribute('data-duration'));
    var end = isFinite(dur) ? start + dur : Infinity;
    // A clip that runs to the composition end stays visible AT the end
    // (otherwise the final frame / loop boundary blinks it off).
    if (total && end >= total - 0.001) end = Infinity;
    el.style.visibility = (t >= start && t < end) ? 'visible' : 'hidden';
  }
};
</script>`
}

/**
 * Wrap a composition for FRAME CAPTURE: inject gsap INLINE (the capture window
 * loads from a temp file, so no tachi-preview:// scheme is available) and do
 * NOT add the play/loop bootstrap — the renderer drives the timeline by
 * seeking it frame-by-frame (paused-by-default is exactly what we want).
 * The clip-window applier rides along; the renderer calls it after each seek.
 */
export function buildHyperframesCaptureHtml(composition: string, gsapInlineSource: string): string {
  const tag = `<script>${gsapInlineSource}</script>${buildClipWindowScript()}`
  if (/<\/head>/i.test(composition)) {
    return composition.replace(/<\/head>/i, `${tag}</head>`)
  }
  if (/<body[^>]*>/i.test(composition)) {
    return composition.replace(/<body([^>]*)>/i, `<body$1>${tag}`)
  }
  return tag + composition
}

/** Extract the single ```html composition document from a model reply. */
export function extractHyperframesHtml(text: string): string {
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text)
  // Truncated reply: an unterminated opening fence still holds the document.
  const open = fence ? null : /```(?:html)?\s*\n([\s\S]*)$/i.exec(text)
  const body = fence ? fence[1] : open ? open[1] : text
  const trimmed = body.trim()
  // If the model omitted the doctype/html wrapper, keep what it gave (a bare
  // root+script still previews); callers render it verbatim.
  return trimmed
}

/**
 * Wrap a composition document so the live preview AUTO-PLAYS: HyperFrames
 * compositions are paused-by-default (the host seeks them), but for an in-app
 * preview we want it to loop. Injects gsap (served locally) + a bootstrap that
 * plays window.__timelines[id] once the DOM + timeline are registered.
 *
 * `gsapSrc` is the URL the preview can load gsap from (e.g. a
 * tachi-preview://asset/gsap.min.js route) so preview works offline/local-first.
 */
export function buildHyperframesPreviewHtml(composition: string, gsapSrc: string): string {
  const id = HYPERFRAMES_COMPOSITION_ID
  const bootstrap = `
<script src="${gsapSrc}"></script>
${DESIGN_SCAFFOLD_MARK}
${buildClipWindowScript(id)}
<script>
  // Preview bootstrap: play + loop the registered timeline once it exists,
  // applying the host-side clip windows on every tick.
  (function () {
    function start() {
      var tls = window.__timelines || {};
      var tl = tls[${JSON.stringify(id)}] || tls[Object.keys(tls)[0]];
      if (!tl) { return setTimeout(start, 50); }
      var apply = window.__hfApplyClips || function () {};
      try { tl.eventCallback('onUpdate', function () { apply(tl.time()); }); } catch (e) { /* older gsap */ }
      apply(0);
      try { tl.repeat(-1).repeatDelay(0.6).play(0); } catch (e) { try { tl.play(0); } catch (_) {} }
    }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  })();
</script>`.trim()

  // gsap + bootstrap must load BEFORE the composition's own <script> registers
  // the timeline, but the composition's <script> runs at parse time — so we
  // append the bootstrap at end of <body> (after the composition script has
  // registered window.__timelines), and load gsap in <head> so window.gsap
  // exists when the composition script runs.
  if (/<\/head>/i.test(composition)) {
    composition = composition.replace(/<\/head>/i, `<script src="${gsapSrc}"></script></head>`)
  } else if (/<body[^>]*>/i.test(composition)) {
    composition = composition.replace(/<body([^>]*)>/i, `<body$1><script src="${gsapSrc}"></script>`)
  } else {
    composition = `<script src="${gsapSrc}"></script>` + composition
  }
  // Bootstrap (play/loop) at the very end so the timeline is already registered.
  const onlyBootstrap = bootstrap.replace(`<script src="${gsapSrc}"></script>\n`, '')
  if (/<\/body>/i.test(composition)) {
    return composition.replace(/<\/body>/i, `${onlyBootstrap}</body>`)
  }
  return composition + onlyBootstrap
}
