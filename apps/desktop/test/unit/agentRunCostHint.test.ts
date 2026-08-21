// apps/desktop/test/unit/agentRunCostHint.test.ts
//
// THE RULE: the price on the RUN button is the price of the model that will
// actually run.
//
// The CODE tab used to answer "which model?" twice, ten lines apart, in the
// same component. `originModelFor` owns the mapping — it is what stamps a
// message's origin at send and what feeds the CTX meter — but `runCostHint`
// kept its own hand-written copy of the identical provider→model chain
// (bankr/surplus/venice/imgnai/OPENGATEWAY_AGENT_MODEL/defaultRoute.modelId).
//
// Nothing was wrong on the day it was written; the two copies agreed. That is
// what makes it the drift shape rather than a bug: the next repricing, or the
// seventh provider, gets applied to whichever copy the author had open. The
// run then bills the model the ORIGIN STAMP names while the button quotes the
// rate of the other one — a money number, wrong, with no symptom until the
// invoice. Venice and imgnai already shipped mislabelled once through exactly
// this mechanism (see the PROVIDER_LABELS and agentCtxProviderId comments in
// AgentPage.tsx), so this is a repeat offence in one file.
//
// AgentPage.tsx is a React page: it is not importable in this node-env runner
// and its memo is component-internal, so — as with the CODE-tab assertions in
// chatContextWindow.test.ts — the pin is on the source text. Comments are
// stripped first, so the prose above (which necessarily NAMES the deleted
// chain) can never satisfy or break an assertion about code.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, 'apps', 'desktop', ...p), 'utf8')
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CODE = stripComments(read('src', 'pages', 'agent', 'AgentPage.tsx'))

/** The body of the runCostHint memo, from its opening to its dependency array. */
function runCostHintBody(): string {
  const start = CODE.indexOf('const runCostHint = useMemo(')
  expect(start, 'runCostHint is gone from AgentPage.tsx — this test needs rewriting, not deleting').toBeGreaterThan(-1)
  const end = CODE.indexOf('\n  }, [', start)
  expect(end, 'runCostHint is no longer a useMemo with a dependency array').toBeGreaterThan(start)
  return CODE.slice(start, end)
}

describe('the RUN-button cost hint prices the model the run will use', () => {
  it('reads the model through the shared mapping instead of re-deriving it', () => {
    expect(runCostHintBody()).toContain('const model = agentCtxModelId')
  })

  it('has no second copy of the provider→model chain', () => {
    const body = runCostHintBody()
    // Every token a re-hand-written chain would have to name. If one of these
    // reappears inside the memo, someone has started answering "which model?"
    // twice again, and the two answers can then disagree.
    for (const forbidden of [
      'bankrModel',
      'surplusModel',
      'veniceModel',
      'imgnaiModel',
      'OPENGATEWAY_AGENT_MODEL',
      'defaultRoute?.modelId',
      'defaultRoute.modelId',
    ]) {
      expect(body, `runCostHint re-derives the model itself via ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('says nothing at all when the provider has no canonical id', () => {
    // The ONE case where the two chains genuinely disagreed, and the reason
    // this merge needed a guard rather than a straight substitution:
    //   deleted chain  — unknown provider → model '' → no hint
    //   originModelFor — unknown provider → the DEFAULT LADDER's model, via the
    //                    switch fall-through that exists to serve 'default'
    // `provider` is persisted and migrateAgentPersisted coerces only `harness`,
    // so a build that drops a provider id rehydrates straight into that case.
    // Bailing on a null canonicalId keeps the old, honest answer: no number.
    const body = runCostHintBody()
    expect(body).toContain('if (!canonicalId) return')
    // …and it must bail BEFORE the model is read, or the fall-through already won.
    expect(body.indexOf('if (!canonicalId) return')).toBeLessThan(body.indexOf('const model = agentCtxModelId'))
  })

  it('the mapping it reads through is still originModelFor, not a local const', () => {
    // agentCtxModelId is only a safe thing to price if it is the SAME function
    // that stamps the origin at send. If this line ever becomes a hand-rolled
    // ternary, the merge above has silently un-merged itself.
    expect(CODE).toContain('const agentCtxModelId = originModelFor(provider,')
  })

  it('recomputes when the picked model changes', () => {
    // The four per-provider ids left the dependency array with the chain that
    // read them. agentCtxModelId has to take their place or the hint freezes on
    // the model that was selected when the memo last ran — a stale price is the
    // same lie as a wrong one, just harder to spot.
    expect(CODE).toContain('}, [provider, agentCtxModelId, defaultRoute, agentContextChars, task.length, t])')
  })
})
