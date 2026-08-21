// apps/desktop/test/unit/providerNodeModel.test.ts
//
// THE MODEL THAT WAS ONLY EVER ON SCREEN.
//
// Driving the installed build: a provider node's <select> DISPLAYED
// `aya-expanse:8b`, the run sent `auto`, and it failed ~2 minutes later with
// `model 'auto' not found`. Nobody had mis-clicked. The node was seeded from
// the registry, whose `defaultModel` for ollama-local is 'auto'
// (providerCompat.ts::graphProviderSeeds), and 'auto' is not in the Ollama
// catalog — so React, which selects the FIRST option when a controlled value
// matches none of them, showed option[0] while `data.model` still said 'auto'.
// The select and the runner disagreed, and only the select was visible.
//
// Two rules keep them in step, and both are pinned here:
//   1. a value the catalog does not offer is rendered as its OWN option;
//   2. an EMPTY value is committed to node data, not merely displayed.
// MediaNode already had rule 1 (mediaNodeStaleModel.test.ts) and so did
// PromptNode + NodeConfigPanel's ModelField — ProviderNode was the one surface
// that had neither.
//
// Same source-level convention as mediaNodeStaleModel.test.ts /
// canvasLocalNegative.test.ts: no @testing-library/react exists in this repo,
// so node components are pinned by asserting on the code shape inside a named
// anchor slice, with comments stripped first (this file's own prose quotes the
// shapes it asserts on).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { staticModelIds } from '../../src/pages/nodes/useProviderModels'

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

const read = (rel: string): string => stripComments(readFileSync(resolve(__dirname, '..', '..', rel), 'utf8'))

function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.length, `slice ${from} → ${to} is too short to be the real block`).toBeGreaterThan(30)
  return body
}

const PROVIDER_NODE = 'src/pages/nodes/canvas/nodeTypes/ProviderNode.tsx'
const GRAPH_IPC     = 'electron/ipc/graph.ipc.ts'

describe('ProviderNode: what the select shows is what node data holds', () => {
  const src = read(PROVIDER_NODE)

  it('the selected value is computed once and the select is keyed on it', () => {
    expect(src).toContain('const selected = data.model ?? models[0]')
    expect(src).toMatch(/<select\s+value=\{selected\}/)
  })

  it('a value the catalog does not offer is rendered as its own <option>', () => {
    expect(src).toMatch(/const unlisted =[\s\S]{0,120}!models\.includes\(selected\)/)
    expect(src).toContain('{unlisted && <option value={selected}>')
  })

  it('an empty model is COMMITTED to node data, not just displayed', () => {
    const commit = between(src, 'if (models.length === 0) return', 'const onModelChange')
    expect(commit).toContain('if (!data.model) updateNodeData(id, { model: models[0] })')
  })

  it('Ollama gets the models the user really pulled, and its unusable seed is resolved', () => {
    const effect = between(src, "if (pid !== 'ollama-local') return", "if (pid !== 'llama-cpp') return")
    expect(effect).toContain('window.tachi.ollama?.listModels?.()')
    // Only ever commits off a LIVE list — never off the static fallback guess.
    expect(effect).toMatch(/if \(names\.length === 0\) return[\s\S]*setModels\(names\)/)
    expect(effect).toMatch(/!data\.model \|\| data\.model === 'auto' \|\| !names\.includes\(data\.model\)/)
    expect(effect).toContain('updateNodeData(id, { model: names[0] })')
  })
})

// ── ONE model catalog, and the copies that are left cannot drift ────────────
//
// ProviderNode kept a second STATIC_MODELS table whose own comment admitted it
// was a mirror, and the mirror had already cracked: imgnai was in the hook's
// table and missing here, so an imgnai provider node rendered no dropdown at
// all. Model ids change monthly (see the 2026-08-01 `tencent/hy3:free` note) —
// a silent second copy is a stale copy. The catalog now lives in
// useProviderModels.ts; ProviderNode imports it and keeps only its live-fetch
// effects, which also WRITE node data and are pinned above.

describe('the static model catalog is single-sourced', () => {
  const src = read(PROVIDER_NODE)

  it('ProviderNode declares no catalog of its own', () => {
    expect(src).not.toContain('STATIC_MODELS')
    // The old mirror was a Record<string, string[]> literal; no id→models map
    // may reappear here under any name.
    expect(src).not.toMatch(/Record<string,\s*string\[\]>/)
  })

  it('ProviderNode reads the shared catalog and seeds its state from it', () => {
    expect(src).toMatch(/import \{ staticModelIds \} from '\.\.\/\.\.\/useProviderModels'/)
    expect(src).toContain('useState<string[]>(() => staticModelIds(pid))')
  })

  it('the catalog still answers for every provider the node can be seeded with', () => {
    // The ids the old mirror covered — a regression here means the collapse
    // silently emptied a dropdown.
    for (const pid of ['bankr-gateway', 'opengateway', 'surplus', 'ollama-local',
                       'anthropic-oauth', 'freellmapi-local', 'venice']) {
      expect(staticModelIds(pid).length, pid).toBeGreaterThan(0)
    }
    // And the one the mirror had DRIFTED on — imgnai now resolves here too.
    expect(staticModelIds('imgnai').length).toBeGreaterThan(0)
    // llama.cpp deliberately ships no guess: its models are whatever this
    // machine downloaded, and a guess would be a lie about someone's disk.
    expect(staticModelIds('llama-cpp')).toEqual([])
    expect(staticModelIds('no-such-provider')).toEqual([])
  })

  it('the third copy (chat ImgnaiModelPicker) cannot drift from it either', () => {
    // Not merged — that picker builds a different shape (it derives a `family`
    // per id) and lives on the chat surface. Merged or not, it must not be a
    // SILENT copy, so it is pinned against the shared table here.
    const picker = read('src/pages/chat/ImgnaiModelPicker.tsx')
    const block = between(picker, 'const STATIC_IDS = [', ']')
    const ids = [...block.matchAll(/'([^']+)'/g)].map(m => m[1])
    expect(ids).toEqual(staticModelIds('imgnai'))
  })
})

describe("graph.ipc: an unresolved model is refused BEFORE the run, and only where 'auto' is meaningless", () => {
  const src = read(GRAPH_IPC)

  it('treats blank and the placeholder alike', () => {
    const fn = between(src, 'function isUnresolvedModel', 'const OLLAMA_MODEL_GAP_ERROR')
    expect(fn).toContain("return m === '' || m === 'auto'")
  })

  it('gates BOTH run paths (whole flow and single node/subflow) on Ollama nodes', () => {
    const gates = src.match(/isUnresolvedModel\(\(?\w+\.data as \{ model\?: unknown \}\)\.model\)/g) ?? []
    expect(gates.length, 'both graph:run and the node-run path must gate').toBe(2)
    const ollamaGuards = src.match(/\['ollama', 'ollama-local'\]\.includes/g) ?? []
    expect(ollamaGuards.length).toBe(2)
  })

  it("does NOT reject 'auto' for the providers that really support it", () => {
    // OpenGateway routes on 'auto' server-side and the freellmapi sidecar picks
    // a free model with it — a blanket rejection would break both.
    expect(src).not.toMatch(/isUnresolvedModel[\s\S]{0,200}opengateway/)
    expect(src).toMatch(/makeFreellmapiAdapter\(\{\s*model:\s*'auto',/)
  })

  it('the private-mode default adapter resolves a real pulled model instead of sending the placeholder', () => {
    expect(src).toContain('async function ollamaDefaultModel()')
    expect(src).toContain('await listOllamaModels()')
    expect(src).not.toContain("makeOllamaAdapter({ model: 'auto' })")
  })
})
