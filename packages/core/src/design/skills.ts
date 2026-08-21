// packages/core/src/design/skills.ts
//
// Design-taste rules wired into EVERY generation (page + animation + the
// art-direction pass), so output stops looking AI-generated even when no brand
// preset is picked. This is the "design skills" layer — distilled, attributed
// guidance (not copied assets) from the skills evaluated for this app:
//   • tasteskill.dev                      — taste, made legible (the anti-cheap-look rules)
//   • nextlevelbuilder/ui-ux-pro-max-skill — palette/type pairing + AI-look anti-patterns
//   • owl-listener/designer-skills         — UI/UX critique discipline
// The single biggest lever is the BANNED-LOOK list: the "AI-purple/indigo →
// cyan/teal mesh gradient on near-black" template is the #1 tell of generated
// design, so it (and the other tells) are hard-forbidden here.

/**
 * High-signal anti-AI-slop rules. Injected verbatim so the model has concrete,
 * checkable constraints — not vague "make it nice". Kept tight on purpose
 * (tasteskill's own thesis: a few real rules beat 161 diluting ones).
 */
export const DESIGN_TASTE = [
  `DESIGN TASTE — non-negotiable (this is what separates designed work from generic AI output):`,
  ``,
  `BANNED — these read as cheap / AI-generated, never ship them:`,
  `- The AI-default palette: purple/indigo/violet + cyan/teal/pink gradients, mesh/blob gradients, or a glowing-purple-on-near-black SaaS template. If your first instinct is #7c3aed/#6366f1 + a cyan gradient, STOP and pick something else.`,
  `- Fake product UI: styled <div>s pretending to be a terminal, code editor, dashboard, or app window. Show the real thing or nothing.`,
  `- Decorative eyebrows / version tags as ornament: "V1.4 · REEL", "00 / INDEX", "001 · Capabilities", "BRAND. MOTION. SPATIAL." mono-caps strips, and version footers ("v1.4.2") on a marketing page.`,
  `- Three equal feature cards in a centered row; a generic centered hero where everything fades in at once.`,
  `- Emoji used as icons (use real inline SVG, Lucide/Heroicons style); stock-photo credit captions as decoration; "scroll ↓" cues.`,
  `- border-top + border-bottom on every table row (use cards / tabs instead); hand-rolled scroll-position listeners gating visibility.`,
  ``,
  `DO — commit to real decisions:`,
  `- ONE accent color across the whole page (consistency lock) — a warm-grey site does not get a blue CTA in section 7. Choose a DISTINCTIVE, brand-appropriate accent with a point of view (editorial red, acid lime, warm amber, deep teal, signal orange, electric blue, oxblood, etc.) — fit it to the product's domain, not the default tech-purple.`,
  `- Off-black and off-white, never pure #000 / #fff. WCAG AA contrast (>=4.5:1) and hierarchy parity in both themes.`,
  `- ONE corner-radius system per page: all-sharp, all-soft, or all-pill — don't mix.`,
  `- Hero restraint: headline <= 2 lines, sub-text <= ~20 words (4 lines max). Section eyebrows name the topic in plain language ("Pricing", not "002 · MONETIZATION").`,
  `- A deliberate type pairing with personality and a real modular scale; tight display headings, comfortable body line-height.`,
  `- Asymmetric / zig-zag / bento layouts with a strong focal hierarchy and varied section rhythm — never a stack of identical centered blocks.`,
  `- Motion is restrained: CSS scroll-driven or 150–300ms transitions with real easing (cubic-bezier, never linear); respect prefers-reduced-motion; hover + visible focus states on every interactive element; cursor:pointer on clickables.`,
  `- Layered, crafted depth (soft shadow / gradient / hairline borders / blur used with intent) — and pixel-tight alignment.`,
].join('\n')

/**
 * A short, sharper directive for the art-direction pass: force a concrete,
 * distinctive palette decision up front and explicitly rule out the AI cliché.
 */
export const PALETTE_DIRECTIVE =
  `PALETTE: commit to ONE confident, distinctive scheme fit to THIS product — a single accent with personality. ` +
  `Do NOT use the AI-default purple/indigo + cyan/teal gradient on dark; that is an automatic fail. ` +
  `Off-black/off-white bases (never pure values). Name 4–5 exact hex with roles (bg, surface, text, accent, on-accent).`
