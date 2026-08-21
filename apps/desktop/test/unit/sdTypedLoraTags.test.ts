// apps/desktop/test/unit/sdTypedLoraTags.test.ts
//
// A `<lora:name:0.8>` TAG THE USER TYPED WAS A NO-OP THAT STILL CHANGED THE
// IMAGE.
//
// Every prompt shared anywhere in this ecosystem carries LoRA tags, so a pasted
// prompt arrives with them already in it. Two things then happened, and the
// second is the one worth a test file:
//
//  1. `--lora-model-dir` was passed only when the PICKER had a selection, so a
//     typed tag alone got no directory.
//  2. The engine's own extractor opens with
//     `if (lora_model_dir.empty()) return;` — WITH NO DIRECTORY IT NEVER
//     EXTRACTS OR REMOVES THE TAGS AT ALL. So `<lora:sparkle_v2:0.8>` stayed in
//     the prompt as literal text and was conditioned on. The feature was not
//     merely inert; it was quietly steering the picture with the syntax of its
//     own failure.
//
// Both halves are asserted here: the directory now follows the FINISHED PROMPT,
// and an unresolvable tag is removed from the text rather than left to condition.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-loratags-'))
})

afterAll(() => {
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  loraTagsIn, resolveTypedLoraTags, loraNameKey, hasLoraTag, promptWithLoraTags,
  LORA_HIGH_NOISE_PREFIX,
} from '../../src/pages/media/localGenParams'
import { adapterSlug } from '../../electron/services/user-sd-models'
import { buildSdArgs } from '../../electron/services/sd-cpp-client'

// ── The transformation that has to be ONE ─────────────────────────────────────

describe('loraNameKey is the name half of adapterSlug', () => {
  // If these two ever diverge, a typed name can never match the file the app
  // wrote, and nothing else in the suite would notice.
  const nasty = [
    'Detail Tweaker XL',
    'sparkle_v2',
    'Ω Ünïcødé  name',
    '  leading and trailing  ',
    'punctuation!!! (v2.1) [final]',
    'a'.repeat(80),
    '日本語のロラ',
    '---',
  ]
  for (const name of nasty) {
    it(`agrees for ${JSON.stringify(name.slice(0, 24))}`, () => {
      const slug = adapterSlug(name, 'deadbeef')
      const key  = loraNameKey(name)
      // The slug is `<key>-<8 hex>` — or `adapter-<hex>` when the key is empty.
      expect(slug).toBe(key ? `${key}-deadbeef` : 'adapter-deadbeef')
    })
  }
})

// ── Reading the tags ─────────────────────────────────────────────────────────

describe('loraTagsIn', () => {
  it('finds nothing in a prompt with no tags', () => {
    expect(loraTagsIn('a red cube on grass')).toEqual([])
  })

  it('reads name and weight', () => {
    expect(loraTagsIn('cat <lora:sparkle_v2:0.8>')).toEqual([
      { raw: '<lora:sparkle_v2:0.8>', typed: 'sparkle_v2', weight: 0.8, highNoise: false },
    ])
  })

  it('defaults a WEIGHTLESS tag to 1 — the engine regex needs a weight, so this form never matched at all', () => {
    const [tag] = loraTagsIn('cat <lora:sparkle_v2>')
    expect(tag.weight).toBe(1)
    expect(tag.typed).toBe('sparkle_v2')
  })

  it('takes the first number of the A1111 two-weight form', () => {
    expect(loraTagsIn('cat <lora:sparkle_v2:0.8:0.6>')[0].weight).toBe(0.8)
  })

  it('reads the |high_noise| prefix and strips it from the name', () => {
    const [tag] = loraTagsIn(`cat <lora:${LORA_HIGH_NOISE_PREFIX}wan_high:1>`)
    expect(tag.highNoise).toBe(true)
    expect(tag.typed).toBe('wan_high')
  })

  it('clamps a weight past the band', () => {
    expect(loraTagsIn('cat <lora:x:99>')[0].weight).toBe(2)
  })
})

// ── Resolving them against what is on this disk ───────────────────────────────

const INSTALLED = [
  { name: 'Character Design Sheet Helper', slug: 'character-design-sheet-helper-b316b482' },
  { name: 'Detail Tweaker XL',             slug: 'detail-tweaker-xl-11112222' },
  // A file the user dropped in by hand: name === slug, no registry row.
  { name: 'sparkle_v2',                    slug: 'sparkle_v2' },
]

describe('resolveTypedLoraTags', () => {
  it('returns the prompt byte-identical when there are no tags', () => {
    const p = 'a red cube, best quality'
    const r = resolveTypedLoraTags(p, INSTALLED)
    expect(r.prompt).toBe(p)
    expect(r.applied).toEqual([])
    expect(r.unknown).toEqual([])
  })

  it('rewrites a name the user typed into the slug on disk', () => {
    const r = resolveTypedLoraTags('a girl <lora:Character Design Sheet Helper:0.8>', INSTALLED)
    expect(r.prompt).toBe('a girl <lora:character-design-sheet-helper-b316b482:0.8>')
    expect(r.applied).toEqual([{
      typed: 'Character Design Sheet Helper',
      slug:  'character-design-sheet-helper-b316b482',
      name:  'Character Design Sheet Helper',
      weight: 0.8,
    }])
  })

  it('leaves a tag that already names an installed slug exactly as it is', () => {
    const p = 'a girl <lora:detail-tweaker-xl-11112222:0.5>'
    expect(resolveTypedLoraTags(p, INSTALLED).prompt).toBe(p)
  })

  it('keeps a hand-placed file the registry has never heard of', () => {
    // The engine matches FILE STEMS. Stripping this would be the app overruling
    // a tag that works.
    const p = 'a girl <lora:sparkle_v2:0.7>'
    const r = resolveTypedLoraTags(p, INSTALLED)
    expect(r.prompt).toBe(p)
    expect(r.unknown).toEqual([])
  })

  it('REMOVES a tag naming nothing installed, so it cannot be conditioned on', () => {
    const r = resolveTypedLoraTags('a girl <lora:not_here:0.8>, best quality', INSTALLED)
    expect(r.prompt).toBe('a girl, best quality')
    expect(r.unknown).toEqual(['not_here'])
    expect(hasLoraTag(r.prompt)).toBe(false)
  })

  it('removes an AMBIGUOUS name rather than guessing which of two it meant', () => {
    const twins = [
      { name: 'add detail', slug: 'add-detail-aaaaaaaa' },
      { name: 'Add Detail', slug: 'add-detail-bbbbbbbb' },
    ]
    const r = resolveTypedLoraTags('a girl <lora:add detail:1>', twins)
    expect(r.ambiguous).toEqual(['add detail'])
    expect(r.applied).toEqual([])
    expect(hasLoraTag(r.prompt)).toBe(false)
  })

  it('gives a weightless tag an explicit weight, which is what makes it work', () => {
    const r = resolveTypedLoraTags('a girl <lora:Detail Tweaker XL>', INSTALLED)
    expect(r.prompt).toBe('a girl <lora:detail-tweaker-xl-11112222:1>')
  })

  it('preserves the |high_noise| prefix through a rewrite', () => {
    const r = resolveTypedLoraTags(`x <lora:${LORA_HIGH_NOISE_PREFIX}Detail Tweaker XL:1>`, INSTALLED)
    expect(r.prompt).toBe(`x <lora:${LORA_HIGH_NOISE_PREFIX}detail-tweaker-xl-11112222:1>`)
  })

  it('resolves several tags in one prompt independently', () => {
    const r = resolveTypedLoraTags(
      'x <lora:Detail Tweaker XL:0.5> y <lora:ghost:1> z <lora:sparkle_v2:1>',
      INSTALLED,
    )
    expect(r.applied.map(a => a.slug)).toEqual(['detail-tweaker-xl-11112222', 'sparkle_v2'])
    expect(r.unknown).toEqual(['ghost'])
    expect(r.prompt).toBe('x <lora:detail-tweaker-xl-11112222:0.5> y z <lora:sparkle_v2:1>')
  })

  it('says a bad name ONCE however many times it was typed', () => {
    const r = resolveTypedLoraTags('x <lora:ghost:1> y <lora:ghost:0.5>', INSTALLED)
    expect(r.unknown).toEqual(['ghost'])
    expect(hasLoraTag(r.prompt)).toBe(false)
  })

  it('…but a repeated GOOD tag is left as two, because the engine sums them', () => {
    const r = resolveTypedLoraTags('x <lora:sparkle_v2:0.5> y <lora:sparkle_v2:0.5>', INSTALLED)
    expect(r.applied).toHaveLength(2)
  })

  it('removes every tag when nothing at all is installed', () => {
    const r = resolveTypedLoraTags('a girl <lora:anything:1>', [])
    expect(r.prompt).toBe('a girl')
    expect(r.unknown).toEqual(['anything'])
  })

  it('composes with the picker: typed tag resolved, selection appended', () => {
    const r = resolveTypedLoraTags('a girl <lora:Detail Tweaker XL:0.5>', INSTALLED)
    const out = promptWithLoraTags(r.prompt, [{ slug: 'sparkle_v2', weight: 1 }])
    expect(out).toBe('a girl <lora:detail-tweaker-xl-11112222:0.5> <lora:sparkle_v2:1>')
  })
})

// ── The argv: both halves or neither, from the FINISHED prompt ────────────────

const LORA_DIR = join(tmpdir(), 'loras')

function argsFor(prompt: string, opts: { dir?: boolean; installed?: typeof INSTALLED } = {}) {
  return buildSdArgs(
    { model: 'C:/m.safetensors' },
    { modelId: 'sd-turbo', prompt },
    'C:/out.png',
    {
      ...(opts.dir === false ? {} : { adapterDirs: { lora: LORA_DIR } }),
      installedLoras: opts.installed ?? INSTALLED,
    },
  )
}

/** The `-p` value, read the way the provenance stamp now reads it. */
function promptOf(args: string[]): string {
  return args[args.indexOf('-p') + 1]
}

describe('buildSdArgs and a typed tag', () => {
  it('passes --lora-model-dir for a TYPED tag with no picker selection — the defect', () => {
    const args = argsFor('a girl <lora:Detail Tweaker XL:0.8>')
    expect(args).toContain('--lora-model-dir')
    expect(promptOf(args)).toContain('<lora:detail-tweaker-xl-11112222:0.8>')
  })

  it('still passes it for a picker selection with no typed tag (nothing regressed)', () => {
    const args = buildSdArgs(
      { model: 'C:/m.safetensors' },
      { modelId: 'sd-turbo', prompt: 'a girl', loras: [{ slug: 'sparkle_v2', weight: 1 }] },
      'C:/out.png',
      { adapterDirs: { lora: LORA_DIR }, installedLoras: INSTALLED },
    )
    expect(args).toContain('--lora-model-dir')
  })

  it('passes NO directory for a prompt with no tags at all', () => {
    expect(argsFor('a girl')).not.toContain('--lora-model-dir')
  })

  it('sends a prompt with the dead tag REMOVED even when there is no lora directory', () => {
    // The engine would have conditioned on the literal text here: with no
    // directory it never looks at the tags.
    const args = argsFor('a girl <lora:ghost:1>', { dir: false })
    expect(promptOf(args)).toBe('a girl')
    expect(args).not.toContain('--lora-model-dir')
  })

  it('does not pass a directory for a prompt whose only tag was unresolvable', () => {
    const args = argsFor('a girl <lora:ghost:1>')
    expect(promptOf(args)).toBe('a girl')
    expect(args).not.toContain('--lora-model-dir')
  })
})

// ── The gate is the prompt, not the selection count ───────────────────────────

describe('the source itself', () => {
  const read = (rel: string): string => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('no longer gates the lora directory on a selection count', () => {
    const src = read('electron/services/sd-cpp-client.ts')
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//'))
      .join('\n')
    // The two dead conditions, one per builder.
    expect(src).not.toContain('loras && loras.length > 0) args.push(\'--lora-model-dir\'')
    expect(src).not.toContain('vLoras && vLoras.length > 0) args.push(\'--lora-model-dir\'')
  })

  it('reads the provenance prompt out of the argv rather than recomputing it', () => {
    const src = read('electron/services/sd-cpp-client.ts')
    expect(src).toContain('promptSent')
    expect(src).toContain("args.indexOf('-p')")
  })
})
