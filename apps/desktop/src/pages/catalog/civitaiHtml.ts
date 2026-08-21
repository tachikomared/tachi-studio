// apps/desktop/src/pages/catalog/civitaiHtml.ts
//
// THE DESCRIPTION RENDERER — third-party HTML in, a BLOCK TREE out.
//
// `model.description` and `modelVersions[].description` are the only strings in
// this app written by an arbitrary internet stranger AND shaped like markup.
// Live shape, measured 2026-07-31: TipTap output — <p>, <h1 id="heading-133">,
// <a target="_blank" rel="ugc" href>, <span style="color:rgb(…)">, <strong>,
// <s>, <u>, <ul>/<li>, and inline <img> banner ads. Real lengths ran 3.5 KB to
// 10.8 KB across six top models.
//
// ─── WHY A PARSER AND NOT A SANITIZER ────────────────────────────────────────
// There is NO sanitizer in this repo — no dompurify, no sanitize-html, no xss,
// no rehype-raw (checked across apps/desktop, root and packages/*). The chat
// UI's react-markdown@9 is not one either: with no rehype-raw it ESCAPES raw
// HTML, so handing it this string prints `<p>hi</p>` as literal text.
//
// So this file does not "clean" HTML and hand it to dangerouslySetInnerHTML.
// It PARSES the string into the small closed union below, which the panel
// renders as ordinary React children. The safety property is therefore
// STRUCTURAL rather than diligent: `CivitaiBlock` has nowhere to put an
// attribute, a handler or a tag, so there is no code path from a description to
// innerHTML even if the parsing here is wrong. A bug in this file can lose
// prose. It cannot execute anything.
//
// Two consequences worth stating out loud rather than discovering later:
//   • <img> IS DROPPED, content and all. The prod CSP has no https: in img-src
//     and a remote <img> would leak one request per description to a CDN we do
//     not control. Descriptions use images for banners and cross-promo, not for
//     the facts a reader came for — and the panel has a real, gated preview
//     gallery for the model's actual samples.
//   • ANCHORS BECOME TEXT + a validated href, and the panel prints the URL; it
//     does NOT draw a clickable control. Description links point at arbitrary
//     third-party hosts (mage.space, fictional.ai …) which are not in
//     shell.ipc.ts's openExternal allowlist, so a button would reject and
//     silently no-op — a fabricated affordance, the exact thing the catalog's
//     honesty law forbids. A copyable URL is the honest amount of help. It is
//     printed ONCE (civitaiLinkPrintsHref) and broken at url separators
//     (civitaiUrlBreakParts) — an autolinked url is its own anchor text, and
//     printing that string twice back to back was the panel's worst line.

/** One run of text inside a block. A `link` carries a VALIDATED http(s) href. */
export type CivitaiInline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }

/**
 * A description block. Deliberately tiny and closed: five shapes cover every
 * structure measured on live data, and anything unrecognised degrades into
 * `para` rather than inventing a sixth.
 */
export type CivitaiBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; inline: CivitaiInline[] }
  | { kind: 'para'; inline: CivitaiInline[] }
  | { kind: 'list'; ordered: boolean; items: CivitaiInline[][] }
  | { kind: 'quote'; inline: CivitaiInline[] }
  | { kind: 'code'; text: string }

export interface CivitaiDescription {
  blocks: CivitaiBlock[]
  /** The input hit a cap. Said out loud in the panel rather than silently cut. */
  truncated: boolean
}

/**
 * Longest description we will parse. Live maximum measured was 10.8 KB, so 64 KB
 * is ~6× headroom while still refusing a megabyte of adversarial nesting that
 * would block the renderer thread inside the strip loop below.
 */
export const CIVITAI_DESC_MAX_INPUT = 64_000

/** Most blocks we will emit. A description is prose, not a document. */
const MAX_BLOCKS = 400

/**
 * Elements removed WITH THEIR ENTIRE SUBTREE, before anything else runs.
 *
 * The body is the point. A stripper that deletes only `<script>` and
 * `</script>` leaves `alert("pwned")` sitting in a paragraph — it has removed
 * the tags and kept the payload as prose. `<iframe>` fallback text, `<form>`
 * field labels and `<svg><text>` all leak the same way.
 */
const KILL_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset',
  'noscript', 'noframes', 'template', 'svg', 'math', 'canvas', 'audio', 'video',
  'form', 'select', 'textarea', 'button', 'map', 'portal',
] as const

/** Void/self-closing elements that carry no prose and must simply vanish. */
const DROP_VOID = /<\/?(?:img|link|meta|base|input|source|track|param|area|col|wbr)\b[^>]*>/gi

const KILL_PAIRED = new RegExp(
  `<(${KILL_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>`,
  'gi',
)
/** An UNCLOSED killer tag swallows the rest of the string — never the reverse. */
const KILL_DANGLING = new RegExp(`<(${KILL_TAGS.join('|')})\\b[\\s\\S]*$`, 'i')
/** A bare closing tag left behind by a mismatched pair. */
const KILL_ORPHAN_CLOSE = new RegExp(`<\\/\\s*(${KILL_TAGS.join('|')})\\s*>`, 'gi')

/**
 * Delete every dangerous subtree, LOOPING until the string stops changing.
 *
 * One pass is not enough and the reason is the classic regex defeat:
 * `<scr<script>ipt>alert(1)</script>` — removing the inner `<script>` re-forms
 * an outer one out of the surviving halves. Iterating to a fixed point is the
 * only honest answer; the loop is bounded so a crafted string cannot spin.
 */
function killDangerousSubtrees(input: string): string {
  let out = input
  for (let pass = 0; pass < 12; pass++) {
    const before = out
    out = out.replace(KILL_PAIRED, ' ')
    out = out.replace(KILL_DANGLING, ' ')
    out = out.replace(KILL_ORPHAN_CLOSE, ' ')
    out = out.replace(DROP_VOID, ' ')
    if (out === before) break
  }
  return out
}

// ─── entities ────────────────────────────────────────────────────────────────
//
// Decoded LAST IN THE TEXT PATH, after every tag is gone. Order matters for one
// reason and it is not the usual one: decoding first would turn an author's
// escaped `&lt;script&gt;` into a real tag for the stripper to eat, silently
// losing text they meant to show. Decoding last keeps it as the literal
// characters they typed — and those characters are a React text node, so they
// stay inert.
//
// AN HREF IS THE ONE EXCEPTION, and it is decoded FIRST — see civitaiSafeHref.
// The asymmetry is not an inconsistency: prose is decoded late so a stripper
// cannot eat it, while an href is decoded early so the VALIDATOR sees the same
// string the reader will. Both orders put the decode on the safe side of the
// only thing that inspects the value.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«',
  raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘',
  rsquo: '’', bull: '•', middot: '·', deg: '°',
  copy: '©', reg: '®', trade: '™', times: '×',
  divide: '÷', plusmn: '±', frac12: '½', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', dagger: '†', prime: '′', infin: '∞',
  ne: '≠', le: '≤', ge: '≥', larr: '←', rarr: '→',
  // `&star;` is the WHITE star (U+2606), not the black one — a wrong glyph is a
  // small lie and this table is only worth having if every row is right. An
  // entity that is NOT in this table is left VERBATIM by decodeEntities, which
  // is the honest fallback: the reader sees `&hearts;` rather than a guess.
  harr: '↔', check: '✓', cross: '✗', star: '☆',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
      // Lone surrogates would corrupt the string; C0 controls are invisible junk.
      if (code >= 0xd800 && code <= 0xdfff) return ''
      if (code < 0x20 && code !== 0x09 && code !== 0x0a) return ''
      try { return String.fromCodePoint(code) } catch { return '' }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

// ─── hrefs ───────────────────────────────────────────────────────────────────

/**
 * Drop every C0/C1 control character and space.
 *
 * A CODE-POINT PREDICATE, not a regex character class, and deliberately so: a
 * class over literal control bytes is invisible in review and one editor save
 * away from being silently wrong, while an escaped class (` - `) reads
 * as noise in the one function whose correctness is a security property. This
 * says what it means.
 *
 * Space is included because a URL cannot contain a raw one — so a leading
 * `" javascript:…"` cannot hide a scheme behind whitespace either.
 */
function stripControls(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20) continue                      // C0 controls + space
    if (code >= 0x7f && code <= 0x9f) continue      // DEL + C1 controls
    out += ch
  }
  return out
}

/**
 * The href we are willing to SHOW. http(s) only.
 *
 * `javascript:` / `data:` / `vbscript:` / `file:` / `about:` all fail, and so
 * does a scheme hidden behind a leading control character (`javascript:`)
 * — the URL constructor is the arbiter, not a regex over the raw string, and it
 * is given a TRIMMED value so leading whitespace cannot smuggle one either.
 *
 * Returns null when the anchor should degrade to plain text. Nothing here
 * whitelists a HOST: this href is only ever displayed, never opened (see the
 * file header — an anchor is text, not a button).
 */
export function civitaiSafeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Strip C0/C1 controls and whitespace before parsing: `javascript:x`
  // parses as a relative URL in some engines and as the javascript scheme in
  // others, and "it depends" is not a security property.
  // ─── DECODE FIRST, THEN VALIDATE. NEVER THE OTHER WAY ROUND ─────────────────
  // An href arrives HTML-ESCAPED, and `new URL()` does not decode entities — so
  // validating first and decoding later (or never) returns a string that is not
  // the url. MEASURED live 2026-08-01, GET
  // https://civitai.com/api/v1/models/257749 (Pony Diffusion V6 XL) — the only
  // `&`-carrying href in that description:
  //   href="https://purplesmart.ai/collection/top?nsfw=0&amp;page=1&amp;model=11&amp;order=created_desc"
  // Without this the panel printed, and a reader copied, `&amp;` as all three
  // query separators. A driver hit it three times on that one model.
  //
  // Decoding BEFORE the protocol test is the SAFE order, not just the convenient
  // one: `&#106;avascript:alert(1)` becomes `javascript:alert(1)` while the URL
  // constructor can still see it, so a decode cannot smuggle a scheme past the
  // http(s) check the way "validate, then decode" would. ONE decode, never a
  // loop — a double-escaped `&amp;#106;avascript:` decodes to the literal text
  // `&#106;avascript:`, which is then rejected as not a url at all.
  //
  // Controls are stripped AFTER the decode, because `&#9;` is a tab the decode
  // itself produces and it must not survive into the parse.
  const cleaned = stripControls(decodeEntities(raw)).trim()
  if (!cleaned) return null
  let u: URL
  try { u = new URL(cleaned) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  return cleaned
}

// ─── the parse ───────────────────────────────────────────────────────────────

const HEADING = /^h([1-6])$/
const BLOCK_BREAK = new Set([
  'p', 'div', 'br', 'hr', 'section', 'article', 'header', 'footer', 'aside',
  'main', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'dl', 'dt', 'dd', 'address', 'details', 'summary',
])

interface Builder {
  blocks: CivitaiBlock[]
  inline: CivitaiInline[]
  /** Pending block kind for the run being accumulated. */
  mode: 'para' | 'quote' | { heading: 1 | 2 | 3 }
  /** Non-null while inside <ul>/<ol>. */
  list: { ordered: boolean; items: CivitaiInline[][] } | null
  truncated: boolean
}

/** Collapse whitespace the way a browser would, without touching content. */
const collapse = (s: string): string => s.replace(/[\s ]+/g, ' ')

/**
 * Append a plain run, merging into the previous text node when there is one.
 *
 * The merge collapses ACROSS the seam, because `collapse` only ever sees one
 * chunk: `a <span> b</span>` arrives as `'a '` then `' b'` and would otherwise
 * concatenate to `a  b`. One space in, one space out, wherever the tags fell.
 */
function pushPlain(b: Builder, text: string): void {
  const last = b.inline[b.inline.length - 1]
  if (last && last.kind === 'text') {
    last.text += last.text.endsWith(' ') && text.startsWith(' ') ? text.slice(1) : text
    return
  }
  b.inline.push({ kind: 'text', text })
}

function pushText(b: Builder, raw: string, href: string | null): void {
  const text = collapse(decodeEntities(raw))
  if (text === '') return
  if (href) {
    // A LINK'S EDGE WHITESPACE SURVIVES AS TEXT.
    //
    // The link's own text must be trimmed — a label with a trailing space reads
    // as a wider link and prints oddly next to its url. But DELETING that space
    // glues words together, and authors really do put it inside the anchor.
    // MEASURED live 2026-08-01, model 257749:
    //   `…get access to free SD bot </a>and <a…>check out more examples…`
    // which used to render as `free SD botand`. Keeping the edge as an ordinary
    // text node is also exactly what a browser does with the same markup.
    //
    // A whitespace-ONLY anchor keeps its space for the same reason and gains
    // nothing else: that is the shape `<a href><img></a>` collapses to once the
    // banner image is dropped, and the space still separates its neighbours.
    const trimmed = text.trim()
    if (trimmed === '') { pushPlain(b, text); return }
    const lead = text.slice(0, text.length - text.trimStart().length)
    const tail = text.slice(text.trimEnd().length)
    if (lead !== '') pushPlain(b, lead)
    b.inline.push({ kind: 'link', text: trimmed, href })
    if (tail !== '') pushPlain(b, tail)
    return
  }
  pushPlain(b, text)
}

/**
 * Trim the edges of an inline run and drop it if nothing meaningful is left.
 *
 * A run of pure whitespace is NOT a paragraph — `<p> </p>` and
 * `<p><span> </span></p>` are both real in TipTap output and both render as an
 * empty box if kept. A run holding only a LINK survives even with no text
 * around it, because the link is the content.
 */
function finishInline(inline: CivitaiInline[]): CivitaiInline[] {
  const out = inline.map(i => ({ ...i }))
  const first = out[0]
  if (first && first.kind === 'text') first.text = first.text.replace(/^\s+/, '')
  const last = out[out.length - 1]
  if (last && last.kind === 'text') last.text = last.text.replace(/\s+$/, '')
  const kept = out.filter(i => i.text !== '')
  const meaningful = kept.some(i => i.kind === 'link' || i.text.trim() !== '')
  return meaningful ? kept : []
}

function flush(b: Builder): void {
  const inline = finishInline(b.inline)
  b.inline = []
  if (inline.length === 0) return
  if (b.blocks.length >= MAX_BLOCKS) { b.truncated = true; return }
  if (b.list) { b.list.items.push(inline); return }
  if (b.mode === 'para') b.blocks.push({ kind: 'para', inline })
  else if (b.mode === 'quote') b.blocks.push({ kind: 'quote', inline })
  else b.blocks.push({ kind: 'heading', level: b.mode.heading, inline })
  b.mode = 'para'
}

function closeList(b: Builder): void {
  flush(b)
  const list = b.list
  b.list = null
  if (!list || list.items.length === 0) return
  if (b.blocks.length >= MAX_BLOCKS) { b.truncated = true; return }
  b.blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
}

/**
 * Parse a Civitai description into blocks.
 *
 * Never throws and never returns HTML. An input that is not a non-empty string,
 * or that holds nothing but markup, yields `{ blocks: [], truncated: false }` —
 * which the panel renders as an honest "no description", not as an empty box.
 */
export function civitaiDescriptionBlocks(raw: unknown): CivitaiDescription {
  if (typeof raw !== 'string') return { blocks: [], truncated: false }
  const capped = raw.length > CIVITAI_DESC_MAX_INPUT
  const source = capped ? raw.slice(0, CIVITAI_DESC_MAX_INPUT) : raw
  if (source.trim() === '') return { blocks: [], truncated: false }

  const html = killDangerousSubtrees(source)

  const b: Builder = { blocks: [], inline: [], mode: 'para', list: null, truncated: capped }
  let linkHref: string | null = null
  let linkDepth = 0
  /** Inside <pre>: raw text, newlines kept, no inline parsing. */
  let preBuf: string | null = null

  // ONE tokenizer pass. `<` that is not a tag start is text (an author writing
  // "a < b"), which is why the text branch consumes up to the next `<` and the
  // tag branch requires a name character right after it.
  const TOKEN = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g
  let cursor = 0
  let m: RegExpExecArray | null

  const takeText = (chunk: string): void => {
    if (chunk === '') return
    if (preBuf !== null) { preBuf += decodeEntities(chunk); return }
    pushText(b, chunk, linkDepth > 0 ? linkHref : null)
  }

  while ((m = TOKEN.exec(html)) !== null) {
    takeText(html.slice(cursor, m.index))
    cursor = m.index + m[0].length

    const tagName = m[1]
    if (tagName === undefined) continue           // comment / doctype / CDATA
    const tag = tagName.toLowerCase()
    const closing = m[0].startsWith('</')

    if (tag === 'pre') {
      if (closing) {
        const text = (preBuf ?? '').replace(/^\n+|\s+$/g, '')
        preBuf = null
        if (text !== '' && b.blocks.length < MAX_BLOCKS) b.blocks.push({ kind: 'code', text })
        else if (text !== '') b.truncated = true
      } else {
        // Close any open list FIRST. A code block is pushed straight onto
        // `blocks` while a list is still accumulating, so without this a `<pre>`
        // inside an `<li>` would render BEFORE the list that contains it — the
        // one place this parser could reorder a document rather than simplify it.
        closeList(b)
        flush(b)
        preBuf = ''
      }
      continue
    }
    if (preBuf !== null) continue                 // tags inside <pre> are literal noise

    if (tag === 'a') {
      if (closing) {
        if (linkDepth > 0) linkDepth--
        if (linkDepth === 0) linkHref = null
      } else {
        // Attribute soup: pull href out and throw the rest (target, rel, style,
        // class, on*) away. There is no model for an attribute, so nothing else
        // can survive even by accident.
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[0])
        linkHref = civitaiSafeHref(href?.[1] ?? href?.[2] ?? href?.[3] ?? null)
        linkDepth++
      }
      continue
    }

    if (tag === 'ul' || tag === 'ol') {
      if (closing) closeList(b)
      else { closeList(b); b.list = { ordered: tag === 'ol', items: [] } }
      continue
    }
    if (tag === 'li') { flush(b); continue }

    const heading = HEADING.exec(tag)
    if (heading) {
      closeList(b)
      flush(b)
      // h4-h6 fold onto 3: a description is a card body, not a document, and
      // six type scales in a 420px panel is noise.
      if (!closing) b.mode = { heading: Math.min(3, Number(heading[1])) as 1 | 2 | 3 }
      continue
    }
    if (tag === 'blockquote') {
      closeList(b)
      flush(b)
      if (!closing) b.mode = 'quote'
      continue
    }
    if (BLOCK_BREAK.has(tag)) {
      // A block boundary INSIDE a list item ends the item, not the list.
      flush(b)
      continue
    }
    // Everything else (span, strong, em, u, s, code, small, sup, mark, …) is
    // transparent: the words flow into the current run.
  }
  takeText(html.slice(cursor))

  closeList(b)
  flush(b)
  if (b.blocks.length >= MAX_BLOCKS) b.truncated = true
  return { blocks: markdownShapes(b.blocks), truncated: b.truncated }
}

// ─── markdown markers INSIDE the html (measured — and why this is a post-pass) ─
//
// Civitai's editor is TipTap, so a description is HTML. But an author who PASTES
// markdown into it gets their markers stored as literal TEXT inside real <p>
// elements, and the parse above then prints `## Model links` and a bare ``` fence
// as characters. A driver hit exactly that on the installed build.
//
// MEASURED live 2026-08-01 — GET /api/v1/models?limit=100&nsfw=false over three
// sorts (Most Downloaded, Newest, Highest Rated): 300 models, 8 744 blocks.
//     300/300 descriptions are HTML (<p>/<h*>/<ul>/<br>)
//       0/300 are a plain-text markdown document
//     136 blocks / 17 models  start with a `- ` bullet
//      62 blocks /  8 models  start with `1. ` or `1) `
//       8 blocks /  2 models  start with an ATX `#`…`######` heading
//       2 blocks /  1 model   are a bare ``` fence   (model 2823699)
//       0 blocks              carry `**bold**`
//       3 blocks /  2 models  matched *em* / _em_ — ALL THREE FALSE POSITIVES:
//                             a `~*~*~*~*~` divider, and the username in
//                             `https://civitai.com/user/_Wizz_` (twice)
// Specimen, verbatim from model 2823917: `…</p><p>## 使用方法</p><p>- Trigger word:
// <code>eri (blue archive)</code></p>…`
//
// So "detect a markdown-shaped description and print it preformatted" is not an
// option that exists: there is no such description, the markers live INSIDE the
// HTML. Hence a POST-PASS over the parsed blocks — no HTML round-trip, no new
// block shape, no dependency, and it can only ever shrink the block array so
// every bound above still holds.
//
// THE LINE IS BLOCK MARKERS IN, INLINE MARKERS OUT — a class boundary, not a
// half-render, and it is drawn where the block union can actually honour it.
//
// Every BLOCK marker maps onto a shape that already exists, and each is handled
// IN FULL: every heading depth, all three bullet characters, both numbered forms,
// the fence. Nothing is half-recognised.
//
// Every INLINE marker (`**bold**`, `*em*`, `_em_`, `` `code` ``, `[text](url)`)
// is left VERBATIM, because `CivitaiInline` has no bold, no code span and no
// clickable link and never will — the HTML path already flattens <strong> and
// <code> to plain text, and an anchor is deliberately text plus its url. So
// "rendering" `**x**` here could only mean DELETING the asterisks, and live data
// says that is pure damage: zero real `**bold**` hits in 8 744 blocks, and all
// three `*em*`/`_em_` candidates were content — an ASCII divider and a username.
// A marker that never appears needs no rendering; a marker whose every live
// occurrence is someone's prose must not be eaten. `[text](url)` stays whole for
// the same reason and reads correctly once the url beside it is printed only
// once (civitaiLinkPrintsHref): `- [Archetype gallery](https://…/)`.

/** `## Heading` — any depth, folded onto the same 3 levels <h1>–<h6> get. */
const MD_HEADING = /^(#{1,6})[ \t]+(\S.*)$/
/** `- item` / `* item` / `+ item` — all three bullet characters. */
const MD_BULLET = /^[-*+][ \t]+(\S.*)$/
/** `1. item` and `1) item`. */
const MD_NUMBER = /^\d{1,3}[.)][ \t]+(\S.*)$/
/**
 * A paragraph that is NOTHING BUT a fence, optionally with a language tag.
 *
 * Backticks only. `~~~` is deliberately absent: a row of tildes is a real
 * decorative divider in these descriptions (the `~*~*~*~*~` block in the
 * measurement above is one), and reading one as a code fence would swallow the
 * rest of a model's prose into a code box.
 */
const MD_FENCE = /^`{3,}[A-Za-z0-9+#._-]*$/

/** The leading TEXT of a run, or '' when it opens with a link. */
function leadText(inline: readonly CivitaiInline[]): string {
  const first = inline[0]
  return first && first.kind === 'text' ? first.text : ''
}

/**
 * The same run with its first text node replaced by `text` — how a marker is
 * removed WITHOUT losing the inlines behind it. A bullet whose content is a link
 * (`- [gallery](https://…)`, measured on model 2823699) keeps the link.
 */
function replaceLead(inline: readonly CivitaiInline[], text: string): CivitaiInline[] {
  const out: CivitaiInline[] = inline.map(i => ({ ...i }))
  const first = out[0]
  if (first && first.kind === 'text') {
    if (text === '') out.shift()
    else first.text = text
  }
  return out
}

/** One block as a line of code-block text. */
function blockLine(block: CivitaiBlock): string {
  switch (block.kind) {
    case 'code': return block.text
    case 'list': return block.items.map(civitaiInlineText).join('\n')
    default: return civitaiInlineText(block.inline)
  }
}

/** Index of the paragraph that CLOSES a fence opened at `from - 1`, or -1. */
function fenceClose(blocks: readonly CivitaiBlock[], from: number): number {
  for (let i = from; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.kind !== 'para') continue
    if (block.inline.length === 1 && MD_FENCE.test(leadText(block.inline))) return i
  }
  return -1
}

/**
 * Re-shape paragraphs whose TEXT is markdown into the blocks they mean.
 *
 * Only `para` blocks are candidates — a heading, list, quote or code block
 * already has its shape and is passed through untouched.
 */
function markdownShapes(blocks: readonly CivitaiBlock[]): CivitaiBlock[] {
  const out: CivitaiBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.kind !== 'para') { out.push(block); continue }
    const lead = leadText(block.inline)

    // A FENCE, and only when it CLOSES. An unclosed fence is a divider, not a
    // code block, and treating it as one would eat the rest of the description.
    // Fenced content is literal, so this runs before the marker rules below and
    // consumes the whole run — a `- ` line inside a fence stays a `- ` line.
    if (block.inline.length === 1 && MD_FENCE.test(lead)) {
      const close = fenceClose(blocks, i + 1)
      if (close !== -1) {
        const text = blocks.slice(i + 1, close).map(blockLine).join('\n').replace(/^\n+|\s+$/g, '')
        if (text !== '') out.push({ kind: 'code', text })
        i = close
        continue
      }
    }

    const heading = MD_HEADING.exec(lead)
    if (heading) {
      out.push({
        kind: 'heading',
        level: Math.min(3, heading[1]!.length) as 1 | 2 | 3,
        inline: replaceLead(block.inline, heading[2]!),
      })
      continue
    }

    // A RUN of marker paragraphs is ONE list. The run stays in one class:
    // bullets do not absorb a numbered line and vice versa, because the two
    // render differently and merging them would invent an ordering.
    const bulleted = MD_BULLET.exec(lead) !== null
    const numbered = !bulleted && MD_NUMBER.exec(lead) !== null
    if (bulleted || numbered) {
      const marker = numbered ? MD_NUMBER : MD_BULLET
      const items: CivitaiInline[][] = []
      let j = i
      for (; j < blocks.length; j++) {
        const next = blocks[j]!
        if (next.kind !== 'para') break
        const m = marker.exec(leadText(next.inline))
        if (!m) break
        items.push(replaceLead(next.inline, m[1]!))
      }
      out.push({ kind: 'list', ordered: numbered, items })
      i = j - 1
      continue
    }

    out.push(block)
  }
  return out
}

/** Flatten one inline run to a string. Link text only — the URL is not prose. */
export function civitaiInlineText(inline: readonly CivitaiInline[]): string {
  return inline.map(i => i.text).join('')
}

// ─── how a link is PRINTED (the panel draws text, never a control) ────────────

/**
 * Does the href still need printing next to the link text?
 *
 * FALSE when the anchor's text already IS its url, which is the common case, not
 * an edge one: TipTap autolinks a pasted url, so the fixtures are full of
 * `<a href="https://huggingface.co/…">https://huggingface.co/…</a>`. The panel
 * prints text + url (an anchor is not a clickable control here — see the file
 * header), so those rendered as the same 60-character string twice, back to
 * back, wrapping mid-token. The driver called it the ugliest line in any panel it
 * opened. Once is the whole content.
 *
 * ONE trailing slash is ignored on each side, because `https://x.example` and
 * `https://x.example/` are the same page and printing both would be the same
 * duplicate with an extra character. Nothing else is normalised: a SHORTENED text
 * (`purplesmart.ai/collection` for a full url) is real information and still
 * earns its url next to it.
 */
export function civitaiLinkPrintsHref(link: { text: string; href: string }): boolean {
  const bare = (s: string): string => s.trim().replace(/\/+$/, '')
  return bare(link.text) !== bare(link.href)
}

/**
 * A url split at its SANE BREAK POINTS, for rendering with `<wbr>` between the
 * parts.
 *
 * The panel used `word-break: break-all`, which breaks mid-token — `https://exam`
 * / `ple.com/very-long-pa` — so a wrapped url reads as garbage. Splitting AFTER
 * each url separator gives the browser real break opportunities instead
 * (<https://developer.mozilla.org/en-US/docs/Web/HTML/Element/wbr>), and the
 * joined parts are the url unchanged — `<wbr>` adds nothing to `textContent`, so
 * what a reader copies is still a working url (unlike a soft hyphen).
 *
 * A separator ENDS its part, because `…/models/` then `260267` is how a person
 * reads a url; a break before the slash orphans it.
 */
export function civitaiUrlBreakParts(url: string): string[] {
  if (typeof url !== 'string' || url === '') return []
  // Split after any of / ? & = # . _ + , - : ; @ ~ %, keeping runs together so
  // `https://` yields one part rather than three.
  const parts = url.match(/[^/?&=#._+,\-:;@~%]*[/?&=#._+,\-:;@~%]*/g) ?? []
  return parts.filter(p => p !== '')
}

/**
 * The whole description as one line, for a collapsed preview / a title
 * attribute. Blocks are joined with a single space because a tooltip has no
 * paragraphs.
 */
export function civitaiDescriptionPlainText(raw: unknown): string {
  const { blocks } = civitaiDescriptionBlocks(raw)
  return blocks
    .map(block => {
      switch (block.kind) {
        case 'code': return block.text.replace(/\s+/g, ' ')
        case 'list': return block.items.map(civitaiInlineText).join(' ')
        default: return civitaiInlineText(block.inline)
      }
    })
    .map(s => s.trim())
    .filter(s => s !== '')
    .join(' ')
}
