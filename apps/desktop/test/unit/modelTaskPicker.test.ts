// apps/desktop/test/unit/modelTaskPicker.test.ts
//
// THE BEGINNER-FACING PICKERS: locality groups on the provider list, task
// groups on the model lists.
//
// Two halves, deliberately:
//   • BEHAVIOUR — run the real resolver from @tachi/core and prove the rules
//     the UI leans on actually hold (an unknown model gets no tags; a model
//     without tool support is never `agentic`). These are not source greps.
//   • WIRING — the pickers themselves cannot be driven in this repo's node-only
//     test setup, so their contract is pinned against the source, the same way
//     chatA11y.test.ts pins the composer's.
//
// The wiring half exists to catch ONE class of regression above all others: a
// model name, a family name or a locality typed into a UI file. Both bugs this
// codebase spent two days deleting (a LOCAL badge over a cloud relay, `:free`
// read as a price) were a claim asserted in a component instead of derived.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveTaskTags, recommendModels, isOfferableFor } from '../../../../packages/core/src/models/resolve-task-tags'
import { TASK_TAGS, PRICE_BANDS } from '../../../../packages/core/src/models/task-tags'
import { providerLocality } from '../../../../packages/core/src/providers/registry'
import { resolveContextWindow } from '../../../../packages/core/src/tachi/models'
import { formatContextSuffix } from '../../src/store/modelWindow.store'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const CHAT = 'src/pages/chat'
const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

/** Drop comments so an assertion about CODE is never satisfied by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function ns(lang: string, name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, `${name}.json`), 'utf8')) as Record<string, unknown>
}

function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

// The five catalog-backed pickers the shared list now serves. The Code tab
// mounts four of these same components, so fixing them fixed it too.
const CATALOG_PICKERS = [
  ['BankrModelPicker.tsx', 'bankr-gateway'],
  ['VeniceModelPicker.tsx', 'venice'],
  ['SurplusModelPicker.tsx', 'surplus'],
  ['ImgnaiModelPicker.tsx', 'imgnai'],
  ['OpenRouterModelPicker.tsx', 'openrouter-oauth'],
] as const

// A user-added endpoint has no registry id, so its provider id is a prop.
// Wired for the same reasons, checked separately.
const CUSTOM_PICKER = 'CustomModelPicker.tsx'

// ── BEHAVIOUR: the rules the UI is allowed to lean on ─────────────────────────

describe('the resolver refuses to guess, so the picker cannot show a guess', () => {
  it('a model nobody has ever heard of gets ZERO tags', () => {
    const res = resolveTaskTags({ id: 'acme/totally-made-up-model-9000', providerId: 'bankr-gateway' })
    expect(res.tags).toEqual([])
    expect(res.capabilityMatch).toBeNull()
  })

  it('an id that merely CONTAINS a task word earns nothing from that word', () => {
    // The forbidden derivation, stated as a test: "coder" in a name is a name.
    const res = resolveTaskTags({ id: 'acme/super-coder-pro', providerId: 'bankr-gateway' })
    expect(res.tags).not.toContain('coding')
  })

  it('a live catalog row that lists no tools vetoes `agentic`', () => {
    const res = resolveTaskTags({
      id: 'claude-opus-5',
      providerId: 'bankr-gateway',
      live: { capabilities: ['text'] },
    })
    expect(res.tags).not.toContain('agentic')
  })

  it('every tag the resolver emits carries a reason — the picker prints it', () => {
    const res = resolveTaskTags({ id: 'claude-opus-5', providerId: 'bankr-gateway' })
    expect(res.tags.length).toBeGreaterThan(0)
    for (const tag of res.tags) expect(typeof res.reasons[tag]).toBe('string')
  })

  it('the filtered view is a filter, not a top-5 teaser: limit = the catalog', () => {
    // recommendModels defaults to 5. The picker passes the whole catalog, so a
    // task group can never quietly hide its sixth member.
    // Every id here must genuinely carry the tag — this test is about the
    // LIMIT, not about who codes. (claude-opus-4.8 used to be in this list and
    // was removed when a first-party re-read found no coding claim for it.)
    const coding = ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4.6',
                    'poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1:free',
                    'cohere/north-mini-code:free']
    const cands = coding.map(id => ({ id, providerId: 'bankr-gateway' }))
    expect(cands.every(c => resolveTaskTags(c).tags.includes('coding'))).toBe(true)
    expect(recommendModels('coding', cands, {}, { limit: cands.length }).length).toBe(coding.length)
    expect(recommendModels('coding', cands).length).toBe(5)   // the default that must NOT be used
  })
})

describe('locality is derived from egress, never from the word in a name', () => {
  it('the relay is its own class — not local, not plain cloud', () => {
    expect(providerLocality('freellmapi-local')).toBe('relay')
    expect(providerLocality('free-claude-code')).toBe('relay')
  })
  it('only truly-offline engines are local', () => {
    expect(providerLocality('ollama-local')).toBe('local')
    expect(providerLocality('llama-cpp')).toBe('local')
  })
  it('an id we cannot look up claims nothing', () => {
    expect(providerLocality('who-knows')).toBe('cloud')
  })
})

// ── WIRING: the shared list ───────────────────────────────────────────────────

describe('TaskGroupedModelList is the only place a task group is decided', () => {
  const src = () => read(`${CHAT}/TaskGroupedModelList.tsx`)

  it('derives every tag from the core resolver, never from a local rule', () => {
    const s = src()
    expect(s).toContain("from '@tachi/core/src/models/resolve-task-tags'")
    expect(s).toContain('resolveTaskTags({ id: m.id, providerId, live: liveFactsOf(m) })')
    expect(s).toContain('recommendModels(')
  })

  it('names NO model and NO family — that is the drift class', () => {
    const code = stripComments(src()).toLowerCase()
    for (const word of ['claude', 'sonnet', 'opus', 'gpt-', 'gemini', 'llama', 'qwen', 'deepseek', 'mistral', 'grok']) {
      expect(code, `TaskGroupedModelList must not name ${word}`).not.toContain(word)
    }
  })

  it('has no "other"/"general" catch-all group — an unclassified model is not a claim', () => {
    const code = stripComments(src()).toLowerCase()
    expect(code).not.toContain("'other'")
    expect(code).not.toContain("'ungrouped'")
    expect(code).not.toContain("'general'")
  })

  it('renders no chips at all for a model with no tags', () => {
    expect(src()).toContain('if (tags.length === 0) return null')
  })

  it('only offers a task filter for tags something actually carries', () => {
    expect(src()).toContain('TASK_TAGS.filter(tg => counts[tg] > 0)')
  })

  it('keeps the model id on the row — experts navigate by it', () => {
    expect(src()).toContain('{showId && m.id}')
  })

  it('real group semantics: role=group + a label, and the visual header hidden', () => {
    const s = src()
    expect(s).toContain('role="group" aria-label={g.label || listLabel}')
    expect(s).toContain('<div aria-hidden="true" style={headerStyle}>{g.label}</div>')
  })

  it('the listbox is named and contains ONLY options and groups', () => {
    const s = src()
    expect(s).toContain('role="listbox"')
    expect(s).toContain('aria-label={listLabel}')
    // The filter strip is a sibling of the listbox, never a child of it: a
    // listbox may only own options and groups.
    expect(s.indexOf("aria-label={t('chat:picker.taskFilterAria')}")).toBeLessThan(s.indexOf('role="listbox"'))
  })

  it('is keyboard-walkable: roving tabindex + arrow / Home / End', () => {
    const s = src()
    expect(s).toContain('tabIndex={idx === selectedIdx ? 0 : -1}')
    expect(s).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']")
  })

  it('uses the i18n key scheme the taxonomy fixed (providers:taskTags.*)', () => {
    const s = src()
    expect(s).toContain('providers:taskTags.${tag}.label')
    expect(s).toContain('providers:taskTags.${tag}.blurb')
  })
})

// ── A COUNT THAT AGREES WITH ITS OWN LIST ────────────────────────────────────
//
// The chip said `READS IMAGES 24`; the filtered list rendered 23 rows, verified
// by scrolling the whole list. The chip counted every model whose tags included
// the tag; the list was `recommendModels`, which ADDITIONALLY refuses a
// not-a-general-chat model. Both halves were right. Having two functions answer
// one question was the defect — the same shape as the relay card's "12 / 16".
describe('the task chip counts exactly what the list will render', () => {
  const GUARDRAIL = 'nvidia/nemotron-3.5-content-safety:free'
  const providerId = 'openrouter-oauth'
  // The live capability that earns it `vision`: NVIDIA's own multimodal
  // guardrail really does read images.
  const live = { capabilities: ['vision'] as const }

  it('the model behind the missing row is tagged AND withheld — both on purpose', () => {
    const res = resolveTaskTags({ id: GUARDRAIL, providerId, live })
    expect(res.tags).toContain('vision')
    expect(res.notGeneralChat).toBeTruthy()
    expect(isOfferableFor(res, 'vision')).toBe(false)
  })

  it('the count and the rendered rows are the same number, tag by tag', () => {
    const catalog = [
      { id: GUARDRAIL, providerId, live },
      { id: 'anthropic/claude-opus-5', providerId, live },
      { id: 'moonshotai/kimi-k3', providerId, live },
    ]
    for (const tag of TASK_TAGS) {
      // What the chip prints (TaskGroupedModelList's `counts`).
      const counted = catalog.filter(c => isOfferableFor(resolveTaskTags(c), tag)).length
      // What the list renders, from the whole catalog — a filter, not a top-5.
      const rendered = recommendModels(tag, catalog, {}, { limit: catalog.length }).length
      expect(counted, `chip vs list disagree on ${tag}`).toBe(rendered)
    }
  })

  it('the OLD count was high on every tag the withheld model carries — not just vision', () => {
    // Four chips were over by one from this single row: it is tagged everyday,
    // long-context, vision and free.
    const res = resolveTaskTags({ id: GUARDRAIL, providerId, live })
    const overCounted = res.tags.filter(t => !isOfferableFor(res, t))
    expect(overCounted).toEqual(res.tags)
    expect(overCounted).toContain('vision')
    expect(overCounted.length).toBeGreaterThan(1)
  })

  it('the picker counts through the shared predicate, not through res.tags', () => {
    const s = read(`${CHAT}/TaskGroupedModelList.tsx`)
    expect(s).toContain('isOfferableFor')
    expect(s).toContain('if (isOfferableFor(f, tg)) c[tg] += 1')
    // The old line, which counted what the list would not show.
    expect(stripComments(s)).not.toContain('for (const tg of f.tags) c[tg] += 1')
  })
})

// ── THE ctx SUFFIX ───────────────────────────────────────────────────────────
//
// OpenRouter rows printed `· 1049k ctx`; Venice, Bankr and Surplus rows printed
// nothing — although all three services have carried the gateway's own window
// since 2026-08-02 and their renderer types simply never declared the field.
//
// Fixing that left a subtler seam, found the same day. Each picker formatted the
// window IT had fetched, which is a stricter definition of "known" than the one
// every other surface uses: for `glm-5-2` on imgnAI the picker printed nothing
// while the chat chip and the CODE meter drew `0% of 1,000,000 tokens` in a
// green zone off a sourced row in our own catalog. So the suffix is no longer
// built by a picker at all — the shared list resolves it, from the same store
// and the same resolver every other surface reads.
describe('every picker prints the window RESOLVED for the row — with its source', () => {
  const win = (tokens: number, source: 'live' | 'catalog' | 'family-estimate' | 'assumed') =>
    ({ tokens, source, known: source === 'live' || source === 'catalog' })

  it('a live number is printed bare; anything else names who supplied it', () => {
    expect(formatContextSuffix(win(200_000, 'live'))).toBe(' · 200k ctx')
    expect(formatContextSuffix(win(1_049_000, 'live'))).toBe(' · 1049k ctx')
    // The glm-5-2 row: the same number the meter shows, and now visibly ours.
    expect(formatContextSuffix(win(1_000_000, 'catalog'))).toBe(' · 1000k ctx (catalog)')
  })

  it('a window that is not known prints nothing at all', () => {
    expect(formatContextSuffix(win(32_000, 'family-estimate'))).toBeNull()
    expect(formatContextSuffix(win(32_000, 'assumed'))).toBeNull()
    for (const bad of [undefined, null, win(0, 'live'), win(Number.NaN, 'catalog')]) {
      expect(formatContextSuffix(bad as never), String(bad)).toBeNull()
    }
  })

  it('no picker formats a window of its own — the shared list resolves every row', () => {
    for (const file of ['VeniceModelPicker.tsx', 'BankrModelPicker.tsx', 'SurplusModelPicker.tsx', 'OpenRouterModelPicker.tsx', 'ImgnaiModelPicker.tsx']) {
      const s = stripComments(read(`${CHAT}/${file}`))
      expect(s, file).not.toContain('formatContextSuffix')
      expect(s, file).not.toContain('metaSuffix')
    }
    const list = stripComments(read(`${CHAT}/TaskGroupedModelList.tsx`))
    expect(list).toContain('useContextWindowResolver(providerId)')
    expect(list).toContain('formatContextSuffix(ctx)')
    // The suffix's own tooltip says it in full, so `(catalog)` is never a
    // three-letter word the user has to guess at.
    expect(list).toContain('contextWindowTitle(ctx)')
  })

  it('the four pickers still publish only LIVE rows as tag evidence', () => {
    // Display and evidence stay different questions: a hand-written fallback row
    // must never be laundered into "the provider's own live catalog lists…".
    for (const file of ['VeniceModelPicker.tsx', 'BankrModelPicker.tsx', 'SurplusModelPicker.tsx', 'OpenRouterModelPicker.tsx']) {
      expect(read(`${CHAT}/${file}`), file).toContain("m.live && typeof m.contextTokens === 'number'")
    }
  })

  it('imgnAI now prints what we DO know, instead of the silence that started this', () => {
    // imgnai-service reads no window from that gateway — but our catalog has
    // sourced rows for its ids (kat.imgnai.com llms.txt, dated), and the chip
    // was already drawing a percentage from them. Same list component, so the
    // picker answers with the same number and marks it `(catalog)`.
    expect(read(`${CHAT}/ImgnaiModelPicker.tsx`)).toContain('providerId="imgnai"')
    expect(formatContextSuffix(resolveContextWindow('glm-5-2'))).toBe(' · 1000k ctx (catalog)')
  })
})

// ── WIRING: the price axis ────────────────────────────────────────────────────

describe('price is a SECOND axis, and the file keeps it separate from the tags', () => {
  const src = () => read(`${CHAT}/TaskGroupedModelList.tsx`)

  it('reads the band and the rate from the core resolver, never from a local rule', () => {
    const s = src()
    // No threshold, no dollar comparison and no rate table may live here.
    expect(s).toContain("formatUsdPerM,")
    expect(s).toContain('facts?.priceBand ?? null')
    expect(s).toContain('facts?.price ?? null')
    const code = stripComments(s)
    expect(code).not.toContain('ratesFor')
    expect(code).not.toMatch(/inPerM\s*[<>]=?/)   // no threshold arithmetic in the UI
  })

  it('resolves ONCE per model, so the tags and the price describe the same evidence', () => {
    const s = src()
    expect(s).toContain('resolveTaskTags({ id: m.id, providerId, live: liveFactsOf(m) })')
    // …and the row reads both halves out of that one result.
    expect(s).toContain('const facts = factsById.get(m.id)')
  })

  it('renders NOTHING when the price cannot be proven', () => {
    expect(src()).toContain('if (!price || !band) return null')
  })

  it('always prints the actual rate beside the band — the band is a summary, the number is the fact', () => {
    const s = src()
    expect(s).toContain("t('chat:picker.priceRate'")
    expect(s).toContain('formatUsdPerM(price.inPerM)')
    expect(s).toContain('formatUsdPerM(price.outPerM)')
  })

  it('uses the i18n key scheme the vocabulary fixed (providers:priceBands.*)', () => {
    const s = src()
    expect(s).toContain('providers:priceBands.${band}.label')
    expect(s).toContain('providers:priceBands.${band}.blurb')
  })

  it('price did NOT become more chips in the task strip — the strip still maps TASK_TAGS only', () => {
    const s = src()
    // The one place chips are generated stays keyed on the closed tag set
    // (eight since 2026-08-02 — `frontier` joined as a TAG, derived in core
    // from the premium band). If price BANDS ever appear in that map, the
    // strip has grown into the wall of chips the design rejected, and two
    // different questions now share one control.
    expect(s).toContain('TASK_TAGS.filter(tg => counts[tg] > 0)')
    expect(s).not.toContain('PRICE_BANDS.filter')
    expect(s).not.toContain('PRICE_BANDS.map')
  })

  it('the price line lives on the meta line, under the name, beside the id', () => {
    const s = src()
    expect(s).toContain('{(showId || band) && (')
    expect(s).toContain('{showId && m.id}')
    expect(s).toContain('<PriceNote price={price} band={band} />')
  })

  it('still names NO model and NO family, price or not', () => {
    const code = stripComments(src()).toLowerCase()
    for (const word of ['claude', 'sonnet', 'opus', 'haiku', 'gpt-', 'gemini', 'llama', 'qwen', 'deepseek']) {
      expect(code, `must not name ${word}`).not.toContain(word)
    }
    // …and no hard-coded price either. A number typed here is a claim asserted
    // in a component, which is the exact class of bug this file was built to
    // stop (a LOCAL badge over a relay; `:free` read as a price).
    expect(code).not.toMatch(/\$\d/)
  })
})

describe('every catalog picker delegates to the shared list', () => {
  for (const [file, providerId] of CATALOG_PICKERS) {
    it(`${file} renders TaskGroupedModelList for ${providerId}`, () => {
      const s = read(`${CHAT}/${file}`)
      expect(s).toContain("from './TaskGroupedModelList'")
      expect(s).toContain('<TaskGroupedModelList')
      expect(s).toContain(`providerId="${providerId}"`)
    })

    it(`${file} no longer hand-rolls option rows or a bare listbox`, () => {
      const s = stripComments(read(`${CHAT}/${file}`))
      expect(s).not.toContain('role="option"')
      // role="listbox" now lives inside the shared list, on the element that
      // really holds the options — not on the popover shell.
      expect(s).not.toContain('role="listbox"')
    })

    it(`${file} keeps aria-haspopup on its trigger`, () => {
      expect(read(`${CHAT}/${file}`)).toContain('aria-haspopup="listbox"')
    })
  }

  it('Venice forwards only vision/tools from its live caps — never its "code" flag', () => {
    const s = read(`${CHAT}/VeniceModelPicker.tsx`)
    expect(s).toContain("c === 'vision' || c === 'tools'")
    // 'code' is a boolean from Venice's catalog; `coding` is a curated, dated
    // citation. Turning one into the other would be the whole taxonomy undone.
    expect(stripComments(s)).not.toContain("'code'")
    // …and nothing is forwarded from a fallback row.
    expect(s).toContain('if (!m.live')
  })

  it(`${CUSTOM_PICKER} uses the shared list and moved its text input OUT of the listbox`, () => {
    const s = read(`${CHAT}/${CUSTOM_PICKER}`)
    expect(s).toContain('<TaskGroupedModelList')
    expect(s).toContain('providerId={providerId}')
    // The manual "type a model id" input is the fail-open path and must stay —
    // but a textbox is not a valid child of a listbox, and now it isn't one.
    expect(s).toContain("t('customEndpoint.modelPlaceholder'")
    expect(stripComments(s)).not.toContain('role="listbox"')
  })

  it('a row whose label IS its id does not print the id twice', () => {
    // The condition now also lets a row through on price alone: a bare custom
    // endpoint we CAN price shows its rate with no id line above it.
    const s = read(`${CHAT}/TaskGroupedModelList.tsx`)
    expect(s).toContain('const showId = m.label !== m.id || !!ctxSuffix')
    expect(s).toContain('{(showId || band) && (')
  })

  it('OpenRouter forwards a price only for rows the LIVE catalog priced', () => {
    // 2026-08-02: paid rows now forward their live rate too. Before this, only
    // the $0 rows carried a price, so 281 of 337 rows showed no band at all —
    // not because the price was unknown, but because the service kept the
    // derived boolean and discarded the numbers it came from.
    const s = read(`${CHAT}/OpenRouterModelPicker.tsx`)
    expect(s).toContain('m.live && m.free')
    expect(s).toContain('{ pricing: { inUsdPerMTok: 0, outUsdPerMTok: 0 } }')
    expect(s).toContain('m.live && m.rates')
    expect(s).toContain('inUsdPerMTok: m.rates.inputPerM')
    expect(s).toContain('outUsdPerMTok: m.rates.outputPerM')
    expect(s).toContain('...(m.live && typeof m.contextTokens === \'number\'')
  })

  it('OpenRouter never forwards a price for a row that is not live', () => {
    // THE TRAP: the curated fallback in openrouter-service.ts lists 14 free rows
    // with a STATIC `free: true`. Those must never gain a fabricated rate — a
    // live-catalog claim over a hand-written row is exactly the bug class this
    // file exists to stop. Every price branch is gated on `m.live`.
    const code = stripComments(read(`${CHAT}/OpenRouterModelPicker.tsx`))
    const pricingBranches = code.match(/pricing:\s*\{/g) ?? []
    expect(pricingBranches.length).toBeGreaterThan(0)
    // No `pricing:` may appear without an `m.live` guard in the same expression.
    for (const seg of code.split('pricing: {').slice(0, -1))
      expect(seg.slice(-120)).toContain('m.live')
  })
})

// ── WIRING: the provider picker ───────────────────────────────────────────────

describe('ProviderPicker groups by locality', () => {
  const src = () => read(`${CHAT}/ProviderPicker.tsx`)

  it('the three groups are local → relay → cloud, in that order', () => {
    expect(src()).toContain("const LOCALITY_GROUP_ORDER: readonly ProviderLocality[] = ['local', 'relay', 'cloud']")
  })

  it('group membership comes from providerLocality / localityOf, never from tier', () => {
    const s = src()
    expect(s).toContain('p.custom')
    expect(s).toContain('localityOf({ tier:')
    expect(s).toContain(': providerLocality(p.id)')
    // The one comparison on `tier` that remains is inside localityOf's own
    // argument, mapping the custom endpoint's field onto the descriptor shape.
    expect(s).toContain('GROUPING ONLY')
  })

  it('each group is a real, labelled group with its header hidden from AT', () => {
    const s = src()
    expect(s).toContain('role="group" aria-label={t(`provider.localityGroup.${loc}`)}')
    expect(s).toContain('<div aria-hidden="true" style={{')
  })

  it('the group note reuses the badge tooltip copy, so the two cannot disagree', () => {
    expect(src()).toContain('{t(`provider.locality.${loc}.title`)}')
  })

  it('the listbox is named and no longer sits on the popover shell', () => {
    const s = src()
    expect(s).toContain('role="listbox" aria-label={t(\'provider.listAria\')}')
    expect((s.match(/role="listbox"/g) ?? []).length).toBe(1)
  })

  it('the badges stay — the layout explains first, the chip still carries the claim', () => {
    const s = src()
    expect(s).toContain('<EgressChip providerId={p.id} />')
    expect(s).toContain('<LocalityChip egress={p.egress ?? \'cloud\'} />')
  })
})

describe('the empty-handed newcomer is answered on the first screen', () => {
  const src = () => read(`${CHAT}/ProviderPicker.tsx`)

  it('counts the keyless routes from requiresKey rather than asserting a number', () => {
    const s = src()
    expect(s).toContain('const keylessCount = visibleOptions.filter(p => !p.requiresKey).length')
    expect(s).toContain("t('provider.readyNow', { count: keylessCount, total: visibleOptions.length })")
  })

  it('marks the keyless rows so they can be found without reading every hint', () => {
    expect(src()).toContain("{!p.requiresKey && (")
    expect(src()).toContain("t('provider.noKeyBadge')")
  })

  it('AUTO shows the route it would ACTUALLY take, from the send path\'s own functions', () => {
    const s = src()
    expect(s).toContain("import { gatherAutoModelInputs } from './autoModelGather'")
    expect(s).toContain('const picked = resolveAutoModel(input)')
    expect(s).toContain("t('provider.autoRouteNow'")
    // Null until resolved: an unresolved route claims nothing.
    expect(s).toContain('{autoRoute && (')
  })

  it('the resolved route respects private mode, like the send path does', () => {
    expect(src()).toContain('{ privateMode },')
  })
})

// ── i18n parity ───────────────────────────────────────────────────────────────

describe('the taxonomy copy ships in all 8 locales', () => {
  for (const lang of LANGS) {
    it(`${lang}/providers.json carries a label + blurb for every shipped tag`, () => {
      const p = ns(lang, 'providers')
      for (const tag of TASK_TAGS) {
        for (const field of ['label', 'blurb']) {
          const v = lookup(p, `taskTags.${tag}.${field}`)
          expect(typeof v, `${lang} taskTags.${tag}.${field}`).toBe('string')
          expect((v as string).trim().length, `${lang} taskTags.${tag}.${field}`).toBeGreaterThan(0)
        }
      }
    })
  }

  it('covers exactly the shipped tags — no locale invents an extra group', () => {
    for (const lang of LANGS) {
      const block = lookup(ns(lang, 'providers'), 'taskTags') as Record<string, unknown>
      expect(Object.keys(block).sort(), lang).toEqual([...TASK_TAGS].sort())
    }
  })
})

describe('the price band copy ships in all 8 locales', () => {
  for (const lang of LANGS) {
    it(`${lang}/providers.json carries a label + blurb for every one of the four bands`, () => {
      const p = ns(lang, 'providers')
      for (const band of PRICE_BANDS) {
        for (const field of ['label', 'blurb']) {
          const v = lookup(p, `priceBands.${band}.${field}`)
          expect(typeof v, `${lang} priceBands.${band}.${field}`).toBe('string')
          expect((v as string).trim().length, `${lang} priceBands.${band}.${field}`).toBeGreaterThan(0)
        }
      }
    })
  }

  it('covers exactly the four shipped bands — no locale invents a fifth', () => {
    for (const lang of LANGS) {
      const block = lookup(ns(lang, 'providers'), 'priceBands') as Record<string, unknown>
      expect(Object.keys(block).sort(), lang).toEqual([...PRICE_BANDS].sort())
    }
  })

  it('every translated label still fits the row it is printed on', () => {
    for (const lang of LANGS) {
      for (const band of PRICE_BANDS) {
        const label = String(lookup(ns(lang, 'providers'), `priceBands.${band}.label`))
        expect(label.length, `${lang} ${band}: "${label}"`).toBeLessThanOrEqual(30)
      }
    }
  })

  it('no locale translated the band into a QUALITY claim', () => {
    // The English labels name money and only money (pinned in the core suite).
    // A translator reaching for "Premium" / "Flagship" would quietly turn a
    // price statement into a capability one, which nothing here can back.
    for (const lang of LANGS) {
      for (const band of PRICE_BANDS) {
        const label = String(lookup(ns(lang, 'providers'), `priceBands.${band}.label`)).toLowerCase()
        for (const word of ['premium', 'flagship', 'frontier']) {
          expect(label, `${lang} ${band}`).not.toContain(word)
        }
      }
    }
  })

  it('the rate string keeps BOTH numbers in every locale', () => {
    // A locale that dropped {{out}} would print an input rate as if it were the
    // whole price — the cheapest possible way to understate a bill by 5x.
    for (const lang of LANGS) {
      const chat = ns(lang, 'chat')
      for (const key of ['picker.priceRate', 'picker.priceFree']) {
        const v = lookup(chat, key)
        expect(typeof v, `${lang} ${key}`).toBe('string')
        expect((v as string).trim().length, `${lang} ${key}`).toBeGreaterThan(0)
      }
      const rate = String(lookup(chat, 'picker.priceRate'))
      expect(rate, `${lang} picker.priceRate`).toContain('{{in}}')
      expect(rate, `${lang} picker.priceRate`).toContain('{{out}}')
    }
  })
})

describe('the new picker strings ship in all 8 locales', () => {
  const KEYS = [
    'provider.localityGroup.local',
    'provider.localityGroup.relay',
    'provider.localityGroup.cloud',
    'provider.listAria',
    'provider.noKeyBadge',
    'provider.readyNow',
    'provider.autoRouteNow',
    'picker.listAria',
    'picker.taskFilterAria',
    'picker.taskAll',
    'picker.taskAllTitle',
    'picker.taskEmpty',
  ]

  for (const lang of LANGS) {
    it(`${lang}/chat.json carries every new key, non-empty`, () => {
      const chat = ns(lang, 'chat')
      for (const key of KEYS) {
        const v = lookup(chat, key)
        expect(typeof v, `${lang} ${key}`).toBe('string')
        expect((v as string).trim().length, `${lang} ${key}`).toBeGreaterThan(0)
      }
    })
  }

  it('keeps every interpolation placeholder in every locale', () => {
    const withVars: Array<[string, string[]]> = [
      ['provider.readyNow', ['{{count}}', '{{total}}']],
      ['provider.autoRouteNow', ['{{provider}}', '{{model}}']],
    ]
    for (const lang of LANGS) {
      const chat = ns(lang, 'chat')
      for (const [key, tokens] of withVars) {
        for (const token of tokens) {
          expect(String(lookup(chat, key)), `${lang} ${key}`).toContain(token)
        }
      }
    }
  })
})
