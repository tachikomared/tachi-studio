// apps/desktop/test/unit/chatContextWindow.test.ts
//
// THE RULE: the composer and the picker report the SAME window for the same
// model, and neither invents one for a model with no published window.
//
// c356307 made capability resolution honest, but only the picker was rewired.
// The chat CTX chip kept a per-PROVIDER table, so on the packaged build of
// 2026-08-02 a driver read, in one session:
//
//   picker  — "Kimi K3 · 1049k ctx",  "Sonnet 4.6 · 1000k ctx"
//   chip    — "Context: 0% of 128,000 tokens" for both, and 32,000 for every
//             Venice model including the 200k one the owner actually uses
//
// Two surfaces, one model, two numbers, and the wrong one was under the cursor.
// These tests pin the join: one recording of the provider's catalog, one
// resolver, and a display rule that prints nothing rather than a guess.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveContextWindow } from '@tachi/core'
import {
  useModelWindowStore, contextWindowFor, publishedContextTokens,
  describeContextUsage, modelWindowKey, formatContextSuffix, contextUsageTitle,
} from '../../src/store/modelWindow.store'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, 'apps', 'desktop', ...p), 'utf8')

/**
 * Drop comments, so an assertion about CODE is never satisfied — or broken — by
 * prose. Every file below documents the constant it stopped using, by name.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const readCode = (...p: string[]) => stripComments(read(...p))

beforeEach(() => { useModelWindowStore.setState({ windows: {} }) })

describe('only a LIVE row may claim the provider published it', () => {
  // The half nobody gated. Every picker already filters its TAG evidence on
  // `m.live`, but handed `res.models` wholesale to recordCatalogWindows —
  // fallback rows included. Downstream, resolveContextWindow reports anything
  // in this store with `source: 'live'`, so an unreachable gateway made every
  // surface say "published by this provider's own catalog" about a number one
  // of us typed into a service file.
  it('drops a row the service marked live:false', () => {
    useModelWindowStore.getState().recordCatalogWindows('bankr-gateway', [
      { id: 'live-row', contextTokens: 200_000, live: true },
      { id: 'fallback-row', contextTokens: 999_999, live: false },
    ])
    expect(contextWindowFor('bankr-gateway', 'live-row').source).toBe('live')
    // The fallback number never entered the store, so the resolver answers from
    // the static rows and says so — or says nothing.
    expect(contextWindowFor('bankr-gateway', 'fallback-row').source).not.toBe('live')
  })

  it('accepts a row that does not declare liveness at all', () => {
    // `undefined` is a caller that genuinely cannot tell; only an explicit
    // `false` is a claim we refuse.
    useModelWindowStore.getState().recordCatalogWindows('venice', [
      { id: 'unsure-row', contextTokens: 131_072 },
    ])
    expect(contextWindowFor('venice', 'unsure-row').tokens).toBe(131_072)
  })

  it('is enforced in the STORE, so a fifth picker cannot forget', () => {
    const src = readCode('src/store/modelWindow.store.ts')
    expect(src).toContain('if (r.live === false) continue')
  })
})

describe('the published window is what both surfaces read', () => {
  it('the provider\'s number beats the static row — the picker\'s 1049k is the chip\'s 1049k', () => {
    // Exactly what OpenRouterModelPicker records, and exactly what its
    // "· 1049k ctx" suffix is rendered from.
    useModelWindowStore.getState().recordCatalogWindows('openrouter-oauth', [
      { id: 'moonshotai/kimi-k3', contextTokens: 1_049_000 },
      { id: 'anthropic/claude-sonnet-4.6', contextTokens: 1_000_000 },
    ])
    const kimi = contextWindowFor('openrouter-oauth', 'moonshotai/kimi-k3')
    expect(kimi.tokens).toBe(1_049_000)
    expect(kimi.known).toBe(true)
    // The number the picker prints: Math.round(tokens / 1000) + 'k'.
    expect(`${Math.round(kimi.tokens / 1000)}k`).toBe('1049k')
    // …and NOT the per-provider constant that used to answer here.
    expect(kimi.tokens).not.toBe(128_000)
    expect(contextWindowFor('openrouter-oauth', 'anthropic/claude-sonnet-4.6').tokens).toBe(1_000_000)
  })

  it('the window is per MODEL: two models of one provider do not share a number', () => {
    useModelWindowStore.getState().recordCatalogWindows('venice', [
      { id: 'olafangensan-glm-4.7-glash-heretic', contextTokens: 200_000 },
      { id: 'e2ee-qwen-2-5-7b-p', contextTokens: 32_768 },
    ])
    expect(contextWindowFor('venice', 'olafangensan-glm-4.7-glash-heretic').tokens).toBe(200_000)
    expect(contextWindowFor('venice', 'e2ee-qwen-2-5-7b-p').tokens).toBe(32_768)
  })

  it('the window is per PROVIDER too: same model name, different servings', () => {
    useModelWindowStore.getState().recordCatalogWindows('venice',  [{ id: 'deepseek-v4-pro', contextTokens: 131_072 }])
    useModelWindowStore.getState().recordCatalogWindows('imgnai',  [{ id: 'deepseek-v4-pro', contextTokens: 1_000_000 }])
    expect(contextWindowFor('venice', 'deepseek-v4-pro').tokens).toBe(131_072)
    expect(contextWindowFor('imgnai', 'deepseek-v4-pro').tokens).toBe(1_000_000)
  })

  it('a row that publishes nothing records nothing — no zero, no default', () => {
    useModelWindowStore.getState().recordCatalogWindows('venice', [
      { id: 'quiet-model' },
      { id: 'zero-model', contextTokens: 0 },
      { id: 'junk-model', contextTokens: Number.NaN },
    ])
    expect(useModelWindowStore.getState().windows).toEqual({})
    for (const id of ['quiet-model', 'zero-model', 'junk-model']) {
      expect(publishedContextTokens('venice', id), id).toBeUndefined()
      // …and the resolver then reports the weaker source honestly.
      expect(contextWindowFor('venice', id).known, id).toBe(false)
    }
  })

  it('is keyed case-insensitively, because ids arrive cased however the gateway feels', () => {
    useModelWindowStore.getState().recordCatalogWindows('Venice', [{ id: 'Mistral-31-24B', contextTokens: 131_072 }])
    expect(publishedContextTokens('venice', 'mistral-31-24b')).toBe(131_072)
    expect(modelWindowKey('VENICE', 'X')).toBe(modelWindowKey('venice', 'x'))
  })

  it('with nothing recorded it degrades to the same resolver the picker uses', () => {
    for (const id of ['claude-opus-5', 'llama-3.3-70b', 'nobody-has-heard-of-this']) {
      expect(contextWindowFor('venice', id), id).toEqual(resolveContextWindow(id))
    }
  })
})

describe('what a meter may claim', () => {
  it('prints a percentage ONLY against a known window', () => {
    const known = describeContextUsage(400_000, { tokens: 200_000, source: 'live', known: true })
    expect(known).toEqual({ tokens: 100_000, pct: 50, windowTokens: 200_000 })
  })

  it('an unknown window yields NO percentage and NO window — the 32k lie has no path back', () => {
    // The assumed budget is still a usable number for the loop (tokens: 32000),
    // and it still must not reach the screen as this model's window.
    const assumed = resolveContextWindow('nobody-has-heard-of-this')
    expect(assumed.tokens).toBe(32_000)
    expect(assumed.known).toBe(false)

    const usage = describeContextUsage(120_000, assumed)
    expect(usage.pct).toBeNull()
    expect(usage.windowTokens).toBeNull()
    expect(usage.tokens).toBe(30_000)   // chars/4, the only measured thing here
  })

  it('a family estimate is not evidence about the model either', () => {
    const family = resolveContextWindow('llama-3.3-70b-instruct')
    expect(family.known).toBe(false)
    expect(describeContextUsage(1000, family).windowTokens).toBeNull()
  })

  it('caps at 100% instead of reporting 140% full', () => {
    expect(describeContextUsage(4 * 300_000, { tokens: 200_000, source: 'live', known: true }).pct).toBe(100)
  })
})

describe('the surfaces are wired to that one source', () => {
  const topbar    = read('src', 'components', 'layout', 'PageTopbar.tsx')
  const chatPage  = read('src', 'pages', 'chat', 'ChatPage.tsx')
  const chatSvc   = read('electron', 'services', 'chat-service.ts')
  const inputBar  = read('src', 'pages', 'chat', 'InputBar.tsx')

  it('the CTX chip no longer looks the window up by provider', () => {
    expect(topbar).not.toContain('PROVIDER_MAX_TOKENS')
    expect(topbar).toContain('useContextWindow(providerId, modelId)')
  })

  it('the chip is given the model, because that is what the window is a fact about', () => {
    expect(chatPage).toContain('ctxModelId={activeConv?.model}')
    expect(topbar).toContain('ctxModelId')
  })

  it('the main-process red-zone budget is per-model as well', () => {
    // The table that made every Venice conversation a 200k one and every
    // OpenGateway conversation a 32k one, whatever model was routed.
    // (the only surviving mention is the note recording that it was removed)
    expect(chatSvc).not.toMatch(/const PROVIDER_MAX_TOKENS_CHAT/)
    expect(chatSvc).not.toMatch(/PROVIDER_MAX_TOKENS_CHAT\[/)
    expect(chatSvc).toContain('resolveContextWindow(route?.model ?? \'\', route?.contextTokens)')
  })

  it('the send forwards the published window so main and the chip agree', () => {
    expect(inputBar).toContain('publishedContextTokens(sendProviderId, sendModel)')
    expect(inputBar).toContain('contextTokens:     sendWindowTokens')
  })

  it('every picker that fetches a window publishes it', () => {
    const cases: Array<[string, string]> = [
      ['VeniceModelPicker.tsx', "'venice'"],
      ['BankrModelPicker.tsx', "'bankr-gateway'"],
      ['SurplusModelPicker.tsx', "'surplus'"],
      ['OpenRouterModelPicker.tsx', "'openrouter-oauth'"],
    ]
    for (const [file, providerId] of cases) {
      const src = read('src', 'pages', 'chat', file)
      expect(src, file).toContain(`recordCatalogWindows(${providerId}`)
    }
  })
})

// ── THE CODE TAB ─────────────────────────────────────────────────────────────
//
// The last surface still guessing. defdf9f fixed the composer and said so in
// its own commit message: "the CODE tab's own meter still falls back to the
// per-provider constant, but it already hedges its number as an estimate". The
// driver measured what that hedge was worth on the installed build:
//
//   olafangensan-glm-4.7-flash-heretic → "0% of ~32,000 tokens (estimate)",
//                                        Venice serves it at 200,000
//   e2ee-qwen3-6-35b-a3b-uncensored-p  → the same 32,000, catalog says 128,000
//
// A true label on a wrong number, and the number is what sizes the meter.
describe('the CODE tab reads the same source as the composer', () => {
  const meter  = readCode('src', 'components', 'ContextMeter.tsx')
  const agent  = readCode('src', 'pages', 'agent', 'AgentPage.tsx')
  const loop   = readCode('electron', 'services', 'tachi', 'loop.ts')

  it('the meter resolves per model instead of dividing by a provider constant', () => {
    expect(meter).not.toContain('PROVIDER_MAX_TOKENS')
    expect(meter).not.toContain('DEFAULT_MAX_TOKENS')
    expect(meter).toContain('useContextWindow(providerId, modelId)')
    expect(meter).toContain('describeContextUsage(chars, win)')
    // The hedge is gone WITH the guess — it existed only to excuse the guess.
    expect(meter).not.toContain('(estimate)')
  })

  it('the meter is GIVEN the model, and the page takes it from the send-time mapping', () => {
    expect(meter).toMatch(/modelId: string/)
    expect(agent).toContain('modelId={agentCtxModelId}')
    // originModelFor is the same function that stamps a message's origin at
    // send: the meter and the badge under the answer cannot name two models.
    expect(agent).toContain('const agentCtxModelId = originModelFor(provider,')
    // …and the old per-model override prop is gone, not merely unused.
    expect(agent).not.toContain('maxTokens={')
    expect(meter).not.toMatch(/maxTokens\?: number/)
  })

  it('venice and imgnai are no longer folded into the opengateway key', () => {
    // The lookup is provider-scoped, so a wrong id misses every recorded window
    // and silently reads as unknown. This is the line that made every Venice
    // CODE session report the opengateway floor.
    expect(agent).not.toMatch(/agentCtxProviderId = .*'opengateway'/)
    expect(agent).toContain("provider === 'bankr' ? 'bankr-gateway'")
  })

  it('the DESTRUCTIVE denominator — the history budget — is fed the same fact', () => {
    // resolveContextWindow already ran here, but liveContextTokens had never
    // been supplied by ANY caller, so a 200k model was budgeted at 32k and lost
    // the user's oldest turns with no message saying so.
    expect(loop).toContain('const liveContextTokens = await publishedContextTokensFor(ledgerProviderId, modelId)')
    expect(loop).toContain('resolveContextWindow(modelId, opts.liveContextTokens)')
    // Absent stays ABSENT — never coerced to a number on the way in.
    expect(loop).toContain('...(liveContextTokens === undefined ? {} : { liveContextTokens })')
  })

  it('an unknown window shows tokens and NO percentage on this surface too', () => {
    // Same rule, same helper as the composer chip — asserted on the behaviour,
    // not on the copy.
    const usage = describeContextUsage(80_000, resolveContextWindow('e2ee-qwen3-6-35b-a3b-uncensored-p'))
    expect(usage.pct).toBeNull()
    expect(usage.windowTokens).toBeNull()
    expect(meter).toContain('usage.pct === null')
    expect(meter).toContain('TOK]')
  })

  it('the CODE tab and the composer answer with ONE number for one model', () => {
    // THE PIN the driver asked for. Both surfaces call contextWindowFor /
    // useContextWindow against the same store, so recording once answers both.
    useModelWindowStore.getState().recordCatalogWindows('venice', [
      { id: 'olafangensan-glm-4.7-flash-heretic', contextTokens: 200_000 },
      { id: 'e2ee-qwen3-6-35b-a3b-uncensored-p', contextTokens: 128_000 },
    ])
    for (const [id, tokens] of [
      ['olafangensan-glm-4.7-flash-heretic', 200_000],
      ['e2ee-qwen3-6-35b-a3b-uncensored-p', 128_000],
    ] as const) {
      const win = contextWindowFor('venice', id)
      expect(win.tokens, id).toBe(tokens)
      expect(win.known, id).toBe(true)
      // The two numbers the driver photographed, gone.
      expect(win.tokens, id).not.toBe(32_000)
      expect(describeContextUsage(0, win).windowTokens, id).toBe(tokens)
    }
  })
})

// The chassis themes draw the SAME session's context — a sidebar gauge and the
// OPUS-5 frame's LED ladder. Both divided by a flat 32k, and a pinned test
// required them to agree with each other, so they agreed on the wrong number.
describe('the chassis surfaces divide by the routed model too', () => {
  const panel = readCode('src', 'components', 'ChassisSidebarPanel.tsx')
  const frame = readCode('src', 'components', 'OpusChrome.tsx')
  const store = readCode('src', 'store', 'agent.store.ts')

  it('both call the one hook, and neither keeps a constant of its own', () => {
    for (const [name, src] of [['panel', panel], ['frame', frame]] as const) {
      expect(src, name).toContain('useAgentContextWindow()')
      expect(src, name).not.toContain('DEFAULT_MAX_TOKENS')
      // null is a real answer: the row disappears / the ladder stays dark.
      expect(src, name).toContain('ctxWindowTokens === null')
    }
  })

  it('the hook returns null rather than a floor — and keeps the source with it', () => {
    // It used to return `win.known ? win.tokens : null`, which threw the source
    // away at the one place two instrument faces read it: a coloured gauge and a
    // lit LED ladder, both drawn from a catalog row with nothing left to
    // disclose it with. `known` is permission to divide; `source` is what gets
    // shown beside the result.
    expect(store).toContain('export function useAgentContextWindow(): ResolvedContextWindow | null')
    expect(store).toContain('return win.known ? win : null')
    expect(store).not.toContain('useAgentContextWindowTokens')
  })
})

// ── THE FOURTH SURFACE ───────────────────────────────────────────────────────
//
// The day after the 32k lie died, a driver walked five imgnAI models and found
// the last seam. `glm-5-2`:
//
//   picker  — nothing at all about the window (it printed only a LIVE value)
//   chip    — "Context: 0% of 1,000,000 tokens", green zone
//   meter   — the same
//
// What makes it different from the 32k bug: 1,000,000 is probably RIGHT (Venice
// publishes 1000k for the same underlying model). The surfaces disagreed about
// CONFIDENCE, not about the number — and the four ids that hit no sourced row
// (`gpt-5-5`, `kimi-k3`, `glm-5-turbo`, `qwen3-vl-30b-a3b-instruct-private`)
// were already correct on every surface. So the fix is not to hide the static
// value — it is one definition of known, and provenance printed wherever the
// number goes.
describe('a catalog-sourced window reads the SAME on the picker and the meter', () => {
  it('the pin: one model, one number, one source, both surfaces', () => {
    // Nothing recorded: imgnAI publishes no window, which is exactly the case
    // that made the two surfaces diverge.
    const win = contextWindowFor('imgnai', 'glm-5-2')
    expect(win).toEqual({ tokens: 1_000_000, source: 'catalog', known: true })

    // The picker row, resolved through the same store the chip reads.
    expect(formatContextSuffix(win)).toBe(' · 1000k ctx (catalog)')
    // The chip / meter badge, from the same resolved window.
    expect(describeContextUsage(0, win).windowTokens).toBe(1_000_000)
    // …and the hover text on BOTH badges names who supplied the denominator.
    const title = contextUsageTitle(describeContextUsage(0, win), win, 'glm-5-2')
    // toLocaleString, because the assertion is about the SENTENCE, not about
    // the group separator the test host happens to use.
    expect(title).toContain(`0% of ${(1_000_000).toLocaleString()} tokens`)
    expect(title).toContain('from our own model catalog')
  })

  it('a live window is the unmarked case — the provider needs no hedge', () => {
    useModelWindowStore.getState().recordCatalogWindows('venice', [{ id: 'glm-5-2', contextTokens: 1_000_000 }])
    const win = contextWindowFor('venice', 'glm-5-2')
    expect(win.source).toBe('live')
    expect(formatContextSuffix(win)).toBe(' · 1000k ctx')
    expect(contextUsageTitle(describeContextUsage(0, win), win, 'glm-5-2'))
      .toBe(`Context: 0% of ${(1_000_000).toLocaleString()} tokens`)
  })

  it('the four ids the driver found already honest stay silent on both surfaces', () => {
    for (const id of ['qwen3-vl-30b-a3b-instruct-private', 'glm-5-turbo', 'gpt-5-5', 'kimi-k3']) {
      const win = contextWindowFor('imgnai', id)
      expect(win.known, id).toBe(false)
      expect(formatContextSuffix(win), id).toBeNull()
      expect(describeContextUsage(1000, win).pct, id).toBeNull()
      expect(contextUsageTitle(describeContextUsage(1000, win), win, id), id)
        .toContain('no context window published')
    }
  })

  it('no surface prints a percentage or a zone from a source it has not disclosed', () => {
    // The chip and the meter share ONE title builder, and it is the one that
    // carries the source. The zone colour is derived from `usage.pct`, which is
    // null unless the window is known — so a colour cannot outlive a disclosure.
    for (const [name, src] of [
      ['chip',  readCode('src', 'components', 'layout', 'PageTopbar.tsx')],
      ['meter', readCode('src', 'components', 'ContextMeter.tsx')],
    ] as const) {
      expect(src, name).toContain('contextUsageTitle(usage, win, modelId)')
      expect(src, name).toContain('usage.pct === null ? null : getContextZone')
    }
    // The chassis instrument faces disclose too — a gauge and a ten-cell ladder
    // are percentages in another housing.
    expect(readCode('src', 'components', 'ChassisSidebarPanel.tsx')).toContain('contextSourceNote(ctxWin.source)')
    expect(readCode('src', 'components', 'OpusChrome.tsx')).toContain('contextSourceNote(ctxWin.source)')
  })
})
