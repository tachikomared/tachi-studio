// apps/desktop/test/unit/civitaiDescriptionHtml.test.ts
//
// THE SANITIZER. Civitai's `description` is THIRD-PARTY HTML written by whoever
// uploaded the model — the single most hostile string this app renders. There is
// no sanitizer dependency in the repo (checked: no dompurify / sanitize-html /
// xss / rehype-raw anywhere), and react-markdown v9 — which the chat UI uses —
// ESCAPES raw HTML rather than rendering it, so feeding it this string would
// print `<p>hello</p>` as literal text.
//
// So the description is PARSED INTO A BLOCK TREE and rendered as React children.
// That is the whole security argument and it is structural, not diligent: the
// output type contains no HTML, so there is no code path from a description to
// innerHTML even if this parser has a bug. These tests pin the parser anyway,
// because "the tags were removed" and "the tags were neutralised" are different
// claims and only the first one keeps a <script>'s BODY off the screen.
//
// Fixtures below are shapes measured on the live API 2026-07-31 (see
// civitaiDetailMapping.test.ts for the by-id probe): real descriptions are
// TipTap output — <p>, <h1 id>, <a target rel href>, <span style>, <strong>,
// <s>, <u>, <ul>/<li>, and inline <img> banners.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  civitaiDescriptionBlocks,
  civitaiInlineText,
  civitaiDescriptionPlainText,
  civitaiLinkPrintsHref,
  civitaiUrlBreakParts,
  civitaiSafeHref,
  CIVITAI_DESC_MAX_INPUT,
  type CivitaiBlock,
  type CivitaiInline,
} from '../../src/pages/catalog/civitaiHtml'

/** Every string anywhere in the parsed tree — what a reader could actually see. */
function allText(blocks: CivitaiBlock[]): string {
  return blocks.map(b => {
    switch (b.kind) {
      case 'code': return b.text
      case 'list': return b.items.map(civitaiInlineText).join('\n')
      default: return civitaiInlineText(b.inline)
    }
  }).join('\n')
}

const parse = (html: string): CivitaiBlock[] => civitaiDescriptionBlocks(html).blocks

/** Every link node anywhere in the tree. */
function allLinks(blocks: CivitaiBlock[]): Extract<CivitaiInline, { kind: 'link' }>[] {
  const runs = blocks.flatMap(b => {
    switch (b.kind) {
      case 'list': return b.items.flat()
      case 'code': return []
      default: return [...b.inline]
    }
  })
  return runs.filter((i): i is Extract<CivitaiInline, { kind: 'link' }> => i.kind === 'link')
}

describe('civitaiDescriptionBlocks — hostile input', () => {
  it('strips a <script> element AND its body', () => {
    const { blocks } = civitaiDescriptionBlocks(
      '<p>Real prose.</p><script>alert("pwned");window.x=1</script><p>More prose.</p>',
    )
    const text = allText(blocks)
    expect(text).toContain('Real prose.')
    expect(text).toContain('More prose.')
    // The BODY is the point. A tag-stripper that only removes `<script>` and
    // `</script>` leaves `alert("pwned")` sitting in a paragraph.
    expect(text).not.toContain('alert')
    expect(text).not.toContain('pwned')
    expect(text).not.toContain('window.x')
  })

  it('strips <style> and its body', () => {
    const text = allText(parse('<style>body{display:none}</style><p>Visible.</p>'))
    expect(text).toContain('Visible.')
    expect(text).not.toContain('display:none')
  })

  it('strips <iframe> entirely, including its fallback text', () => {
    const text = allText(parse('<p>Before.</p><iframe src="https://evil.example/x">fallback</iframe><p>After.</p>'))
    expect(text).toContain('Before.')
    expect(text).toContain('After.')
    expect(text).not.toContain('evil.example')
    expect(text).not.toContain('fallback')
  })

  it('strips <object>, <embed>, <svg> and <form> subtrees', () => {
    for (const html of [
      '<object data="x.swf">objtext</object>',
      '<embed src="x.swf">',
      '<svg onload="alert(1)"><text>svgtext</text></svg>',
      '<form action="https://evil.example"><input name="pw"><button>Send</button></form>',
    ]) {
      const text = allText(parse(`<p>Keep.</p>${html}`))
      expect(text).toContain('Keep.')
      for (const leak of ['objtext', 'x.swf', 'alert(1)', 'svgtext', 'evil.example', 'Send']) {
        expect(text).not.toContain(leak)
      }
    }
  })

  it('survives a nested/obfuscated script open tag', () => {
    // The classic single-pass-regex defeat: removing the inner <script> tag
    // re-forms an outer one. The parser loops until the string stops changing.
    const text = allText(parse('<p>ok</p><scr<script>ipt>alert(1)</script>'))
    expect(text).toContain('ok')
    expect(text).not.toContain('alert(1)')
    expect(text.toLowerCase()).not.toContain('<script')
  })

  it('drops an unclosed <script> and everything after it', () => {
    const text = allText(parse('<p>kept</p><script>while(1){}'))
    expect(text).toContain('kept')
    expect(text).not.toContain('while(1)')
  })

  it('drops EVERY attribute, so no on* handler can survive', () => {
    const html = '<p onclick="steal()" onmouseover="x()" style="color:red" id="a" class="b">Text</p>'
    const { blocks } = civitaiDescriptionBlocks(html)
    const serialized = JSON.stringify(blocks)
    expect(allText(blocks)).toBe('Text')
    // Attributes are not modelled at all — there is nowhere for one to live.
    expect(serialized).not.toContain('onclick')
    expect(serialized).not.toContain('steal')
    expect(serialized).not.toContain('color:red')
  })

  it('degrades a javascript: anchor to plain text — no href survives', () => {
    const { blocks } = civitaiDescriptionBlocks('<p><a href="javascript:alert(1)">Click me</a></p>')
    expect(allText(blocks)).toContain('Click me')
    const links = blocks.flatMap(b => (b.kind === 'para' ? b.inline : [])).filter(i => i.kind === 'link')
    expect(links).toEqual([])
    expect(JSON.stringify(blocks)).not.toContain('javascript:')
  })

  it.each([
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/System32/calc.exe',
    'JaVaScRiPt:alert(1)',
    '\u0001javascript:alert(1)',
    'about:blank',
  ])('refuses the unsafe href %s', href => {
    const { blocks } = civitaiDescriptionBlocks(`<p><a href="${href}">t</a></p>`)
    const links = blocks.flatMap(b => (b.kind === 'para' ? b.inline : [])).filter(i => i.kind === 'link')
    expect(links).toEqual([])
  })

  it('keeps an https anchor as a LINK node carrying only text + href', () => {
    const { blocks } = civitaiDescriptionBlocks(
      '<p>See <a target="_blank" rel="ugc" href="https://example.com/a?b=1">the guide</a> first.</p>',
    )
    expect(blocks).toHaveLength(1)
    const para = blocks[0]!
    expect(para.kind).toBe('para')
    if (para.kind !== 'para') throw new Error('unreachable')
    expect(para.inline).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'the guide', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ' first.' },
    ])
  })

  it('never renders an <img> — a remote src would breach the CSP and leak a request', () => {
    const html = '<p><img src="https://image.civitai.com/x/width=525/banner.jpeg" alt="banner">Prose.</p>'
    const { blocks } = civitaiDescriptionBlocks(html)
    expect(allText(blocks)).toBe('Prose.')
    expect(JSON.stringify(blocks)).not.toContain('image.civitai.com')
  })

  it('decodes entities AFTER tag removal, so escaped markup stays inert text', () => {
    // `&lt;script&gt;` is text the author WROTE. Decoding it must not manufacture
    // a tag — and it cannot, because the output is a text node either way.
    const text = allText(parse('<p>Use &lt;script&gt; tags &amp; &quot;quotes&quot; &#39;here&#39;&nbsp;now</p>'))
    expect(text).toBe('Use <script> tags & "quotes" \'here\' now')
  })
})

describe('civitaiDescriptionBlocks — structure is preserved', () => {
  it('keeps paragraphs as separate blocks', () => {
    const blocks = parse('<p>One.</p><p>Two.</p><p>Three.</p>')
    expect(blocks.map(b => b.kind)).toEqual(['para', 'para', 'para'])
    expect(blocks.map(b => (b.kind === 'para' ? civitaiInlineText(b.inline) : ''))).toEqual(['One.', 'Two.', 'Three.'])
  })

  it('maps h1-h6 onto three heading levels', () => {
    const blocks = parse('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h6>E</h6>')
    expect(blocks.map(b => (b.kind === 'heading' ? b.level : null))).toEqual([1, 2, 3, 3, 3])
  })

  it('keeps a heading id attribute out of the text (TipTap emits them)', () => {
    const blocks = parse('<h1 id="heading-133">DreamShaper - V∞!</h1>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('heading')
    expect(allText(blocks)).toBe('DreamShaper - V∞!')
  })

  it('keeps unordered and ordered lists with one entry per <li>', () => {
    const blocks = parse('<ul><li>alpha</li><li>beta</li></ul><ol><li>first</li><li>second</li></ol>')
    expect(blocks).toHaveLength(2)
    const ul = blocks[0]!, ol = blocks[1]!
    if (ul.kind !== 'list' || ol.kind !== 'list') throw new Error('expected two lists')
    expect(ul.ordered).toBe(false)
    expect(ul.items.map(civitaiInlineText)).toEqual(['alpha', 'beta'])
    expect(ol.ordered).toBe(true)
    expect(ol.items.map(civitaiInlineText)).toEqual(['first', 'second'])
  })

  it('keeps a link inside a list item', () => {
    const blocks = parse('<ul><li>see <a href="https://example.com">docs</a></li></ul>')
    const list = blocks[0]!
    if (list.kind !== 'list') throw new Error('expected a list')
    expect(list.items[0]).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'docs', href: 'https://example.com' },
    ])
  })

  it('keeps blockquote and pre as their own block kinds', () => {
    const blocks = parse('<blockquote>quoted</blockquote><pre>a = 1\nb = 2</pre>')
    expect(blocks.map(b => b.kind)).toEqual(['quote', 'code'])
    const code = blocks[1]!
    if (code.kind !== 'code') throw new Error('expected code')
    // Newlines survive in a code block; everywhere else whitespace collapses.
    expect(code.text).toBe('a = 1\nb = 2')
  })

  it('flattens inline formatting to text instead of dropping the words', () => {
    const text = allText(parse('<p><strong>Bold</strong> and <em>italic</em> and <s>struck</s> and <u>under</u></p>'))
    expect(text).toBe('Bold and italic and struck and under')
  })

  it('treats <br> as a paragraph break rather than gluing lines together', () => {
    const blocks = parse('<p>line one<br>line two</p>')
    expect(blocks.map(b => (b.kind === 'para' ? civitaiInlineText(b.inline) : ''))).toEqual(['line one', 'line two'])
  })

  it('collapses whitespace runs and drops blocks that hold nothing', () => {
    const blocks = parse('<p>  spaced   out  </p><p></p><p>   </p><p><span> </span></p><p>real</p>')
    expect(blocks.map(b => (b.kind === 'para' ? civitaiInlineText(b.inline) : ''))).toEqual(['spaced out', 'real'])
  })

  it('recovers prose from a description with no block tags at all', () => {
    const blocks = parse('just a bare sentence')
    expect(blocks).toHaveLength(1)
    expect(allText(blocks)).toBe('just a bare sentence')
  })

  it('returns nothing for absent / empty / non-string descriptions', () => {
    for (const bad of [null, undefined, '', '   ', 42, {}, [], '<p></p>']) {
      const out = civitaiDescriptionBlocks(bad)
      expect(out.blocks).toEqual([])
      expect(out.truncated).toBe(false)
    }
  })

  it('flags truncation instead of parsing an unbounded string', () => {
    const huge = `<p>${'x'.repeat(CIVITAI_DESC_MAX_INPUT + 500)}</p>`
    const out = civitaiDescriptionBlocks(huge)
    expect(out.truncated).toBe(true)
    expect(out.blocks.length).toBeGreaterThan(0)
    // And the cap is real: nothing downstream sees the whole string.
    expect(allText(out.blocks).length).toBeLessThanOrEqual(CIVITAI_DESC_MAX_INPUT)
  })

  it('bounds the block count on a pathological description', () => {
    const many = '<p>p</p>'.repeat(5000)
    const out = civitaiDescriptionBlocks(many)
    expect(out.blocks.length).toBeLessThanOrEqual(400)
    expect(out.truncated).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AN HREF IS ENTITY-DECODED BEFORE IT IS VALIDATED
// ═══════════════════════════════════════════════════════════════════════════
//
// Driver-found on the installed build, three times in ONE description: the panel
// printed `…?nsfw=0&amp;page=1&amp;model=11…`. `pushText` decodes the anchor's
// TEXT; the href only ever went through `new URL()`, which does not decode
// entities — so the url shown, and the url a reader copied, was wrong.

describe('an href carries entities, and they are decoded BEFORE validation', () => {
  // VERBATIM from GET https://civitai.com/api/v1/models/257749 (Pony Diffusion
  // V6 XL), fetched 2026-08-01 — the only `&`-carrying href in that description
  // and the exact string the driver saw printed with literal `&amp;`.
  const REAL_HREF = 'https://purplesmart.ai/collection/top?nsfw=0&amp;page=1&amp;model=11&amp;order=created_desc'
  const DECODED = 'https://purplesmart.ai/collection/top?nsfw=0&page=1&model=11&order=created_desc'

  it('decodes the real observed href instead of printing &amp; three times', () => {
    const blocks = parse(
      `<p><a target="_blank" rel="ugc" href="${REAL_HREF}">check out more examples of this model here</a></p>`,
    )
    expect(allLinks(blocks)).toEqual([
      { kind: 'link', text: 'check out more examples of this model here', href: DECODED },
    ])
    expect(JSON.stringify(blocks)).not.toContain('&amp;')
  })

  it('decodes numeric and named entities in an href the same way', () => {
    expect(civitaiSafeHref('https://x.example/a?b=1&amp;c=2')).toBe('https://x.example/a?b=1&c=2')
    expect(civitaiSafeHref('https://x.example/a?b=1&#38;c=2')).toBe('https://x.example/a?b=1&c=2')
    expect(civitaiSafeHref('https://x.example/a?b=1&#x26;c=2')).toBe('https://x.example/a?b=1&c=2')
  })

  it('leaves an entity it does not know VERBATIM rather than guessing', () => {
    // Same honesty rule the text path follows: an unknown entity is shown, not
    // invented. It stays inside the query string, which is where it was.
    expect(civitaiSafeHref('https://x.example/?q=&hearts;')).toBe('https://x.example/?q=&hearts;')
  })

  it('cannot be used to SMUGGLE a scheme past the http(s) check', () => {
    // The whole reason the order is decode-then-validate rather than the reverse:
    // the protocol test sees what the reader will see.
    for (const href of [
      '&#106;avascript:alert(1)',            // decodes to javascript:
      '&#x6a;avascript:alert(1)',
      'j&#97;vascript:alert(1)',
      '&#106;&#97;vascript:alert(1)',
      '&#9;javascript:alert(1)',             // decode PRODUCES a control char
      '&#1;javascript:alert(1)',
      '&#100;ata:text/html;base64,PHN2Zz4=', // decodes to data:
    ]) {
      expect(civitaiSafeHref(href), href).toBeNull()
      expect(allLinks(parse(`<p><a href="${href}">t</a></p>`)), href).toEqual([])
    }
  })

  it('decodes ONCE — a double-escaped scheme is not a url at all', () => {
    // `&amp;#106;avascript:` → `&#106;avascript:` and stops there. A decode LOOP
    // would keep going and hand `javascript:` to the validator; a single decode
    // leaves a string the URL constructor rejects outright.
    expect(civitaiSafeHref('&amp;#106;avascript:alert(1)')).toBeNull()
  })

  it('still refuses every unsafe scheme it refused before', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///c:/x', 'about:blank']) {
      expect(civitaiSafeHref(href), href).toBeNull()
    }
    expect(civitaiSafeHref('https://ok.example/x')).toBe('https://ok.example/x')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// MARKDOWN MARKERS INSIDE THE HTML
// ═══════════════════════════════════════════════════════════════════════════
//
// Measured live 2026-08-01 across 300 models / 8 744 blocks (see the comment in
// civitaiHtml.ts for the full tally): 300/300 descriptions are HTML, 0/300 are a
// markdown DOCUMENT, and the markers that do appear sit inside <p> text —
// bullets in 17 models, numbered lists in 8, ATX headings in 2, one fence.
// The specimens below are verbatim shapes from models 2823917 and 2823699.

describe('markdown markers written inside TipTap paragraphs', () => {
  it('re-shapes an ATX heading paragraph — the specimen from model 2823917', () => {
    const blocks = parse('<p>A character LoRA.</p><p>## 使用方法</p><p>- Trigger word: <code>eri</code></p>')
    expect(blocks.map(b => b.kind)).toEqual(['para', 'heading', 'list'])
    const h = blocks[1]!
    if (h.kind !== 'heading') throw new Error('expected a heading')
    expect(civitaiInlineText(h.inline)).toBe('使用方法')
    expect(h.level).toBe(2)
  })

  it('folds every heading depth the way <h1>-<h6> already fold', () => {
    const blocks = parse('<p># A</p><p>## B</p><p>### C</p><p>#### D</p><p>###### E</p>')
    expect(blocks.map(b => (b.kind === 'heading' ? b.level : null))).toEqual([1, 2, 3, 3, 3])
  })

  it('does NOT eat a hash that is not a heading', () => {
    // `#1` has no space after the hash, so it is not ATX — and `#1 model on
    // Civitai` is a real thing an uploader writes.
    const blocks = parse('<p>#1 model on Civitai</p><p>Tagged #anime #sdxl</p>')
    expect(blocks.map(b => b.kind)).toEqual(['para', 'para'])
    expect(allText(blocks)).toBe('#1 model on Civitai\nTagged #anime #sdxl')
  })

  it('collects a run of `- ` paragraphs into ONE list, markers removed', () => {
    const blocks = parse(
      '<p>Recommended:</p><p>- Steps: 28</p><p>- CFG: 4</p><p>- Sampler: Euler</p><p>Then render.</p>',
    )
    expect(blocks.map(b => b.kind)).toEqual(['para', 'list', 'para'])
    const list = blocks[1]!
    if (list.kind !== 'list') throw new Error('expected a list')
    expect(list.ordered).toBe(false)
    expect(list.items.map(civitaiInlineText)).toEqual(['Steps: 28', 'CFG: 4', 'Sampler: Euler'])
  })

  it('handles all three bullet characters', () => {
    for (const marker of ['-', '*', '+']) {
      const list = parse(`<p>${marker} one</p><p>${marker} two</p>`)[0]!
      if (list.kind !== 'list') throw new Error(`expected a list for ${marker}`)
      expect(list.items.map(civitaiInlineText)).toEqual(['one', 'two'])
    }
  })

  it('keeps a LINK inside a bullet — the specimen from model 2823699', () => {
    // TipTap autolinked the url inside markdown link syntax, so the item is
    // `[Archetype gallery](` + a link + `)`. The bullet marker goes; the link
    // survives, which is the whole reason the pass edits inlines and not strings.
    const blocks = parse(
      '<p>- [Archetype gallery](<a target="_blank" rel="ugc" href="https://enragedantelope.github.io/g/">'
      + 'https://enragedantelope.github.io/g/</a>) — themed looks</p>',
    )
    const list = blocks[0]!
    if (list.kind !== 'list') throw new Error('expected a list')
    expect(list.items[0]![0]).toEqual({ kind: 'text', text: '[Archetype gallery](' })
    expect(allLinks(blocks)).toEqual([{
      kind: 'link',
      text: 'https://enragedantelope.github.io/g/',
      href: 'https://enragedantelope.github.io/g/',
    }])
  })

  it('makes a numbered run an ORDERED list, both markdown forms', () => {
    for (const src of [
      '<p>1. first</p><p>2. second</p><p>3. third</p>',
      '<p>1) first</p><p>2) second</p><p>3) third</p>',
    ]) {
      const list = parse(src)[0]!
      if (list.kind !== 'list') throw new Error('expected a list')
      expect(list.ordered).toBe(true)
      expect(list.items.map(civitaiInlineText)).toEqual(['first', 'second', 'third'])
    }
  })

  it('never merges bullets and numbers into one invented ordering', () => {
    const blocks = parse('<p>- a</p><p>1. b</p>')
    expect(blocks.map(b => (b.kind === 'list' ? b.ordered : null))).toEqual([false, true])
  })

  it('turns a CLOSED ``` fence into one code block — the specimen from 2823699', () => {
    const blocks = parse(
      '<p><strong>Git clone:</strong></p><p>```</p><p>cd ComfyUI/custom_nodes</p>'
      + '<p>git clone <a href="https://github.com/EnragedAntelope/comfyui-identity-forge">'
      + 'https://github.com/EnragedAntelope/comfyui-identity-forge</a></p><p>```</p><p>Restart ComfyUI.</p>',
    )
    expect(blocks.map(b => b.kind)).toEqual(['para', 'code', 'para'])
    const code = blocks[1]!
    if (code.kind !== 'code') throw new Error('expected code')
    expect(code.text).toBe(
      'cd ComfyUI/custom_nodes\ngit clone https://github.com/EnragedAntelope/comfyui-identity-forge',
    )
    // The fence markers themselves are gone, not printed as prose.
    expect(allText(blocks)).not.toContain('```')
  })

  it('accepts a language tag on the opening fence', () => {
    const blocks = parse('<p>```py</p><p>print(1)</p><p>```</p>')
    expect(blocks.map(b => b.kind)).toEqual(['code'])
  })

  it('keeps markdown markers LITERAL inside a fence', () => {
    const blocks = parse('<p>```</p><p># not a heading</p><p>- not a bullet</p><p>```</p>')
    expect(blocks.map(b => b.kind)).toEqual(['code'])
    const code = blocks[0]!
    if (code.kind !== 'code') throw new Error('expected code')
    expect(code.text).toBe('# not a heading\n- not a bullet')
  })

  it('leaves an UNCLOSED fence alone rather than swallowing the description', () => {
    const blocks = parse('<p>```</p><p>Real prose the reader came for.</p>')
    expect(blocks.map(b => b.kind)).toEqual(['para', 'para'])
    expect(allText(blocks)).toContain('Real prose the reader came for.')
  })

  it('does NOT read a decorative divider as a fence or a bullet', () => {
    // Both measured live: a tilde/asterisk rule and a tilde fence. `~~~` is not a
    // fence character here for exactly this reason.
    const blocks = parse('<p>~*~*~*~*~*~*~</p><p>~~~~~~~~~~</p><p>After.</p>')
    expect(blocks.map(b => b.kind)).toEqual(['para', 'para', 'para'])
    expect(allText(blocks)).toContain('~*~*~*~*~*~*~')
  })

  it('leaves EMPHASIS markers alone — 0 real hits in 300 live models', () => {
    // `CivitaiInline` has no bold, so "rendering" these could only mean deleting
    // characters. Live data: `**bold**` never occurred; every `*x*` / `_x_` match
    // was a divider or a username. Deleting them would be pure damage.
    const src = '<p>Use **best quality** and *this* and _that_ — see '
      + '<a href="https://civitai.com/user/_Wizz_">https://civitai.com/user/_Wizz_</a></p>'
    const blocks = parse(src)
    expect(civitaiInlineText((blocks[0] as Extract<CivitaiBlock, { kind: 'para' }>).inline))
      .toBe('Use **best quality** and *this* and _that_ — see https://civitai.com/user/_Wizz_')
  })

  it('leaves a real HTML description completely unchanged', () => {
    // The pass must be invisible on the 298/300 descriptions that carry no
    // markers at all — the shape from model 4201, which has none.
    const src = '<p><strong>Check my exclusive models on Mage: </strong>'
      + '<a href="https://www.mage.space/play/abc">ParagonXL</a></p>'
      + '<h3 id="heading-1">Recommended settings</h3><ul><li>Steps: 20+</li></ul>'
    expect(parse(src).map(b => b.kind)).toEqual(['para', 'heading', 'list'])
  })

  it('cannot grow the block count past the cap it already had', () => {
    const out = civitaiDescriptionBlocks('<p>- x</p>'.repeat(5000))
    expect(out.blocks.length).toBeLessThanOrEqual(400)
    expect(out.truncated).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PRINTING A LINK: ONCE, AND BREAKING AT SANE POINTS
// ═══════════════════════════════════════════════════════════════════════════

describe('a link keeps the space that separated it from the next word', () => {
  it('does not print `free SD botand` — the real 257749 fragment', () => {
    // VERBATIM from GET /api/v1/models/257749, 2026-08-01: the separating space
    // is INSIDE the anchor, so trimming the link label used to delete it. It
    // matters more now that an autolinked url prints once, with no ` (…) ` around
    // it to put the space back by accident.
    const blocks = parse(
      '<p><a target="_blank" rel="ugc" href="https://discord.gg/pYsdjMfu3q">'
      + 'Please join our Discord Server and get access to free SD bot </a>and '
      + '<a target="_blank" rel="ugc" href="https://purplesmart.ai/collection/top?nsfw=0&amp;page=1">'
      + 'check out more examples </a>or nothing.</p>',
    )
    expect(allText(blocks)).toBe(
      'Please join our Discord Server and get access to free SD bot and check out more examples or nothing.',
    )
    // The link labels themselves are still trimmed.
    expect(allLinks(blocks).map(l => l.text)).toEqual([
      'Please join our Discord Server and get access to free SD bot',
      'check out more examples',
    ])
  })

  it('keeps the space an <img>-only anchor collapses to', () => {
    const blocks = parse('<p>before <a href="https://x.example"><img src="https://i/x.png"></a>after</p>')
    expect(allText(blocks)).toBe('before after')
    expect(allLinks(blocks)).toEqual([])
  })

  it('still trims a run down to nothing when there is nothing but space', () => {
    expect(parse('<p><a href="https://x.example"> </a></p>')).toEqual([])
  })
})

describe('civitaiLinkPrintsHref', () => {
  it('is FALSE when the anchor text already is the url (the autolink case)', () => {
    // Real, from the committed fixture (model 260267 v3.0's description).
    const url = 'https://huggingface.co/cagliostrolab/animagine-xl-3.0'
    expect(civitaiLinkPrintsHref({ text: url, href: url })).toBe(false)
  })

  it('ignores ONE trailing slash on either side', () => {
    expect(civitaiLinkPrintsHref({ text: 'https://x.example', href: 'https://x.example/' })).toBe(false)
    expect(civitaiLinkPrintsHref({ text: 'https://x.example/', href: 'https://x.example' })).toBe(false)
  })

  it('is TRUE for real anchor words, and for a SHORTENED url', () => {
    expect(civitaiLinkPrintsHref({ text: 'the guide', href: 'https://x.example/g' })).toBe(true)
    // A shortened text is information, not a duplicate — it still earns the url.
    expect(civitaiLinkPrintsHref({ text: 'x.example/g', href: 'https://x.example/g' })).toBe(true)
  })
})

describe('civitaiUrlBreakParts', () => {
  it('breaks AFTER separators, never mid-token', () => {
    expect(civitaiUrlBreakParts('https://purplesmart.ai/collection/top?nsfw=0&page=1')).toEqual([
      'https://', 'purplesmart.', 'ai/', 'collection/', 'top?', 'nsfw=', '0&', 'page=', '1',
    ])
  })

  it('rejoins to the url EXACTLY — a copied url has to still work', () => {
    for (const url of [
      'https://civitai.com/models/260267?modelVersionId=403131',
      'https://enragedantelope.github.io/comfyui-identity-forge/gallery/archetypes/',
      'https://x.example',
      'https://x.example/a_b-c.d+e,f~g%20h',
    ]) {
      expect(civitaiUrlBreakParts(url).join('')).toBe(url)
    }
  })

  it('has one part for a url with nothing to break on, and none for nothing', () => {
    expect(civitaiUrlBreakParts('abcdef')).toEqual(['abcdef'])
    expect(civitaiUrlBreakParts('')).toEqual([])
  })
})

describe('civitaiDescriptionPlainText', () => {
  it('renders one flat string for the collapsed preview line', () => {
    const s = civitaiDescriptionPlainText(
      '<h1>Title</h1><p>First para with <a href="https://x.example">a link</a>.</p><ul><li>one</li></ul>',
    )
    expect(s).toBe('Title First para with a link. one')
  })

  it('is empty for an empty description', () => {
    expect(civitaiDescriptionPlainText(null)).toBe('')
  })
})

describe('THE STRUCTURAL GUARANTEE', () => {
  const CATALOG = fileURLToPath(new URL('../../src/pages/catalog/', import.meta.url))
  const files = readdirSync(CATALOG).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))

  it('finds the catalog surface to scan', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(files).toContain('CivitaiDetailPanel.tsx')
    expect(files).toContain('civitaiHtml.ts')
  })

  /**
   * Drop `//` and block comments before scanning.
   *
   * Needed because BOTH new files talk about dangerouslySetInnerHTML at length
   * in order to explain that they never call it — the first run of this test
   * flagged its own documentation, which is a nice demonstration that a
   * substring scan over source is not the same thing as a scan over code.
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('NO FILE in the catalog surface uses dangerouslySetInnerHTML', () => {
    // This is the whole safety argument for rendering a stranger's HTML, and it
    // is worth a guard rather than a comment: the parser above emits a closed
    // union with nowhere to put a tag, an attribute or a handler, so the panel
    // renders text nodes and a bug in the parser can only ever LOSE prose. The
    // day someone "simplifies" this by piping `description` into innerHTML, that
    // property is gone and nothing else in the suite would notice.
    const offenders = files.filter(f =>
      stripComments(readFileSync(join(CATALOG, f), 'utf8')).includes('dangerouslySetInnerHTML'))
    expect(offenders).toEqual([])
  })

  it('the block union cannot carry a raw html field', () => {
    // A shape assertion, so a future field like `{ kind: 'raw', html }` fails
    // here instead of quietly becoming renderable.
    const { blocks } = civitaiDescriptionBlocks(
      '<h1>h</h1><p>p <a href="https://e.com">l</a></p><ul><li>i</li></ul><pre>c</pre><blockquote>q</blockquote>',
    )
    const keys = new Set<string>()
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return }
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val) }
      }
    }
    walk(blocks)
    expect([...keys].sort()).toEqual(
      ['href', 'inline', 'items', 'kind', 'level', 'ordered', 'text'],
    )
  })
})

describe('a real captured description (TipTap output, live 2026-07-31)', () => {
  // Trimmed head of model 4201's description — the exact shape the API returns.
  const REAL = '<p><strong><span style="color:rgb(21, 170, 191)">Check my exclusive models on Mage: </span></strong>'
    + '<a target="_blank" rel="ugc" href="https://www.mage.space/play/4371756b27bf52e7a1146dc6fe2d969c">'
    + '<strong><span style="color:rgb(21, 170, 191)">Fluffy Rock</span></strong></a></p>'
    + '<h3 id="heading-1">Recommended settings</h3>'
    + '<ul><li>Steps: 20+</li><li>CFG: 3.5-7</li></ul>'

  it('parses to prose, a heading and a list — nothing else', () => {
    const blocks = parse(REAL)
    expect(blocks.map(b => b.kind)).toEqual(['para', 'heading', 'list'])
  })

  it('keeps the anchor text and its https href, drops style/target/rel', () => {
    const para = parse(REAL)[0]!
    if (para.kind !== 'para') throw new Error('expected para')
    expect(civitaiInlineText(para.inline)).toBe('Check my exclusive models on Mage: Fluffy Rock')
    const link = para.inline.find(i => i.kind === 'link')
    expect(link).toEqual({
      kind: 'link',
      text: 'Fluffy Rock',
      href: 'https://www.mage.space/play/4371756b27bf52e7a1146dc6fe2d969c',
    })
    expect(JSON.stringify(para)).not.toContain('rgb(21')
  })
})
