// apps/desktop/test/unit/keyCardReplace.test.ts
//
// REPLACING A STORED KEY IN PLACE — the gap a live driver run hit on the
// installed build (2026-08-01).
//
// The Civitai and HuggingFace cards rendered their key input ONLY when nothing
// was stored. With a key saved they showed "✓ stored" and "Remove key" and
// nothing else, so rotation had exactly one shape: destroy the working
// credential, then paste its successor. If the successor turned out to be bad
// the user was left with neither — having thrown away a secret the app cannot
// recover. And it made the just-shipped validate-before-save rule moot in the
// case that needed it most: the validator could only ever protect a paste that
// had nothing to lose.
//
// THE ORDERING RULE IS THE UNIT UNDER TEST, and it is the part a future
// refactor will break:
//
//     validate the new value WHILE the old one is still the stored key;
//     on REJECTION, the old key remains stored and in force;
//     never remove-then-add, and never a window where neither is stored.
//
// `validateThenStoreKey` is where that lives, and it takes NO delete
// dependency — it structurally cannot open that window. These tests hold it
// there.
//
// AND THE SECOND HAZARD, closed the same day: the helper used to block the save
// on EVERY failure, not just a rejection. An offline laptop, a 503 and an x402
// payment challenge all read as "your key is bad" AND left the user unable to
// store a credential we had learned nothing about. Now only an AFFIRMATIVE
// `verdict: 'rejected'` blocks the write; `unverified` STORES and says so.
// Suite 1 pins both halves — including that an unverified save still cannot
// lose the key it replaced, because there is still exactly one write and no
// removal anywhere on the path.

import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { validateThenStoreKey, cancelKeyReplace, keyProbeTone } from '../../src/pages/settings/SettingsPage'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
/** Comments stripped: this file's prose quotes the very shapes it forbids. */
const strip = (src: string) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

const SETTINGS_PAGE = 'src/pages/settings/SettingsPage.tsx'
const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const src = strip(read(SETTINGS_PAGE))
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from)
  const b = s.indexOf(to, a + from.length)
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1)
  expect(b, `anchor not found: ${to}`).toBeGreaterThan(a)
  return s.slice(a, b)
}
const civitaiCard = () => between(src, 'function CivitaiCard', 'function HuggingFaceCard')
const hfCard      = () => between(src, 'function HuggingFaceCard', 'function OpenGatewayCard')

// The five provider cards, added 2026-08-01. Anchors are the NEXT card's
// declaration, so the card order in the file is part of the contract.
const ogwCard     = () => between(src, 'function OpenGatewayCard', 'function VeniceCard')
const veniceCard  = () => between(src, 'function VeniceCard',      'function ImgnaiCard')
const imgnaiCard  = () => between(src, 'function ImgnaiCard',      'function BankrCard')
const bankrCard   = () => between(src, 'function BankrCard',       'function SurplusCard')
const surplusCard = () => between(src, 'function SurplusCard',     'function FreeClaudeCodeCard')

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE ORDERING RULE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A stand-in keychain. `save` is the ONLY thing that may ever mutate it — the
 * point of every test below is what this object holds afterwards.
 */
function keychain(initial: Record<string, string> = {}) {
  const store = { ...initial }
  const save = vi.fn(async (id: string, value: string) => { store[id] = value })
  return { store, save }
}

describe('validateThenStoreKey — validate first, store unless REJECTED', () => {
  it('validates the TYPED value, then stores it', async () => {
    const order: string[] = []
    const validate = vi.fn(async (v: string) => { order.push(`validate:${v}`); return { ok: true as const, username: 'dmitry' } })
    const save     = vi.fn(async (v: string) => { order.push(`save:${v}`) })

    const res = await validateThenStoreKey({ value: 'new-key', validate, save })

    expect(res).toEqual({ stored: true, probe: { ok: true, username: 'dmitry' } })
    // ORDER IS THE ASSERTION. Storing first and pinging after would report
    // success for a value already committed.
    expect(order).toEqual(['validate:new-key', 'save:new-key'])
  })

  it('trims before it does either — the same string is checked and stored', async () => {
    const validate = vi.fn(async () => ({ ok: true as const, name: 'x' }))
    const save = vi.fn(async () => {})
    await validateThenStoreKey({ value: '  hf_tok  ', validate, save })
    expect(validate).toHaveBeenCalledWith('hf_tok')
    expect(save).toHaveBeenCalledWith('hf_tok')
  })

  // ── THE LOAD-BEARING ONE ──────────────────────────────────────────────────

  it('REJECTED: leaves the previously stored key stored, and never calls save', async () => {
    const { store, save } = keychain({ civitai: 'the-old-key-that-works' })
    const validate = vi.fn(async () => ({ ok: false as const, verdict: 'rejected' as const, status: 401 }))

    const res = await validateThenStoreKey({
      value: 'a-rotated-key-that-was-mistyped',
      validate,
      save: (v) => save('civitai', v),
    })

    expect(res.stored).toBe(false)
    // The probe goes back verbatim so the card can name the 401.
    expect(res.probe).toEqual({ ok: false, verdict: 'rejected', status: 401 })
    // NOTHING WAS WRITTEN — this is the whole feature.
    expect(save).not.toHaveBeenCalled()
    expect(store).toEqual({ civitai: 'the-old-key-that-works' })
  })

  // ── AND THE OTHER LOAD-BEARING ONE, added 2026-08-01 ──────────────────────

  it('UNVERIFIED: STORES the key — we learned nothing, so we may not refuse it', async () => {
    // The hazard this closes: an offline machine, an outage, a timeout or a 402
    // used to block the save AND render as "your key is bad". Both halves were
    // wrong; a user on a plane could not store a working credential at all.
    const { store, save } = keychain()
    const res = await validateThenStoreKey({
      value: 'bk_perfectly_good',
      validate: async () => ({ ok: false as const, verdict: 'unverified' as const }),
      save: (v) => save('bankr-gateway', v),
    })
    expect(res.stored).toBe(true)
    // The failed probe still comes back, so the card can say it was not checked.
    expect(res.probe).toEqual({ ok: false, verdict: 'unverified' })
    expect(store).toEqual({ 'bankr-gateway': 'bk_perfectly_good' })
  })

  it('UNVERIFIED on a replace CANNOT LOSE the previous key — one write, no removal', async () => {
    // The new value takes over (that is what the user asked for), but there is
    // never a moment with nothing stored, and never a second operation to
    // interleave with. If `save` itself fails, the old key is what survives.
    const { store, save } = keychain({ venice: 'the-old-key' })
    let seenDuringPing: Record<string, string> | null = null
    const res = await validateThenStoreKey({
      value: 'the-new-key',
      validate: async () => {
        await new Promise(r => setTimeout(r, 5))
        seenDuringPing = { ...store }
        return { ok: false as const, verdict: 'unverified' as const, status: 503 }
      },
      save: (v) => save('venice', v),
    })
    expect(seenDuringPing).toEqual({ venice: 'the-old-key' })
    expect(res.stored).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store).toEqual({ venice: 'the-new-key' })
  })

  it('a failure with NO verdict at all is treated as unverified, so it stores', async () => {
    // Only an AFFIRMATIVE rejection may cost the user a save. A validator that
    // forgot to say which kind of failure it hit must not silently become the
    // strictest one.
    const { store, save } = keychain()
    const res = await validateThenStoreKey({
      value: 'k',
      validate: async () => ({ ok: false as const }),
      save: (v) => save('surplus', v),
    })
    expect(res.stored).toBe(true)
    expect(store).toEqual({ surplus: 'k' })
  })

  it('a THROWING validator is "could not ask" — unverified, and the key is stored', async () => {
    // An IPC/transport failure used to escape into the component's `finally`,
    // leaving the card silent. It has to render the honest line — and it must
    // not be the thing that stops a rotation.
    const { store, save } = keychain({ civitai: 'old' })
    const res = await validateThenStoreKey({
      value: 'new',
      validate: async () => { throw new Error('ipc channel gone') },
      save: (v) => save('civitai', v),
    })
    expect(res.stored).toBe(true)
    expect(res.probe).toEqual({ ok: false, verdict: 'unverified' })   // → probeUnverified
    expect(res.probe?.status).toBeUndefined()  // NOT a 401 — we never got an answer
    expect(store).toEqual({ civitai: 'new' })
  })

  it('an empty or whitespace value touches neither the network nor the keychain', async () => {
    const validate = vi.fn()
    const save = vi.fn()
    for (const value of ['', '   ', '\t\n']) {
      const res = await validateThenStoreKey({ value, validate, save })
      expect(res).toEqual({ stored: false, probe: null })
    }
    expect(validate).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('keyProbeTone names the three outcomes, so no card can colour them alike', () => {
    expect(keyProbeTone({ ok: true })).toBe('ok')
    expect(keyProbeTone({ ok: false, verdict: 'rejected', status: 401 })).toBe('rejected')
    expect(keyProbeTone({ ok: false, verdict: 'unverified', status: 503 })).toBe('unverified')
    expect(keyProbeTone({ ok: false })).toBe('unverified')
    expect(keyProbeTone(null)).toBe('unverified')
  })

  it('the unverified line is neither the success colour nor the destructive one', () => {
    // A green tick would claim a check that never happened; a red line would
    // accuse a key nobody judged.
    const region = between(src, 'const KEY_PROBE_COLOR', 'function CivitaiCard')
    expect(region).toMatch(/ok:\s*'var\(--success/)
    expect(region).toMatch(/rejected:\s*'var\(--destructive\)'/)
    expect(region).toMatch(/unverified:\s*'var\(--warning/)
  })

  it('the old key is still stored for the WHOLE duration of the ping (accepted case)', async () => {
    // Not just at the end: there must be no instant in between where the
    // keychain is empty. A slow validator is the window a remove-then-add
    // implementation would expose.
    const { store, save } = keychain({ civitai: 'old' })
    let seenDuringPing: Record<string, string> | null = null
    const res = await validateThenStoreKey({
      value: 'new',
      validate: async () => {
        await new Promise(r => setTimeout(r, 5))
        seenDuringPing = { ...store }
        return { ok: true as const, username: 'u' }
      },
      save: (v) => save('civitai', v),
    })
    expect(seenDuringPing).toEqual({ civitai: 'old' })
    expect(res.stored).toBe(true)
    // One write, an overwrite in place.
    expect(save).toHaveBeenCalledTimes(1)
    expect(store).toEqual({ civitai: 'new' })
  })

  it('takes NO delete dependency, so it cannot remove-then-add', async () => {
    const region = between(src, 'export async function validateThenStoreKey', 'export function cancelKeyReplace')
    expect(region).not.toMatch(/delete/i)
    // Exactly two effects: ask, then write.
    expect(region).toContain('await deps.validate(value)')
    expect(region).toContain('await deps.save(value)')
    expect(region.indexOf('await deps.validate(value)'))
      .toBeLessThan(region.indexOf('await deps.save(value)'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. BACKING OUT
// ═══════════════════════════════════════════════════════════════════════════

describe('cancelKeyReplace — the typed value does not survive', () => {
  it('restores the stored state AND clears the input', () => {
    const setValue = vi.fn()
    const setProbe = vi.fn()
    const setReplacing = vi.fn()
    cancelKeyReplace({ setValue, setProbe, setReplacing })

    expect(setReplacing).toHaveBeenCalledWith(false)
    // A half-typed secret must not be left sitting in a mounted input.
    expect(setValue).toHaveBeenCalledWith('')
    expect(setProbe).toHaveBeenCalledWith(null)
  })

  it('clears the value on EVERY path — no argument can keep it', () => {
    const calls: unknown[] = []
    cancelKeyReplace({
      setValue: (v) => calls.push(v),
      setProbe: (v) => calls.push(v),
      setReplacing: (v) => calls.push(v),
    })
    expect(calls).toEqual([false, '', null])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. BOTH CARDS, IDENTICALLY WIRED
// ═══════════════════════════════════════════════════════════════════════════

const CARDS = [
  { name: 'Civitai',      body: civitaiCard, id: 'civitai',     ns: 'civitai',     keyId: 'CIVITAI_KEY_ID', validator: 'window.tachi.civitai.validateKey(' },
  { name: 'HuggingFace',  body: hfCard,      id: 'huggingface', ns: 'huggingface', keyId: 'HF_KEY_ID',      validator: 'window.tachi.hf.validateToken(' },
] as const

describe.each(CARDS)('$name card — the replace path', (card) => {
  it('offers a Replace trigger in the stored state', () => {
    const body = card.body()
    expect(body).toContain(`data-testid="${card.id}-replace"`)
    expect(body).toContain(`t('${card.ns}.replaceKey')`)
    // It belongs to the STORED branch — an empty card has nothing to replace.
    expect(body).toMatch(/hasStored \?[\s\S]*?-replace"/)
  })

  it('reveals the SAME input, not a second one with its own state', () => {
    const body = card.body()
    // Exactly ONE input in the card, and it is the masked one.
    expect((body.match(/<input\b/g) ?? []).length).toBe(1)
    expect(body).toContain('type="password"')
    expect(body).toContain(`data-testid="${card.id}-key"`)
    expect(body).toContain('value={key}')
    // Shown when nothing is stored OR while replacing — one condition, one node.
    expect(body).toContain('{(!hasStored || replacing) && (')
  })

  it('runs the shared validate-then-store sequence, with no local shortcut', () => {
    const body = card.body()
    const call = body.indexOf('validateThenStoreKey({')
    expect(call).toBeGreaterThan(-1)
    // The validator is the dep, and it is named BEFORE save in the deps object.
    expect(body.indexOf(card.validator)).toBeGreaterThan(call)
    expect(body.indexOf(card.validator))
      .toBeLessThan(body.indexOf(`window.tachi.settings.saveKey(${card.keyId}`))
    // And the card short-circuits on the helper's verdict — on STORED, not on
    // the probe's ok, because an unverified probe still wrote the key.
    expect(body).toMatch(/if \(!res\.stored\) return/)
    expect(body).not.toMatch(/if \(!res\.ok\) return/)
    // No second, hand-rolled save path.
    expect((body.match(/settings\.saveKey\(/g) ?? []).length).toBe(1)
  })

  it('cancels through the shared reset, which is what clears the typed value', () => {
    const body = card.body()
    expect(body).toContain(`data-testid="${card.id}-cancel-replace"`)
    expect(body).toContain(`t('${card.ns}.cancelReplace')`)
    expect(body).toContain('cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })')
    // The Cancel control only exists while replacing — it must not offer to
    // cancel the first-time paste, which has nothing to go back to.
    expect(body).toMatch(/\{replacing && \(\s*<button[\s\S]*?-cancel-replace"/)
  })

  it('says out loud that the previous credential survived a rejection', () => {
    const body = card.body()
    // The REJECTED copy is picked by whether something WAS stored, which after a
    // failed replace is still true (nothing was refreshed, nothing was written).
    expect(body).toContain(`t(hasStored ? '${card.ns}.probeRejectedKept' : '${card.ns}.probeRejected')`)
    expect(body).toContain(`data-testid="${card.id}-probe"`)
  })

  it('renders the THIRD outcome — saved, but not checked', () => {
    const body = card.body()
    // One string, not a Kept/not-Kept pair: the key IS the stored one now, so
    // there is no "your previous one survived" to say.
    expect(body).toContain(`t('${card.ns}.probeUnverified')`)
    expect(body).not.toContain('probeFailed')
    // Branching on the VERDICT, never on a raw status: a 403 or a 429 must not
    // fall through into the rejection copy.
    expect(body).toMatch(/probe\.verdict === 'rejected'/)
    expect(body).not.toMatch(/probe\.status === 401\s*\n?\s*\?/)
    // …and the three outcomes get three colours.
    expect(body).toContain('KEY_PROBE_COLOR[keyProbeTone(probe)]')
  })

  it('explains, while the input is open, that the stored key still holds', () => {
    const body = card.body()
    expect(body).toContain(`t('${card.ns}.replaceHint')`)
    expect(body).toContain(`data-testid="${card.id}-replace-hint"`)
  })

  it('leaves Remove exactly as it was — one delete, unconditional', () => {
    const body = card.body()
    expect((body.match(/settings\.deleteKey\(/g) ?? []).length).toBe(1)
    expect(body).toContain(`window.tachi.settings.deleteKey(${card.keyId})`)
    expect(body).toContain(`t('${card.ns}.removeKey')`)
    // Remove is NOT part of the replace path — nothing may delete on the way in.
    const saveHandler = between(body, 'const save = async', 'const remove = async')
    expect(saveHandler).not.toMatch(/deleteKey/)
  })

  it('a Remove taken MID-replace closes the input instead of lying', () => {
    // Otherwise the card would sit there with an open input and a hint claiming
    // "the stored key stays in force" over a keychain that no longer has one —
    // and with the typed value still mounted.
    const body = card.body()
    const removeHandler = between(body, 'const remove = async', 'const startReplace')
    expect(removeHandler).toContain(`deleteKey(${card.keyId})`)
    expect(removeHandler).toContain('cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })')
    // The delete still happens FIRST — the reset is cleanup, not a precondition.
    expect(removeHandler.indexOf('deleteKey'))
      .toBeLessThan(removeHandler.indexOf('cancelKeyReplace'))
  })

  it('never leaks the typed secret into an attribute or a log', () => {
    const body = card.body()
    expect(body).not.toMatch(/title=\{key/)
    expect(body).not.toMatch(/aria-label=\{key/)
    expect(body).not.toMatch(/aria-[a-z]+=\{key\b/)
    expect(body).not.toMatch(/console\.(log|warn|error|info|debug)/)
    expect(body).not.toMatch(/type="text"/)
  })
})

describe('the two cards stayed structurally identical', () => {
  it('every replace-path anchor appears exactly once in each', () => {
    for (const anchor of [
      'validateThenStoreKey({',
      // Twice in each: the Cancel control, and the mid-replace Remove.
      'cancelKeyReplace({ setValue: setKey, setProbe, setReplacing })',
      'const startReplace = () => { setProbe(null); setReplacing(true) }',
      'style={KEY_CARD_SECONDARY_BTN}',   // twice: Replace + Cancel
      'style={KEY_CARD_REPLACE_HINT}',
    ]) {
      const inCivitai = (civitaiCard().match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      const inHf      = (hfCard().match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      expect(inCivitai, `civitai: ${anchor}`).toBeGreaterThan(0)
      expect(inHf, `hf: ${anchor}`).toBe(inCivitai)
    }
  })

  it('the shared sequence lives ABOVE both cards, so neither owns it', () => {
    expect(src.indexOf('export async function validateThenStoreKey'))
      .toBeLessThan(src.indexOf('function CivitaiCard'))
    expect(src.indexOf('export function cancelKeyReplace'))
      .toBeLessThan(src.indexOf('function CivitaiCard'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. i18n — 8 locales
// ═══════════════════════════════════════════════════════════════════════════

const NEW_KEYS = ['replaceKey', 'cancelReplace', 'replaceHint', 'probeRejectedKept', 'probeUnverified'] as const

function settingsNs(lang: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'settings.json'), 'utf8'))
}

describe('i18n — the replace strings, every locale', () => {
  for (const lang of LANGS) {
    it(`${lang}: both cards have all ${NEW_KEYS.length} new keys, non-empty`, () => {
      const ns = settingsNs(lang)
      for (const block of ['civitai', 'huggingface'] as const) {
        for (const key of NEW_KEYS) {
          const v = ns[block]?.[key]
          expect(typeof v, `${lang}/settings:${block}.${key}`).toBe('string')
          expect(v!.trim(), `${lang}/settings:${block}.${key}`).not.toBe('')
        }
      }
    })

    it(`${lang}: the "kept" copy is REWRITTEN, not copied from the plain rejection`, () => {
      // A translator who pasted the old string would silently drop the one fact
      // this variant exists to state: you still have a working credential.
      const ns = settingsNs(lang)
      for (const block of ['civitai', 'huggingface'] as const) {
        const b = ns[block]!
        expect(b.probeRejectedKept, `${lang}/${block}`).not.toBe(b.probeRejected)
        // …and it is LONGER, because it says strictly more.
        expect(b.probeRejectedKept!.length).toBeGreaterThan(b.probeRejected!.length)
      }
    })

    it(`${lang}: the unverified copy is its OWN sentence, not the rejection reworded`, () => {
      // These say opposite things about the keychain — one wrote nothing, the
      // other wrote the key. The dead "could not check → not saved" strings are
      // gone from every locale so neither can be revived by copy-paste.
      const ns = settingsNs(lang)
      for (const block of ['civitai', 'huggingface'] as const) {
        const b = ns[block]!
        expect(b.probeFailed, `${lang}/${block}.probeFailed`).toBeUndefined()
        expect(b.probeFailedKept, `${lang}/${block}.probeFailedKept`).toBeUndefined()
        expect(b.probeUnverified).not.toBe(b.probeRejected)
        expect(b.probeUnverified).not.toBe(b.probeRejectedKept)
      }
    })

    it(`${lang}: the Replace label is not the Remove label`, () => {
      // Two adjacent controls, one destructive. Identical labels would be the
      // worst possible outcome of this change.
      const ns = settingsNs(lang)
      for (const block of ['civitai', 'huggingface'] as const) {
        expect(ns[block]!.replaceKey, `${lang}/${block}`).not.toBe(ns[block]!.removeKey)
      }
    })
  }

  it('the English copy states the fact, in both cards', () => {
    const ns = settingsNs('en')
    for (const block of ['civitai', 'huggingface'] as const) {
      const b = ns[block]!
      expect(b.probeRejectedKept).toMatch(/still stored and in force/i)
      expect(b.replaceHint).toMatch(/stays in force/i)
      expect(b.replaceHint).toMatch(/nothing changes/i)
      // …and it no longer over-promises. The hint is what the user reads BEFORE
      // pressing Save, so it must state the could-not-check outcome too.
      expect(b.replaceHint).toMatch(/saved anyway/i)
      // The unverified line must say BOTH true things and neither false one: it
      // was saved, and it was not checked. It may not say "rejected" and it may
      // not say "not saved".
      expect(b.probeUnverified).toMatch(/saved without being checked/i)
      expect(b.probeUnverified).toMatch(/now the one in use/i)
      expect(b.probeUnverified).not.toMatch(/rejected|not saved/i)
    }
    // Each card speaks its own noun — a "key" card must not say "token".
    expect(ns.civitai!.replaceKey).toMatch(/key/i)
    expect(ns.huggingface!.replaceKey).toMatch(/token/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE OTHER FIVE CARDS (2026-08-01)
//
// OpenGateway, Venice, imgnAI, Bankr and Surplus had the same shape the two
// above did: the input rendered only when nothing was stored, so replacing meant
// Remove-then-paste. All five now get the same replace affordance.
//
// FOUR of them now get validate-before-store; ONE does not, and that split is
// measured, not arbitrary — see electron/services/provider-key-probe.ts and
// test/unit/providerKeyProbe.test.ts. Venice and Surplus moved into the
// validated column on 2026-08-01, when a documentation review overturned both
// refusals (Venice: 403 is their documented "valid key, no rights"; Surplus:
// count_tokens reads the buyer key with "no upstream round-trip", so it spends
// nothing). The distinction this suite enforces:
//
//   validated   (bankr, imgnai-pair, venice, surplus) — routes through
//               validateThenStoreKey, so a REJECTED credential never reaches
//               saveKey at all, and an UNVERIFIED one is stored with the copy
//               that says it was not checked.
//   unvalidated (opengateway) — a PLAIN OVERWRITE-IN-PLACE. Weaker, and honest
//               about it on screen. The property that still holds, and the one
//               asserted here, is that the write path contains NO delete: a
//               failed write therefore leaves whatever was stored exactly where
//               it was. There is no interleaving in which the old key is lost,
//               because there is no second operation to interleave with.
//
// `rejects` marks the cards that have a rejection to render at all. Venice does
// NOT: its 401 is ambiguous (inference-only keys, lapsed Pro subscriptions), so
// the validator never answers `rejected` and the card carries no probeRejected
// copy to accidentally show.
// ═══════════════════════════════════════════════════════════════════════════

/** id = the data-testid prefix a driver reaches these controls by. */
const PROVIDER_CARDS = [
  { name: 'OpenGateway', body: ogwCard,     id: 'opengateway', keyId: 'OPENGATEWAY_KEY_ID', validated: false, rejects: false, inputs: 1 },
  { name: 'Venice',      body: veniceCard,  id: 'venice',      keyId: 'VENICE_KEY_ID',      validated: true,  rejects: false, inputs: 1 },
  { name: 'imgnAI',      body: imgnaiCard,  id: 'imgnai',      keyId: 'IMGNAI_KEY_ID',      validated: true,  rejects: true,  inputs: 2 },
  { name: 'Bankr',       body: bankrCard,   id: 'bankr',       keyId: 'BANKR_KEY_ID',       validated: true,  rejects: true,  inputs: 1 },
  { name: 'Surplus',     body: surplusCard, id: 'surplus',     keyId: 'SURPLUS_KEY_ID',     validated: true,  rejects: true,  inputs: 1 },
] as const

describe.each(PROVIDER_CARDS)('$name card — the replace path', (card) => {
  it('offers a Replace trigger, in the STORED branch only', () => {
    const body = card.body()
    expect(body).toContain(`data-testid="${card.id}-replace"`)
    expect(body).toContain("t('keyCard.replace')")
    expect(body).toMatch(/hasStored \?[\s\S]*?-replace"/)
    // It hides itself once the input is open — two ways to open one input is one
        // too many.
    expect(body).toMatch(/\{!replacing && \(\s*<button[\s\S]*?-replace"/)
  })

  it('reveals the SAME input(s), not a second set with their own state', () => {
    const body = card.body()
    expect((body.match(/<input\b/g) ?? []).length).toBe(card.inputs)
    expect(body).toContain('type="password"')
    expect(body).toContain(`data-testid="${card.id}-key"`)
    expect(body).toContain('value={key}')
    // ONE condition, ONE node: nothing stored yet, or a replace in progress.
    expect(body).toContain('{(!hasStored || replacing) && (')
  })

  it('cancels through the shared reset, which is what drops the typed secret', () => {
    const body = card.body()
    expect(body).toContain(`data-testid="${card.id}-cancel-replace"`)
    expect(body).toContain("t('keyCard.cancelReplace')")
    expect(body).toContain('cancelKeyReplace({')
    // Cancel exists only while replacing — a first-time paste has nothing to go
    // back to.
    expect(body).toMatch(/\{replacing && \(\s*<button[\s\S]*?-cancel-replace"/)
  })

  it('explains, while the input is open, what saving will actually do', () => {
    const body = card.body()
    expect(body).toContain(`data-testid="${card.id}-replace-hint"`)
    expect(body).toContain('style={KEY_CARD_REPLACE_HINT}')
  })

  it('reuses the shared secondary-button style rather than a private copy', () => {
    // Replace and Cancel are both neutral: Save owns the accent and Remove owns
    // the destructive red. Two per card.
    expect((card.body().match(/style=\{KEY_CARD_SECONDARY_BTN\}/g) ?? []).length).toBe(2)
  })

  it('leaves Remove exactly as it was — one delete, unconditional', () => {
    const body = card.body()
    expect((body.match(/settings\.deleteKey\(/g) ?? []).length).toBe(1)
    expect(body).toContain(`window.tachi.settings.deleteKey(${card.keyId})`)
    expect(body).toContain("t('keyCard.remove')")
  })

  it('NOTHING DELETES ON THE WAY IN — the save path has no deleteKey at all', () => {
    // This is the property that makes even the unvalidated cards safe: a write
    // that fails or is rejected cannot have destroyed anything, because the only
    // delete in the card lives in `remove`.
    const saveHandler = between(card.body(), 'const save = async', 'const remove = async')
    expect(saveHandler).not.toMatch(/deleteKey/i)
  })

  it('a Remove taken MID-replace closes the input instead of lying', () => {
    const body = card.body()
    const removeHandler = between(body, 'const remove = async', 'const startReplace')
    expect(removeHandler).toContain(`deleteKey(${card.keyId})`)
    expect(removeHandler).toContain('cancelKeyReplace({')
    // The delete still happens FIRST — the reset is cleanup, not a precondition.
    expect(removeHandler.indexOf('deleteKey'))
      .toBeLessThan(removeHandler.indexOf('cancelKeyReplace'))
  })

  it('a successful save closes the replace and clears the box', () => {
    const saveHandler = between(card.body(), 'const save = async', 'const remove = async')
    expect(saveHandler).toContain('setReplacing(false)')
    expect(saveHandler).toContain("setKey('')")
  })

  it('never leaks the typed secret into an attribute or a log', () => {
    const body = card.body()
    expect(body).not.toMatch(/title=\{key/)
    expect(body).not.toMatch(/aria-[a-z]+=\{key\b/)
    expect(body).not.toMatch(/title=\{secret/)
    expect(body).not.toMatch(/console\.(log|warn|error|info|debug)/)
    expect(body).not.toMatch(/type="text"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. VALIDATED vs UNVALIDATED — the split, and the honesty it demands
// ═══════════════════════════════════════════════════════════════════════════

const VALIDATED = PROVIDER_CARDS.filter(c => c.validated)
const UNVALIDATED = PROVIDER_CARDS.filter(c => !c.validated)

describe.each(VALIDATED)('$name — a rejected credential never reaches saveKey', (card) => {
  it('routes through the shared helper, validator named BEFORE the save dep', () => {
    const body = card.body()
    const call = body.indexOf('validateThenStoreKey({')
    expect(call).toBeGreaterThan(-1)
    const validator = body.indexOf('window.tachi.provider.validate')
    expect(validator).toBeGreaterThan(call)
    expect(validator).toBeLessThan(body.indexOf(`window.tachi.settings.saveKey(${card.keyId}`))
    // And the card short-circuits on STORED, not on the probe's ok — an
    // unverified probe wrote the key and must not be treated as a failure.
    expect(body).toMatch(/if \(!res\.stored\) return/)
    expect(body).not.toMatch(/if \(!res\.ok\) return/)
  })

  it('renders the ping\'s answer, including the saved-but-unchecked line', () => {
    const body = card.body()
    expect(body).toContain(`data-testid="${card.id}-probe"`)
    expect(body).toContain('KEY_PROBE_COLOR[keyProbeTone(probe)]')
    // The third outcome exists on every validated card, and the dead
    // "could not check → not saved" copy is gone everywhere.
    expect(body).toMatch(new RegExp(`t\\('${card.id}\\.probeUnverified`))
    expect(body).not.toContain('probeFailed')
  })

  it(card.rejects
    ? 'names the KEPT credential when the provider rejects'
    : 'has NO rejection copy at all — this provider never answers "rejected"', () => {
    const body = card.body()
    if (card.rejects) {
      expect(body).toContain(`t(hasStored ? '${card.id}.probeRejectedKept' : '${card.id}.probeRejected')`)
      expect(body).toMatch(/probe\.verdict === 'rejected'/)
    } else {
      // Venice. Shipping a rejection branch it can never reach would be an
      // invitation to "simplify" the validator into producing one.
      expect(body).not.toContain('probeRejected')
    }
  })

  it('promises the check in its hint, because it actually performs one', () => {
    expect(card.body()).toMatch(/replaceHintChecked/)
  })
})

describe.each(UNVALIDATED)('$name — no validator, and it says so', (card) => {
  it('runs no validateThenStoreKey and renders no probe line', () => {
    const body = card.body()
    expect(body).not.toContain('validateThenStoreKey')
    expect(body).not.toContain(`data-testid="${card.id}-probe"`)
  })

  it('makes exactly ONE keychain write, so a failed write loses nothing', () => {
    const body = card.body()
    expect((body.match(/settings\.saveKey\(/g) ?? []).length).toBe(1)
    expect(body).toContain(`window.tachi.settings.saveKey(${card.keyId}, key.trim())`)
  })

  it('uses the PLAIN hint — it must not imply a check that did not happen', () => {
    const body = card.body()
    expect(body).toContain("t('keyCard.replaceHintPlain')")
    expect(body).not.toContain('replaceHintChecked')
  })

  it('invents no format check to stand in for a validator', () => {
    // A regex over a key's shape proves nothing about whether it works.
    const saveHandler = between(card.body(), 'const save = async', 'const remove = async')
    expect(saveHandler).not.toMatch(/RegExp|startsWith\(|match\(|\/\^/)
  })
})

describe('imgnAI is the two-field case, handled as two fields', () => {
  const body = () => imgnaiCard()

  it('has BOTH inputs, both masked, both reachable', () => {
    expect(body()).toContain('data-testid="imgnai-key"')
    expect(body()).toContain('data-testid="imgnai-secret"')
    expect((body().match(/type="password"/g) ?? []).length).toBe(2)
  })

  it('validates only the PAIR — the one shape /v1/me/balance can judge', () => {
    const b = body()
    expect(b).toContain('const bothHalves =')
    // The validator is handed the two halves separately (main sends them as the
    // X-API-Key / X-API-Secret pair), not the combined string.
    expect(b).toContain('window.tachi.provider.validateImgnaiCredential(k, s)')
    // …and it is only reached when both are present.
    const saveHandler = between(b, 'const save = async', 'const remove = async')
    expect(saveHandler).toMatch(/if \(k && s\) \{[\s\S]*validateThenStoreKey/)
  })

  it('still allows the one-field credential, unvalidated, exactly as before', () => {
    // Text works with the key alone — removing that would be a feature deletion
    // dressed up as a safety fix.
    const saveHandler = between(body(), 'const save = async', 'const remove = async')
    expect(saveHandler).toMatch(/\} else \{[\s\S]*saveKey\(IMGNAI_KEY_ID, k \|\| s\)/)
    // Two writes in the card, and exactly two: the validated pair and the
    // unvalidatable single half. Neither is preceded by a delete (suite 5).
    expect((body().match(/settings\.saveKey\(/g) ?? []).length).toBe(2)
  })

  it('the hint switches on what is typed rather than lying either way', () => {
    expect(body()).toContain("t(bothHalves ? 'imgnai.replaceHintChecked' : 'imgnai.replaceHintPlain')")
  })

  it('drops BOTH fields when the replace is cancelled or the key removed', () => {
    // Half a secret left in a mounted input is still a secret left mounted.
    const b = body()
    expect((b.match(/setSecondValue: setSecret/g) ?? []).length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. i18n for the five — 8 locales
// ═══════════════════════════════════════════════════════════════════════════

const SHARED_KEYS = ['replace', 'cancelReplace', 'replaceHintChecked', 'replaceHintPlain'] as const
/** The three outcomes a rejecting provider can render. */
const PROBE_KEYS = ['probeOk', 'probeRejected', 'probeRejectedKept', 'probeUnverified'] as const
/** Venice never rejects — see the card. It has its own four lines instead. */
const VENICE_KEYS = ['probeOk', 'probeOkLimited', 'probeOkNoAccess', 'probeUnverified', 'probeUnverifiedAuth'] as const

describe('i18n — the shared keyCard strings, every locale', () => {
  for (const lang of LANGS) {
    it(`${lang}: all ${SHARED_KEYS.length} shared keys present and non-empty`, () => {
      const ns = settingsNs(lang)
      for (const key of SHARED_KEYS) {
        const v = ns.keyCard?.[key]
        expect(typeof v, `${lang}/settings:keyCard.${key}`).toBe('string')
        expect(v!.trim(), `${lang}/settings:keyCard.${key}`).not.toBe('')
      }
    })

    it(`${lang}: Replace is not Remove, and the two hints are not each other`, () => {
      const ns = settingsNs(lang)
      // Two adjacent controls, one destructive. Identical labels would be the
      // worst possible outcome of this change.
      expect(ns.keyCard!.replace).not.toBe(ns.keyCard!.remove)
      // The plain hint exists BECAUSE it says something different: nothing was
      // checked. A copy-paste of the checked one would re-introduce the lie.
      expect(ns.keyCard!.replaceHintPlain).not.toBe(ns.keyCard!.replaceHintChecked)
    })

    it(`${lang}: bankr, imgnai and surplus carry all ${PROBE_KEYS.length} probe strings`, () => {
      const ns = settingsNs(lang)
      for (const block of ['bankr', 'imgnai', 'surplus'] as const) {
        for (const key of PROBE_KEYS) {
          const v = ns[block]?.[key]
          expect(typeof v, `${lang}/settings:${block}.${key}`).toBe('string')
          expect(v!.trim(), `${lang}/settings:${block}.${key}`).not.toBe('')
        }
      }
    })

    it(`${lang}: venice carries its own ${VENICE_KEYS.length} lines, and NO rejection copy`, () => {
      const ns = settingsNs(lang)
      const b = ns.venice!
      for (const key of VENICE_KEYS) {
        expect(typeof b[key], `${lang}/settings:venice.${key}`).toBe('string')
        expect(b[key]!.trim(), `${lang}/settings:venice.${key}`).not.toBe('')
      }
      // Its validator cannot produce a rejection, so shipping the words for one
      // would be an invitation to start producing them.
      expect(b.probeRejected, `${lang}/venice.probeRejected`).toBeUndefined()
      expect(b.probeRejectedKept, `${lang}/venice.probeRejectedKept`).toBeUndefined()
      // The 401 line is the LONGER of the two unverified ones: it has to explain
      // what Venice's answer can and cannot mean.
      expect(b.probeUnverifiedAuth!.length).toBeGreaterThan(b.probeUnverified!.length)
    })

    it(`${lang}: the "kept" copy is REWRITTEN, not copied — and the dead keys are gone`, () => {
      const ns = settingsNs(lang)
      for (const block of ['bankr', 'imgnai', 'surplus'] as const) {
        const b = ns[block]!
        expect(b.probeRejectedKept, `${lang}/${block}`).not.toBe(b.probeRejected)
        // …and it is LONGER, because it says strictly more: you still have a
        // working credential.
        expect(b.probeRejectedKept!.length).toBeGreaterThan(b.probeRejected!.length)
        // The unverified line says the OPPOSITE of both: the key WAS written.
        expect(b.probeUnverified).not.toBe(b.probeRejected)
        expect(b.probeUnverified).not.toBe(b.probeRejectedKept)
        expect(b.probeFailed, `${lang}/${block}.probeFailed`).toBeUndefined()
        expect(b.probeFailedKept, `${lang}/${block}.probeFailedKept`).toBeUndefined()
      }
    })

    it(`${lang}: imgnAI's two hints exist and differ`, () => {
      const ns = settingsNs(lang)
      const b = ns.imgnai!
      for (const key of ['replaceHintChecked', 'replaceHintPlain'] as const) {
        expect(b[key]!.trim(), `${lang}/imgnai.${key}`).not.toBe('')
      }
      expect(b.replaceHintChecked).not.toBe(b.replaceHintPlain)
    })

    it(`${lang}: the interpolations survive translation`, () => {
      // A translator who dropped {{balance}} / {{credits}} / {{tier}} would
      // leave the card asserting success with no checkable fact in it.
      const ns = settingsNs(lang)
      expect(ns.bankr!.probeOk,   `${lang}/bankr.probeOk`).toContain('{{balance}}')
      expect(ns.imgnai!.probeOk,  `${lang}/imgnai.probeOk`).toContain('{{credits}}')
      expect(ns.surplus!.probeOk, `${lang}/surplus.probeOk`).toContain('{{tokens}}')
      expect(ns.venice!.probeOk,  `${lang}/venice.probeOk`).toContain('{{tier}}')
      expect(ns.venice!.probeOk,  `${lang}/venice.probeOk`).toContain('{{usd}}')
      expect(ns.venice!.probeOkNoAccess, `${lang}/venice.probeOkNoAccess`).toContain('{{tier}}')
      // The old model-count interpolation is gone with the endpoint it came from.
      expect(ns.bankr!.probeOk, `${lang}/bankr.probeOk`).not.toContain('{{models}}')
    })
  }

  it('the English copy states the two different facts', () => {
    const ns = settingsNs('en')
    expect(ns.keyCard!.replaceHintChecked).toMatch(/stays in force/i)
    expect(ns.keyCard!.replaceHintChecked).toMatch(/nothing changes/i)
    // The hint is read BEFORE Save, so it has to name the third outcome too —
    // otherwise it promises that a failed check leaves the old key in place.
    expect(ns.keyCard!.replaceHintChecked).toMatch(/saved anyway/i)
    expect(ns.imgnai!.replaceHintChecked).toMatch(/saved anyway/i)
    // The plain one promises NOTHING and says why.
    expect(ns.keyCard!.replaceHintPlain).toMatch(/overwrites/i)
    expect(ns.keyCard!.replaceHintPlain).toMatch(/nothing is verified/i)
    for (const block of ['bankr', 'imgnai', 'surplus'] as const) {
      expect(ns[block]!.probeRejectedKept).toMatch(/still stored and in force/i)
      // The unverified line must not borrow either of the rejection's claims.
      expect(ns[block]!.probeUnverified).toMatch(/saved without being checked/i)
      expect(ns[block]!.probeUnverified).not.toMatch(/rejected|not saved/i)
    }
    // imgnAI's hints both state the fact a user cannot otherwise know: the saved
    // secret is not reused, so both fields go together.
    expect(ns.imgnai!.replaceHintChecked).toMatch(/not reused/i)
    expect(ns.imgnai!.replaceHintPlain).toMatch(/not reused/i)
  })

  it('the English Venice copy never tells the user their key is bad', () => {
    // The whole point of the 401-is-not-final decision. This copy is the part a
    // future edit is most likely to "tighten" back into an accusation.
    const v = settingsNs('en').venice!
    expect(v.probeUnverifiedAuth).toMatch(/saved/i)
    expect(v.probeUnverifiedAuth).toMatch(/authentication failed/i)
    // It names BOTH innocent explanations, because those are why we did not
    // reject: an inference-only key, and a lapsed Pro subscription.
    expect(v.probeUnverifiedAuth).toMatch(/inference-only/i)
    expect(v.probeUnverifiedAuth).toMatch(/pro subscription/i)
    expect(v.probeUnverifiedAuth).not.toMatch(/\bnot saved\b|\brejected\b|invalid key/i)
    // And the 403 line accepts the key without claiming a balance it never saw.
    expect(v.probeOkLimited).toMatch(/403/)
    expect(v.probeOkLimited).toMatch(/no balance/i)
  })
})
