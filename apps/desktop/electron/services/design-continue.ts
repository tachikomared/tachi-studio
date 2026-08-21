// apps/desktop/electron/services/design-continue.ts
//
// PURE helpers for the design generation pipeline's self-healing: stitching an
// auto-continued reply after an output-limit cut, validating that an extracted
// animation source is actually playable, and the corrective prompt for the one
// automatic repair round-trip. Framework-free (no electron imports) so they
// unit-test under apps/desktop/test/.

export type AnimationEngine = 'remotion' | 'hyperframes' | undefined

/**
 * Append a continuation to a cut-off reply, de-duplicating the seam: models
 * often re-open the code fence or repeat the last line despite being told not
 * to.
 */
export function stitchContinuation(prev: string, cont: string): string {
  let c = cont
  // Inside an unclosed fence? A re-opened ```tsx/```html at the start is noise.
  if (((prev.match(/```/g) || []).length % 2) === 1) c = c.replace(/^\s*```[a-z]*[^\n]*\n?/i, '')
  const maxOverlap = Math.min(400, prev.length, c.length)
  for (let n = maxOverlap; n >= 20; n--) {
    if (prev.endsWith(c.slice(0, n))) { c = c.slice(n); break }
  }
  return prev + c
}

/** Does the extracted animation source hold a playable composition? */
export function animationValid(code: string | undefined, engine: AnimationEngine): boolean {
  if (!code || !code.trim()) return false
  return engine === 'hyperframes' ? /__timelines/.test(code) : /\bComposition\b/.test(code)
}

/** Corrective nudge when a reply held no complete composition — one automatic retry. */
export function repairPrompt(engine: AnimationEngine): string {
  return engine === 'hyperframes'
    ? 'That reply did not contain a complete HyperFrames composition. Reply again with the FULL HTML document in ONE ```html fence — it MUST register a paused GSAP timeline on `window.__timelines` and keep the `#design` root with `.clip` children. No commentary before or after the fence.'
    : 'That reply did not contain a complete Remotion composition. Reply again with the FULL TSX module in ONE ```tsx fence — it MUST define the root component `const Composition` and `const config = { durationInFrames, fps, width, height }`. No commentary before or after the fence.'
}
