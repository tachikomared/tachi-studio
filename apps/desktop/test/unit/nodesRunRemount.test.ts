// apps/desktop/test/unit/nodesRunRemount.test.ts
//
// A CANVAS RUN THAT IS RUNNING LOOKS LIKE IT IS RUNNING — AFTER A TAB SWITCH
// (FLF driver, finding 3).
//
// Two live losses, one cause:
//
//  1. Run all → leave /nodes → come back: the RUNNING label and the STOP button
//     were gone while the sidebar dot stayed green. The status itself was
//     already global (nodesRun.store), but the PANEL that renders it was
//     `useState(false)` in NodesPage — React unmounts the page on a tab switch
//     and the panel came back closed, so the one control that can stop the run
//     was unreachable.
//
//  2. A per-node RUN (the media node's own button) on a 44-minute i2v render:
//     the app lost the run ENTIRELY — dot false, no label, no stop — while
//     sd-cli held the GPU at 100%. `useNodeRun` kept `run` / `fanout` /
//     `inflight` in component state, so unmounting threw all three away, and
//     nothing on that path ever touched the global store the dot reads.
//
// This is the same class as the provider fix (f19ffdd) and media.store's `run`
// slice (a403875): the state lives in a module-scoped, NOT-persisted store, so
// it outlives the component and dies with the app.
//
// Renderer components cannot be mounted in this repo's test env (vitest runs
// `environment: 'node'`), so the STORE is exercised for real and the bindings
// are pinned with source assertions — the house idiom.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8')

// localStorage shim installed BEFORE the store loads (it reads the budget cap).
const ls = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string) => { ls.set(k, v) },
  removeItem: (k: string) => { ls.delete(k) },
  clear: () => ls.clear(),
  key: (i: number) => Array.from(ls.keys())[i] ?? null,
  get length() { return ls.size },
}

import {
  useNodesRunStore, nodeRunOf, nodesRunActive, IDLE_NODE_RUN,
} from '../../src/store/nodesRun.store'

const S = () => useNodesRunStore.getState()

beforeEach(() => {
  ls.clear()
  useNodesRunStore.setState({
    status: { kind: 'idle' }, activeNodeId: null, stopRequested: false,
    nodeRuns: {}, panelOpen: false, runInput: '',
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE RUN PANEL SURVIVES THE TAB SWITCH
// ═════════════════════════════════════════════════════════════════════════════

describe('the run panel is open state, not component state', () => {
  it('a Run-all opens it and a REMOUNT still finds it open', () => {
    S().setPanelOpen(true)
    // "unmount": every component that read the store is gone. The store is not.
    expect(useNodesRunStore.getState().panelOpen).toBe(true)
  })

  it('closing it is still a real close', () => {
    S().setPanelOpen(true)
    S().setPanelOpen(false)
    expect(S().panelOpen).toBe(false)
  })

  it('the STOP the panel offers still reaches the loop after a remount', () => {
    S().setStatus({ kind: 'running', step: 1, total: 2, label: 'wan i2v' })
    S().setPanelOpen(true)
    // …the user comes back and hits STOP: the flag the run loop polls is global.
    S().requestStop()
    expect(S().stopRequested).toBe(true)
    expect(S().status).toEqual({ kind: 'running', step: 1, total: 2, label: 'wan i2v' })
  })

  it('is NOT persisted — a restart must not reopen a panel for a dead run', () => {
    S().setPanelOpen(true)
    expect(Array.from(ls.keys()).join(',')).not.toMatch(/panel/i)
  })

  // …and the panel came back EMPTY (review of the fix lane, finding 5): only the
  // panel's VISIBILITY moved into the store, while the message the user typed
  // into it stayed `useState('')` in NodesPage. A tab switch reopened the panel
  // with the typed input silently gone.
  it('the typed initial message survives the remount too', () => {
    S().setRunInput('write me a haiku about GPUs')
    expect(useNodesRunStore.getState().runInput).toBe('write me a haiku about GPUs')
  })

  it('and clearing it is a real clear', () => {
    S().setRunInput('draft')
    S().setRunInput('')
    expect(S().runInput).toBe('')
  })

  it('is not persisted either — a restart starts from a blank prompt', () => {
    S().setRunInput('secret prompt')
    expect(Array.from(ls.values()).join(',')).not.toContain('secret prompt')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE PER-NODE RUN SURVIVES THE TAB SWITCH
// ═════════════════════════════════════════════════════════════════════════════

describe('per-node run state lives in the store', () => {
  it('a node marked running is STILL running after its component is gone', () => {
    S().setNodeRun('media-1', { state: { kind: 'running' }, inflight: true })
    expect(nodeRunOf(useNodesRunStore.getState(), 'media-1').state).toEqual({ kind: 'running' })
    expect(nodeRunOf(useNodesRunStore.getState(), 'media-1').inflight).toBe(true)
  })

  it('an untouched node reads as idle, with a STABLE identity (no render loop)', () => {
    expect(nodeRunOf(S(), 'never-run').state.kind).toBe('idle')
    expect(nodeRunOf(S(), 'never-run')).toBe(IDLE_NODE_RUN)
    expect(nodeRunOf(S(), 'never-run')).toBe(nodeRunOf(S(), 'other-node'))
  })

  it('keeps one node’s run out of another’s', () => {
    S().setNodeRun('a', { state: { kind: 'running' } })
    S().setNodeRun('b', { state: { kind: 'error', error: 'nope' } })
    expect(nodeRunOf(S(), 'a').state.kind).toBe('running')
    expect(nodeRunOf(S(), 'b').state).toEqual({ kind: 'error', error: 'nope' })
  })

  it('patches merge — a retry label does not wipe the fan-out progress', () => {
    S().setNodeRun('a', { fanout: { active: true, done: 1, total: 4 } })
    S().setNodeRun('a', { state: { kind: 'running', attempt: 2, attempts: 3 } })
    const slice = nodeRunOf(S(), 'a')
    expect(slice.fanout).toEqual({ active: true, done: 1, total: 4 })
    expect(slice.state).toEqual({ kind: 'running', attempt: 2, attempts: 3 })
  })

  it('reset drops the entry (the × Clear on the node card)', () => {
    S().setNodeRun('a', { state: { kind: 'done', artifacts: [] } })
    S().resetNodeRun('a')
    expect(S().nodeRuns['a']).toBeUndefined()
    expect(nodeRunOf(S(), 'a').state.kind).toBe('idle')
  })

  it('is NOT persisted — a render dies with the app', () => {
    S().setNodeRun('a', { state: { kind: 'running' } })
    expect(Array.from(ls.values()).join(',')).not.toContain('running')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2b. × CLEAR MUST NOT WIPE A LIVE RUN (review of the fix lane, finding 1)
// ═════════════════════════════════════════════════════════════════════════════
//
// resetNodeRun deleted the WHOLE slice, `inflight` and `stopRequested` with it.
// Pressed during a 44-minute render that made the app forget it was running:
// doRun's guard reads `inflight`, so RUN went live again and a DUPLICATE render
// could start on the same GPU, and nodesRunActive() went false — every lamp dark
// while sd-cli was still burning. Clearing a RESULT is the button's job;
// forgetting a RUN is not.

describe('resetNodeRun: a run in flight is not a result you can clear', () => {
  it('keeps the double-run guard alive', () => {
    S().setNodeRun('media-1', { state: { kind: 'running' }, inflight: true })
    S().resetNodeRun('media-1')
    expect(nodeRunOf(S(), 'media-1').inflight).toBe(true)
  })

  it('keeps a STOP already asked for (it must still reach the loop)', () => {
    S().setNodeRun('media-1', { state: { kind: 'running' }, inflight: true, stopRequested: true })
    S().resetNodeRun('media-1')
    expect(nodeRunOf(S(), 'media-1').stopRequested).toBe(true)
  })

  it('does not lie the lamps dark while the engine runs', () => {
    S().setNodeRun('media-1', { state: { kind: 'running' }, inflight: true })
    S().resetNodeRun('media-1')
    expect(nodesRunActive(S())).toBe(true)
  })

  it('keeps a fan-out’s progress (it is mid-loop, not finished)', () => {
    S().setNodeRun('media-1', {
      state: { kind: 'done', artifacts: [] },
      fanout: { active: true, done: 1, total: 4 }, inflight: true,
    })
    S().resetNodeRun('media-1')
    expect(nodeRunOf(S(), 'media-1').fanout).toEqual({ active: true, done: 1, total: 4 })
    // …but the finished variant's own result IS forgotten — that part is a clear.
    expect(nodeRunOf(S(), 'media-1').state.kind).toBe('idle')
    expect(nodesRunActive(S())).toBe(true)
  })

  it('still fully forgets a SETTLED node (the ordinary Clear is unchanged)', () => {
    S().setNodeRun('a', { state: { kind: 'done', artifacts: [] }, inflight: false })
    S().resetNodeRun('a')
    expect(S().nodeRuns['a']).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2c. THE FLOW LIFECYCLE PRUNES nodeRuns (review of the fix lane, finding 2)
// ═════════════════════════════════════════════════════════════════════════════
//
// Nothing ever cleared `nodeRuns`. Switching flows / + New / import / opening a
// template left every slice alive — including `done` states holding inline b64
// artifact bytes — for the rest of the session, and because templates use FIXED
// node ids ('p2i-image'), re-opening one RE-ATTACHED the previous flow's stale
// result to a node that had never run in this canvas.

describe('resetAllNodeRuns: a new canvas starts with no runs — except a live one', () => {
  it('drops every settled slice', () => {
    S().setNodeRun('a', { state: { kind: 'done', artifacts: [] } })
    S().setNodeRun('p2i-image', { state: { kind: 'error', error: 'nope' } })
    S().resetAllNodeRuns()
    expect(Object.keys(S().nodeRuns)).toEqual([])
  })

  it('KEEPS an in-flight one — its finally must still find a slice to stamp', () => {
    S().setNodeRun('a', { state: { kind: 'done', artifacts: [] } })
    S().setNodeRun('media-1', { state: { kind: 'running' }, inflight: true })
    S().resetAllNodeRuns()
    expect(Object.keys(S().nodeRuns)).toEqual(['media-1'])
    expect(nodeRunOf(S(), 'media-1').inflight).toBe(true)
    expect(nodesRunActive(S())).toBe(true)
  })

  it('is a no-op on an empty store (a fresh app switching flows)', () => {
    S().resetAllNodeRuns()
    expect(S().nodeRuns).toEqual({})
  })
})

describe('every flow-lifecycle site prunes the per-node runs', () => {
  const rail = read('src/pages/nodes/sidebar/FlowsRail.tsx')

  it('FlowsRail prunes wherever it resets the run status', () => {
    const idleResets = rail.match(/setStatus\(\{ kind: 'idle' \}\)/g)?.length ?? 0
    const prunes     = rail.match(/resetAllNodeRuns\(\)/g)?.length ?? 0
    expect(idleResets).toBeGreaterThanOrEqual(4)
    // switchTo · + New · import · template-open: the four sites that REPLACE the
    // canvas. (restoreRevision resets the status too and is deliberately left
    // out — it reloads the SAME flow, whose slices still belong to its nodes.)
    expect(prunes).toBeGreaterThanOrEqual(4)
  })

  it('the store action is imported through the same door as setStatus', () => {
    expect(rail).toContain('useNodesRunStore.getState().resetAllNodeRuns()')
  })
})

describe('a fan-out STOP asked AFTER a remount still reaches the loop', () => {
  it('the cancel flag is global, not a component ref', () => {
    S().setNodeRun('a', { state: { kind: 'running' }, fanout: { active: true, done: 1, total: 4 } })
    // The loop's own `cancelRef` died with the unmounted component; the flag the
    // loop polls must be the one the NEW card's STOP writes.
    S().requestNodeStop('a')
    expect(nodeRunOf(S(), 'a').stopRequested).toBe(true)
  })

  it('a fresh run clears it, so a stop cannot leak into the next fan-out', () => {
    S().requestNodeStop('a')
    S().setNodeRun('a', { stopRequested: false, state: { kind: 'running' } })
    expect(nodeRunOf(S(), 'a').stopRequested).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE DOT — the 44-minute run the app did not know about
// ═════════════════════════════════════════════════════════════════════════════

describe('nodesRunActive: what the sidebar dot and the chassis lamps read', () => {
  it('is false at rest', () => {
    expect(nodesRunActive(S())).toBe(false)
  })

  it('is true for a Run-all (unchanged)', () => {
    S().setStatus({ kind: 'running' })
    expect(nodesRunActive(S())).toBe(true)
  })

  it('is TRUE for a lone per-node run — the case the dot used to miss', () => {
    S().setNodeRun('media-1', { state: { kind: 'running' } })
    expect(nodesRunActive(S())).toBe(true)
  })

  it('is true while a fan-out is between variants (no flicker per variant)', () => {
    S().setNodeRun('media-1', { state: { kind: 'done', artifacts: [] }, fanout: { active: true, done: 1, total: 4 } })
    expect(nodesRunActive(S())).toBe(true)
  })

  it('goes false again when the node settles', () => {
    S().setNodeRun('media-1', { state: { kind: 'running' } })
    S().setNodeRun('media-1', { state: { kind: 'done', artifacts: [] }, inflight: false })
    expect(nodesRunActive(S())).toBe(false)
  })

  it('a FAILED run does not leave the lamp on', () => {
    S().setNodeRun('media-1', { state: { kind: 'error', error: 'engine refused' } })
    expect(nodesRunActive(S())).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE BINDINGS (source assertions — components can't be mounted here)
// ═════════════════════════════════════════════════════════════════════════════

describe('useNodeRun binds to the store instead of component state', () => {
  const hook = read('src/pages/nodes/canvas/useNodeRun.ts')

  it('holds no useState for the run / fan-out at all', () => {
    expect(hook).not.toContain('useState<NodeRunState>')
    expect(hook).not.toContain('useState<FanoutProgress>')
  })

  it('reads both out of the store, keyed by node id', () => {
    expect(hook).toContain('useNodesRunStore(s => nodeRunOf(s, nodeId).state)')
    expect(hook).toContain('useNodesRunStore(s => nodeRunOf(s, nodeId).fanout)')
  })

  it('guards a double-run on the STORE, so a remount cannot start a second one', () => {
    expect(hook).not.toContain('inflight.current')
    // The GUARD EXPRESSION, not the word: `toContain('inflight')` was satisfied
    // by the doc comment above it, so the assertion survived any mutation of the
    // guard itself (review of the fix lane, finding 7).
    expect(hook).toContain('nodeRunOf(useNodesRunStore.getState(), nodeId).inflight')
  })

  it('polls the global stop flag between fan-out variants', () => {
    expect(hook).toContain('nodeRunOf(useNodesRunStore.getState(), nodeId).stopRequested')
  })

  // The store's doc for `inflight` says it is set BEFORE the codex-consent
  // await, precisely so the await window is covered. It was set AFTER (review of
  // the fix lane, finding 4): two RUN clicks during a consent dialog both got
  // through the guard. It is claimed right after the guard read now, and the
  // whole body — consent gate included — sits inside the try whose finally
  // clears it, so the "user cancelled" return cannot leave the node wedged.
  it('claims the run BEFORE the consent await, and clears it on every exit', () => {
    const guard   = hook.indexOf('nodeRunOf(useNodesRunStore.getState(), nodeId).inflight')
    const claim   = hook.indexOf('patch({ inflight: true, stopRequested: false })')
    const consent = hook.indexOf('await ensureCodexWriteConsent(')
    const release = hook.indexOf('patch({ inflight: false })')
    expect(guard).toBeGreaterThan(0)
    expect(claim).toBeGreaterThan(guard)
    expect(consent).toBeGreaterThan(claim)
    expect(release).toBeGreaterThan(consent)
  })
})

describe('the run panel + the lamps read the store', () => {
  it('NodesPage keeps no local panel flag', () => {
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).not.toContain('useState(false)\n  const [chatOpen')   // sanity: file shape
    expect(page).not.toContain('const [runPanelOpen, setRunPanelOpen] = useState')
    expect(page).toContain('useNodesRunStore(s => s.panelOpen)')
  })

  it('…and no local copy of the typed message either', () => {
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).not.toContain("const [runInput, setRunInput] = useState('')")
    expect(page).toContain('useNodesRunStore(s => s.runInput)')
    expect(page).toContain('useNodesRunStore(s => s.setRunInput)')
  })

  // EDGE RUN-INFO, second half (review of the fix lane, finding 6): the
  // 'graph:node-active' stream is EDGE-triggered — it speaks only when the run
  // moves to a new node. The unmount cleanup nulled activeNodeId, so coming back
  // to /nodes mid-node showed no running node and no animated edges until the
  // run advanced. The subscription now only MIRRORS the stream; the DOM classes
  // are painted by an effect driven off the store, so a remount re-applies them.
  it('the unmount cleanup no longer throws the active node away', () => {
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).not.toContain('clearAll(); useNodesRunStore.getState().setActiveNodeId(null)')
    expect(page).toContain('setActiveNodeId(nodeId || null)')
  })

  it('paints the highlight FROM the store, so a remount restores it', () => {
    const page = read('src/pages/nodes/NodesPage.tsx')
    expect(page).toContain('const activeNodeId = useNodesRunStore(s => s.activeNodeId)')
    // the paint effect re-runs on the store value
    expect(page).toContain('}, [activeNodeId])')
    expect(page).toContain('tachi-node-running')
  })

  it('every dot / lamp uses the ONE selector, so they cannot disagree', () => {
    for (const f of [
      'src/components/layout/Sidebar.tsx',
      'src/components/layout/AppShell.tsx',
      'src/components/OpusChrome.tsx',
      'src/components/TachikomaChrome.tsx',
    ]) {
      const src = read(f)
      expect(src, f).toContain('useNodesRunStore(nodesRunActive)')
      expect(src, f).not.toContain("useNodesRunStore(s => s.status.kind === 'running')")
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. STOP MUST ACTUALLY CANCEL
// ═════════════════════════════════════════════════════════════════════════════

describe('the media node offers a STOP that reaches the child process', () => {
  const node = read('src/pages/nodes/canvas/nodeTypes/MediaNode.tsx')
  const ui   = read('src/pages/nodes/canvas/NodeRunUI.tsx')

  it('routes through the PROVEN dispatcher, not a second cancel path', () => {
    expect(node).toContain("runActivityCancel({ kind: 'sd-generate' })")
  })

  it('only claims a stop where a child exists to kill (local sd.cpp)', () => {
    expect(node).toContain("provider === 'local'")
    expect(node).toContain('onStopRun')
  })

  it('the control row renders it while running', () => {
    expect(ui).toContain('onStopRun')
    expect(ui).toContain("t('runUI.stopRun'")
  })

  it('and the dispatcher really does call cancelGeneration', async () => {
    const { runActivityCancel } = await import('../../src/components/activity/activityCancel')
    const cancelGeneration = vi.fn(async () => ({ ok: true, cancelled: true }))
    const out = await runActivityCancel({ kind: 'sd-generate' }, { sdCpp: { cancelGeneration } })
    expect(cancelGeneration).toHaveBeenCalledTimes(1)
    expect(out.ok).toBe(true)
  })
})

// The other half of finding 1: the button. resetNodeRun refusing to forget a
// live run is the safety net; not offering a Clear mid-render is the UX. The row
// already disables RUN and the ×N chip while running — × was the odd one out.
describe('the × Clear is not offered while the node is running', () => {
  const ui = read('src/pages/nodes/canvas/NodeRunUI.tsx')
  /** The Clear button's JSX — from its `hasOutput &&` gate to the row's end. */
  const clearStart = ui.indexOf('{hasOutput && (')
  const clearEnd   = ui.indexOf('>×</button>')

  it('the Clear block is still findable (anchors, not vibes)', () => {
    expect(clearStart).toBeGreaterThan(0)
    expect(clearEnd).toBeGreaterThan(clearStart)
  })

  it('is disabled while a run or a fan-out is in flight', () => {
    const clear = ui.slice(clearStart, clearEnd)
    expect(clear).toContain('disabled={running}')
  })

  it('and says WHY rather than just going grey', () => {
    const clear = ui.slice(clearStart, clearEnd)
    expect(clear).toContain("t('runUI.clearBusyTitle'")
  })
})

// A file:/// URL cannot be loaded by a renderer served over http://localhost —
// NodeRunUI learned that and routes through the tachi-media:// protocol
// registered in main. The Run panel's own artifact renderer still built
// file:/// URLs, so every media result it showed for an on-disk artifact was a
// broken player (review of the fix lane, finding 8).
describe('the Run panel renders artifacts through tachi-media://', () => {
  const page = read('src/pages/nodes/NodesPage.tsx')

  it('has no local file:/// builder left', () => {
    expect(page).not.toContain("`file:///${p.replace(/\\\\/g, '/')")
    expect(page).not.toContain('const toFileUrl =')
  })

  it('shares NodeRunUI’s helper instead of a second copy', () => {
    expect(page).toContain("import { fileUrl } from './canvas/NodeRunUI'")
    expect(page).toContain('fileUrl(path)')
  })

  it('and that helper really is the protocol one', () => {
    expect(read('src/pages/nodes/canvas/NodeRunUI.tsx'))
      .toContain('return `tachi-media://artifact/${encodeURIComponent(p)}`')
  })
})

describe('the STOP label ships in every locale', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']
  it('runUI.stopRun + runUI.stopRunTitle exist in all 8', () => {
    for (const l of LANGS) {
      const ns = JSON.parse(read(`src/i18n/locales/${l}/nodes.json`)) as { runUI?: Record<string, string> }
      expect(ns.runUI?.stopRun, l).toBeTruthy()
      expect(ns.runUI?.stopRunTitle, l).toBeTruthy()
    }
  })
})
