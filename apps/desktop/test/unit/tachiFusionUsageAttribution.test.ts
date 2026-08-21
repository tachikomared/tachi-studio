// apps/desktop/test/unit/tachiFusionUsageAttribution.test.ts
//
// IN-LOOP FUSION METERED THE PANEL AND THE JUDGE UNDER THE SESSION'S MODEL.
//
// `consult_panel` and `fuse_plan` run a panel of frontier models and a judge
// over the session's gateway — models the session itself never touches. Both
// advisors took runFusion's single SUMMED usage figure and pushed it through
// the session recorder, so the provider column was right and the model column
// was fiction: a Haiku session consulting Bankr's `frontier` preset booked
// three Opus-class legs and an Opus judge at Haiku's $1/$5.
//
// splitFusionUsage is the pure half of the fix and is exercised for real here,
// including against a real CostLedger for the money. The electron-coupled
// wiring (dynamic imports of settings-store / cost-ledger / provider-service)
// is asserted against the SOURCE — the same convention as costLedger.test.ts
// and turnResetWiring.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitFusionUsage, type FusionUsageLeg } from '../../electron/services/tachi/loop'
import { CostLedger } from '../../electron/services/cost-ledger'

const DAY = 86_400_000
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fusion-usage-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

// `file` is per-ledger on purpose: CostLedger LOADS the path it is given, so two
// ledgers sharing one file in the same test sum each other's events.
const makeLedger = (nowMs: { t: number }, file = 'cost-ledger.jsonl') =>
  new CostLedger(join(dir, file), () => nowMs.t)

// One realistic consult_panel turn on Bankr's `frontier` preset
// (fusion-presets.ts): panel = claude-opus-5 / gpt-5.5 / glm-5.2, judge =
// claude-opus-5. glm-5.2 is the leg that "falls soft" when Bankr does not serve
// it. Every count is under gpt-5.5's 272k long-context threshold, so the flat
// $5/$30 tier applies and the arithmetic below is exact.
const LEGS: FusionUsageLeg[] = [
  { model: 'claude-opus-5', ok: true,  usage: { promptTokens: 100_000, completionTokens: 20_000 } },
  { model: 'gpt-5.5',       ok: true,  usage: { promptTokens: 100_000, completionTokens: 20_000 } },
  { model: 'glm-5.2',       ok: false },
]
// What runFusion yields: the two usable legs plus the judge's analysis +
// synthesis stages (260k prompt / 40k completion).
const TOTAL = { promptTokens: 460_000, completionTokens: 80_000 }
const JUDGE = 'claude-opus-5'

describe('splitFusionUsage attributes a fusion turn to the models that served it', () => {
  it('books each panel leg under its own model and the remainder under the judge', () => {
    expect(splitFusionUsage(LEGS, JUDGE, TOTAL)).toEqual([
      { model: 'claude-opus-5', inputTokens: 100_000, outputTokens: 20_000 },
      { model: 'gpt-5.5',       inputTokens: 100_000, outputTokens: 20_000 },
      // The judge never reports its two stages separately; the remainder IS
      // those stages, because the sum subtracted is over exactly the legs
      // runFusion added.
      { model: 'claude-opus-5', inputTokens: 260_000, outputTokens: 40_000 },
    ])
  })

  it('loses and invents nothing: the rows re-add to the reported total', () => {
    const rows = splitFusionUsage(LEGS, JUDGE, TOTAL)
    expect(rows.reduce((n, r) => n + r.inputTokens, 0)).toBe(TOTAL.promptTokens)
    expect(rows.reduce((n, r) => n + r.outputTokens, 0)).toBe(TOTAL.completionTokens)
  })

  it('the session model appears nowhere — it served none of these calls', () => {
    const rows = splitFusionUsage(LEGS, JUDGE, TOTAL)
    expect(rows.map(r => r.model)).not.toContain('claude-haiku-4.5')
  })

  it('a failed leg is neither charged nor subtracted from the judge', () => {
    // glm-5.2 errored: its tokens are not inside runFusion's total, so booking
    // them would add spend the gateway never reported — and subtracting them
    // would shrink the judge's real share.
    const rows = splitFusionUsage(LEGS, JUDGE, TOTAL)
    expect(rows.map(r => r.model)).not.toContain('glm-5.2')
    expect(rows.at(-1)).toEqual({ model: JUDGE, inputTokens: 260_000, outputTokens: 40_000 })
  })

  it('a leg the gateway reported no usage for stays UNRECORDED rather than zero', () => {
    const legs: FusionUsageLeg[] = [
      { model: 'claude-opus-5', ok: true, usage: { promptTokens: 100_000, completionTokens: 20_000 } },
      { model: 'gpt-5.5',       ok: true },   // answered, but no usage reported
    ]
    const rows = splitFusionUsage(legs, JUDGE, { promptTokens: 360_000, completionTokens: 60_000 })
    expect(rows.map(r => r.model)).not.toContain('gpt-5.5')
    // Nothing was subtracted for it either, so the judge's share is still the
    // exact difference — an invented zero would have been indistinguishable,
    // but an invented anything else would have corrupted this number.
    expect(rows.at(-1)).toEqual({ model: JUDGE, inputTokens: 260_000, outputTokens: 40_000 })
  })

  it('reports no judge row at all when the gateway reported no total', () => {
    // runFusion emits no usage chunk when the synthesis stream errors out. The
    // legs' own figures are still real and are kept; the judge's are unknown,
    // and unknown is recorded as nothing, never as a plausible default.
    const rows = splitFusionUsage(LEGS, JUDGE, undefined)
    expect(rows).toEqual([
      { model: 'claude-opus-5', inputTokens: 100_000, outputTokens: 20_000 },
      { model: 'gpt-5.5',       inputTokens: 100_000, outputTokens: 20_000 },
    ])
  })

  it('drops the judge row rather than write a negative, if core stops summing this way', () => {
    // Only reachable if runFusion's total stops being "usable legs + judge".
    // A negative remainder is not a number about the world, so it is not written.
    const rows = splitFusionUsage(LEGS, JUDGE, { promptTokens: 10, completionTokens: 10 })
    expect(rows.map(r => r.model)).toEqual(['claude-opus-5', 'gpt-5.5'])
  })

  it('an empty panel with a total books the whole turn to the judge', () => {
    // A gateway that reports usage only on the final stream: the total then IS
    // the judge's own figure, and attributing it to the judge is exact.
    expect(splitFusionUsage([], JUDGE, TOTAL)).toEqual([
      { model: JUDGE, inputTokens: 460_000, outputTokens: 80_000 },
    ])
  })
})

describe('the money the wrong model column was hiding', () => {
  it('a Haiku session no longer bills an Opus panel at Haiku rates', () => {
    const now = { t: 10 * DAY }

    // WHAT SHIPPED BEFORE: one lump sum under the session's model.
    const before = makeLedger(now, 'before.jsonl')
    before.record('bankr-gateway', 'claude-haiku-4.5', TOTAL.promptTokens, TOTAL.completionTokens)
    // 0.46M × $1/M + 0.08M × $5/M
    expect(before.spendUsdSince(now.t - DAY)).toBeCloseTo(0.86)

    // WHAT SHIPS NOW: one row per model that actually served a call.
    const after = makeLedger({ t: 10 * DAY }, 'after.jsonl')
    for (const r of splitFusionUsage(LEGS, JUDGE, TOTAL)) {
      after.record('bankr-gateway', r.model, r.inputTokens, r.outputTokens)
    }
    // opus-5 leg   0.1×5  + 0.02×25 = $1.00
    // gpt-5.5 leg  0.1×5  + 0.02×30 = $1.10
    // opus-5 judge 0.26×5 + 0.04×25 = $2.30
    expect(after.spendUsdSince(now.t - DAY)).toBeCloseTo(4.4)

    // The same tokens, 5× the spend — and it is the 30-day cap's own figure, so
    // the old attribution let four fifths of a fusion turn past the budget gate.
    expect(after.spendUsdSince(now.t - DAY)).toBeGreaterThan(5 * before.spendUsdSince(now.t - DAY))
  })

  it('every row is priced — no fusion leg lands as an unpriceable id', () => {
    const now = { t: 10 * DAY }
    const ledger = makeLedger(now)
    for (const r of splitFusionUsage(LEGS, JUDGE, TOTAL)) {
      expect(ledger.record('bankr-gateway', r.model, r.inputTokens, r.outputTokens).priced).toBe(true)
    }
    const written = readFileSync(join(dir, 'cost-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(written.map(e => e.model)).toEqual(['claude-opus-5', 'gpt-5.5', 'claude-opus-5'])
  })
})

// ── The electron-coupled half ────────────────────────────────────────────────
describe('both fusion advisors are wired to the served-model recorder', () => {
  const APP = join(__dirname, '../..')
  const read = (rel: string) => readFileSync(join(APP, rel), 'utf8')
  /** Drop comments, so an assertion about CODE is never satisfied — or defeated
   *  — by prose that quotes the expression it removed. */
  const code = (rel: string) =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('records the served model, on the same provider and task type as the session', () => {
    expect(code('electron/services/tachi/loop.ts'))
      .toContain('ledger.record(ledgerProviderId, servedModel, u.inputTokens ?? 0, u.outputTokens ?? 0, taskType)')
  })

  it('consult_panel and fuse_plan both meter the split, not the lump sum', () => {
    const src = code('electron/services/tachi/loop.ts')
    // Two call sites, one shared helper: the two advisors cannot drift apart.
    expect(src.match(/meterFusion\(legs, judge, usage\)/g)).toHaveLength(2)
    // The panel members are the ONLY place per-leg usage exists, so both sites
    // capture them from onPanel.
    expect(src.match(/^\s*legs = members$/gm)).toHaveLength(2)
    // …and neither pushes runFusion's summed figure through the session meter.
    expect(src).not.toContain('meter?.({ inputTokens: usage.promptTokens, outputTokens: usage.completionTokens })')
  })

  it('leaves the session\'s own usage recorded under the session model', () => {
    // The fix must not become a second defect: everything that is NOT fusion
    // still belongs to the model the loop itself ran on.
    expect(code('electron/services/tachi/loop.ts')).toContain('ledger.record(ledgerProviderId, modelId')
  })
})
