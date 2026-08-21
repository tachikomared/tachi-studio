// NODES-RESEARCH #4: self-healing template check. analyzeFlow is the PURE,
// deterministic semantic pass that turns a loaded flow + an environment snapshot
// into a list of one-click-repairable issues (missing provider key, un-downloaded
// local model, engine not running, missing folder/skill/codex). It must be
// STRICTLY fail-open: an unknown node shape or a missing env field yields NO
// issue — a working flow is never blocked by a false alarm.
import { describe, it, expect } from 'vitest'
import { analyzeFlow, type FlowDoctorEnv } from '../../src/pages/nodes/flow-doctor'
import type { TachiNode, TachiEdge } from '../../src/pages/nodes/types'

// ── Node factories (cast through unknown — synthetic graphs, not real store nodes) ──
const provider = (id: string, providerId: string, model?: string): TachiNode =>
  ({ id, type: 'provider', position: { x: 0, y: 0 }, data: { label: `prov-${id}`, providerId, ...(model !== undefined ? { model } : {}) } } as unknown as TachiNode)
const promptNode = (id: string, providerId: string): TachiNode =>
  ({ id, type: 'prompt', position: { x: 0, y: 0 }, data: { label: `prompt-${id}`, providerId, instruction: 'x' } } as unknown as TachiNode)
const media = (id: string, prov?: string): TachiNode =>
  ({ id, type: 'media', position: { x: 0, y: 0 }, data: { label: `media-${id}`, modality: 'image', ...(prov !== undefined ? { provider: prov } : {}) } } as unknown as TachiNode)
const agent = (id: string, harnessId = 'openclaude'): TachiNode =>
  ({ id, type: 'agent', position: { x: 0, y: 0 }, data: { label: `agent-${id}`, harnessId } } as unknown as TachiNode)
const folder = (id: string, path: string): TachiNode =>
  ({ id, type: 'folder', position: { x: 0, y: 0 }, data: { label: `folder-${id}`, path } } as unknown as TachiNode)
const skill = (id: string, data: Record<string, unknown>): TachiNode =>
  ({ id, type: 'skill', position: { x: 0, y: 0 }, data: { label: `skill-${id}`, ...data } } as unknown as TachiNode)

const NO_EDGES: TachiEdge[] = []

/** A fully-populated env in which everything a healthy flow needs is present. */
const fullEnv: FlowDoctorEnv = {
  connectedProviders: ['freellmapi-local', 'bankr-gateway', 'surplus', 'llama-cpp', 'ollama-local'],
  storedKeys: ['bankr-gateway', 'surplus'],
  localModels: { installed: ['qwen2.5-7b'], loaded: ['qwen2.5-7b'] },
  codexInstalled: true,
  existingFolders: { '/work': true },
  availableSkills: ['my-skill', 'security-engineer'],
}

describe('analyzeFlow — per-issue detection', () => {
  it('provider-key: a cloud provider with no stored key is flagged', () => {
    const issues = analyzeFlow([provider('p', 'bankr')], NO_EDGES, { connectedProviders: [], storedKeys: [] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      nodeId: 'p', kind: 'provider-key', label: 'prov-p',
      fix: { kind: 'navigate', to: 'providers' },
    })
  })

  it('provider-key: fires for prompt nodes and (default-Surplus) media nodes too', () => {
    const issues = analyzeFlow(
      [promptNode('pr', 'bankr'), media('m') /* no provider → defaults to surplus */],
      NO_EDGES,
      { storedKeys: [] },
    )
    expect(issues.map(i => i.kind)).toEqual(['provider-key', 'provider-key'])
    expect(issues.map(i => i.nodeId)).toEqual(['pr', 'm'])
  })

  it('provider-key: a keyless/local provider (freellmapi, llama.cpp) is never flagged', () => {
    const issues = analyzeFlow(
      [provider('a', 'freellmapi'), provider('b', 'llamacpp', 'auto')],
      NO_EDGES,
      { connectedProviders: [], storedKeys: [] },
    )
    expect(issues.filter(i => i.kind === 'provider-key')).toEqual([])
  })

  it('local-model: a specific llama.cpp model that is not downloaded is flagged', () => {
    const issues = analyzeFlow(
      [provider('l', 'llamacpp', 'qwen2.5-14b')],
      NO_EDGES,
      { localModels: { installed: ['qwen2.5-7b'], loaded: [] } },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'local-model', nodeId: 'l', fix: { kind: 'navigate', to: 'catalog' } })
    expect(issues[0]!.detail).toMatchObject({ model: 'qwen2.5-14b' })
  })

  it('engine-off: a downloaded llama.cpp model whose engine is not running it is flagged', () => {
    const issues = analyzeFlow(
      [provider('l', 'llamacpp', 'qwen2.5-7b')],
      NO_EDGES,
      { localModels: { installed: ['qwen2.5-7b'], loaded: [] } },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'engine-off', nodeId: 'l', fix: { kind: 'navigate', to: 'catalog' } })
  })

  it("local checks ignore the 'auto' model (no specific-model requirement)", () => {
    const issues = analyzeFlow(
      [provider('l', 'llamacpp', 'auto'), provider('l2', 'llamacpp', '')],
      NO_EDGES,
      { localModels: { installed: [], loaded: [] } },
    )
    expect(issues).toEqual([])
  })

  it('folder-missing: an empty folder path is flagged even with no env (structural fact)', () => {
    const issues = analyzeFlow([folder('f', '')], NO_EDGES, {})
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'folder-missing', nodeId: 'f', fix: { kind: 'pick-folder' } })
    expect(issues[0]!.detail).toMatchObject({ reason: 'empty' })
  })

  it('folder-missing: a concrete path absent on disk is flagged', () => {
    const issues = analyzeFlow([folder('f', '/gone')], NO_EDGES, { existingFolders: { '/gone': false } })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'folder-missing', nodeId: 'f' })
    expect(issues[0]!.detail).toMatchObject({ reason: 'missing', path: '/gone' })
  })

  it('folder-missing: a concrete path that exists is NOT flagged', () => {
    const issues = analyzeFlow([folder('f', '/work')], NO_EDGES, { existingFolders: { '/work': true } })
    expect(issues).toEqual([])
  })

  it('codex-missing: a codex agent node while codex is not installed is flagged', () => {
    const issues = analyzeFlow([agent('c', 'codex')], NO_EDGES, { codexInstalled: false })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'codex-missing', nodeId: 'c', fix: { kind: 'navigate', to: 'settings' } })
  })

  it('codex-missing: a non-codex agent is never flagged', () => {
    const issues = analyzeFlow([agent('a', 'openclaude')], NO_EDGES, { codexInstalled: false })
    expect(issues).toEqual([])
  })

  it('skill-missing: a bare skill referencing an unavailable skill is flagged', () => {
    const issues = analyzeFlow([skill('s', { skillId: 'ghost-skill' })], NO_EDGES, { availableSkills: ['my-skill'] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'skill-missing', nodeId: 's', fix: { kind: 'navigate', to: 'skills' } })
    expect(issues[0]!.detail).toMatchObject({ skill: 'ghost-skill' })
  })

  it('skill-missing: self-contained role/permission nodes (allowedTools, roleId, tier) are never flagged', () => {
    const nodes = [
      skill('withTools', { skillId: 'rag-role', allowedTools: ['Read', 'Glob'] }),
      skill('withRole',  { roleId: 'security-engineer' }),
      skill('tier',      { skillId: 'read-only' }),
    ]
    const issues = analyzeFlow(nodes, NO_EDGES, { availableSkills: [] })
    expect(issues.filter(i => i.kind === 'skill-missing')).toEqual([])
  })
})

describe('analyzeFlow — healthy flows produce zero issues', () => {
  it('a fully-connected flow yields no issues', () => {
    const nodes = [
      provider('p', 'bankr', 'claude-sonnet-4.6'),
      agent('a', 'openclaude'),
      folder('f', '/work'),
      skill('s', { skillId: 'read-only', allowedTools: ['Read'] }),
    ]
    expect(analyzeFlow(nodes, NO_EDGES, fullEnv)).toEqual([])
  })

  it('a free/local template (freellmapi + auto llama.cpp) is clean with a full env', () => {
    const nodes = [provider('p', 'freellmapi', 'auto'), provider('l', 'llamacpp', 'qwen2.5-7b'), agent('a')]
    expect(analyzeFlow(nodes, NO_EDGES, fullEnv)).toEqual([])
  })
})

describe('analyzeFlow — fail-open', () => {
  it('unknown / malformed node shapes produce NO issue', () => {
    const junk = [
      { id: 'x', type: 'frobnicator', position: { x: 0, y: 0 }, data: { label: 'X' } },
      { id: 'y', type: 'provider', position: { x: 0, y: 0 }, data: {} },        // provider, no providerId
      { id: 'z', type: 'agent', position: { x: 0, y: 0 } },                     // no data at all
      null,
      'not-a-node',
      { type: 'provider' },                                                      // no id
    ] as unknown as TachiNode[]
    expect(analyzeFlow(junk, NO_EDGES, fullEnv)).toEqual([])
  })

  it('an empty / undefined env disables every env-dependent check', () => {
    const nodes = [
      provider('p', 'bankr', 'claude-sonnet-4.6'), // needs key, but no key info
      provider('l', 'llamacpp', 'qwen2.5-14b'),    // specific local model, but no localModels
      agent('c', 'codex'),                         // codex, but codexInstalled unknown
      folder('f', '/somewhere'),                   // concrete path, but no existingFolders
      skill('s', { skillId: 'ghost' }),            // bare skill, but no availableSkills
    ]
    expect(analyzeFlow(nodes, NO_EDGES, {})).toEqual([])
  })

  it('a non-array nodes input returns []', () => {
    expect(analyzeFlow(undefined as unknown as TachiNode[], NO_EDGES, {})).toEqual([])
  })
})

describe('analyzeFlow — determinism & multiplicity', () => {
  it('emits issues in node order, one per offending node', () => {
    const nodes = [
      folder('f1', ''),
      provider('p', 'bankr'),
      folder('f2', ''),
    ]
    const issues = analyzeFlow(nodes, NO_EDGES, { connectedProviders: [], storedKeys: [] })
    expect(issues.map(i => i.nodeId)).toEqual(['f1', 'p', 'f2'])
    expect(issues.map(i => i.kind)).toEqual(['folder-missing', 'provider-key', 'folder-missing'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SEGMENT LENGTH — the FLF chaining policy
// ═════════════════════════════════════════════════════════════════════════════
//
// The storyboard technique (LOWVRAM-META-RESEARCH DELTA ADDENDUM, "FLF
// CHAINING") builds minutes out of ~5 s scenes, and its second rule is a
// SEGMENT-LENGTH CEILING: past ~80 frames an unpatched Wan loses coherence, so
// the honest unit of a chain is 81 frames (4n+1, upstream's own --frame_num
// default and trained clip length).
//
// The engine path already CLAMPS to 81 (localGenParams::normalizeWanFrames), so
// a node asking for 12 s does not fail — it silently renders 5 s. That silence
// is the bug this check cures: the doctor says out loud that the length asked
// for is not the length that will render, and points at the fix that actually
// works (another scene, not a longer one).
//
// It is a WARNING, never a block: `fix: none`, no button, and — like every
// other check here — strictly scoped, because a doctor that cries wolf on a
// working flow is worse than no doctor.

const videoMedia = (id: string, params: Record<string, unknown>, provider = 'local'): TachiNode =>
  ({ id, type: 'media', position: { x: 0, y: 0 },
     data: { label: `vid-${id}`, modality: 'video', provider, model: 'wan-2.1-i2v', params } } as unknown as TachiNode)

const imageMedia = (id: string, provider = 'local'): TachiNode =>
  ({ id, type: 'media', position: { x: 0, y: 0 },
     data: { label: `img-${id}`, modality: 'image', provider, model: 'sd-1.5', params: {} } } as unknown as TachiNode)

/** A wire into a media node's `image` plug — the init-frame handoff. */
const chainEdge = (source: string, target: string): TachiEdge =>
  ({ id: `${source}->${target}`, source, target, sourceHandle: 'out', targetHandle: 'image', type: 'link' } as unknown as TachiEdge)

describe('analyzeFlow — chained video segments over the 81-frame ceiling', () => {
  it('warns when a chained segment asks for more than 81 frames', () => {
    const issues = analyzeFlow(
      [imageMedia('still'), videoMedia('seg', { duration: 12 })],
      [chainEdge('still', 'seg')],
      {},
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ nodeId: 'seg', kind: 'segment-length', label: 'vid-seg' })
  })

  it('is a WARNING — it offers no repair button and never blocks', () => {
    const [issue] = analyzeFlow(
      [imageMedia('still'), videoMedia('seg', { duration: 12 })],
      [chainEdge('still', 'seg')],
      {},
    )
    expect(issue!.fix).toEqual({ kind: 'none' })
  })

  it('reports what was asked for AND the cap, so the copy can be concrete', () => {
    const [issue] = analyzeFlow(
      [imageMedia('still'), videoMedia('seg', { duration: 12 })],
      [chainEdge('still', 'seg')],
      {},
    )
    // 12 s x 16 fps = 192 -> snapped to 4n+1 = 193; the cap stays 81.
    expect(issue!.detail).toMatchObject({ frames: '193', cap: '81' })
  })

  it('fires for the UPSTREAM segment too — it is equally part of the chain', () => {
    const issues = analyzeFlow(
      [videoMedia('seg1', { duration: 10 }), videoMedia('seg2', { duration: 3 })],
      [chainEdge('seg1', 'seg2')],
      {},
    )
    expect(issues.map(i => i.nodeId)).toEqual(['seg1'])
  })

  it('reads a raw `frames` request too (a remixed / hand-edited bag)', () => {
    const issues = analyzeFlow(
      [videoMedia('a', { frames: 161 }), videoMedia('b', {})],
      [chainEdge('a', 'b')],
      {},
    )
    expect(issues.map(i => i.kind)).toEqual(['segment-length'])
    expect(issues[0]!.detail).toMatchObject({ frames: '161' })
  })

  it('uses the ROW frame rate: 5 s on the 24 fps TI2V-5B is 121 frames — over the cap', () => {
    // At the 16 fps default this same ask computes exactly 81 and stays silent —
    // the under-report the rows lane deferred. localVideoFpsFor closes it.
    const seg = videoMedia('seg', { duration: 5 })
    ;(seg.data as Record<string, unknown>).model = 'wan22-ti2v-5b'
    const issues = analyzeFlow([imageMedia('still'), seg], [chainEdge('still', 'seg')], {})
    expect(issues.map(i => i.kind)).toEqual(['segment-length'])
    expect(issues[0]!.detail).toMatchObject({ frames: '121', cap: '81' })
  })

  it('the same 5 s on a 16 fps row is exactly the cap — no warning', () => {
    const issues = analyzeFlow(
      [imageMedia('still'), videoMedia('seg', { duration: 5 })],
      [chainEdge('still', 'seg')],
      {},
    )
    expect(issues).toEqual([])
  })

  it('PIN: the renderer fps-exception mirror matches sd-cpp-models exactly', async () => {
    const { LOCAL_VIDEO_FPS_EXCEPTIONS } = await import('../../src/pages/media/localGenParams')
    const { SD_VIDEO_MODELS } = await import('../../electron/services/sd-cpp-models')
    const truth: Record<string, number> = {}
    for (const m of SD_VIDEO_MODELS) {
      const fps = (m as { fps?: number }).fps
      if (typeof fps === 'number' && fps !== 16) truth[m.id] = fps
    }
    expect(LOCAL_VIDEO_FPS_EXCEPTIONS).toEqual(truth)
  })

  it('says nothing at exactly 81 frames — the ceiling is allowed', () => {
    expect(analyzeFlow(
      [videoMedia('a', { frames: 81 }), videoMedia('b', { duration: 5 })],
      [chainEdge('a', 'b')],
      {},
    )).toEqual([])
  })

  it('says nothing about an UNCHAINED video node, however long', () => {
    expect(analyzeFlow([videoMedia('lonely', { duration: 30 })], NO_EDGES, {})).toEqual([])
  })

  it('says nothing about a CLOUD segment — the ceiling is Wan\'s, not a law', () => {
    expect(analyzeFlow(
      [videoMedia('a', { duration: 20 }, 'venice'), videoMedia('b', { duration: 20 }, 'venice')],
      [chainEdge('a', 'b')],
      { storedKeys: ['venice'], connectedProviders: ['venice'] },
    )).toEqual([])
  })

  it('says nothing about an IMAGE node in a chain', () => {
    expect(analyzeFlow(
      [imageMedia('a'), imageMedia('b')],
      [chainEdge('a', 'b')],
      {},
    )).toEqual([])
  })

  it('fail-open: an unreadable duration is not a complaint', () => {
    expect(analyzeFlow(
      [videoMedia('a', { duration: 'soon' }), videoMedia('b', { duration: null })],
      [chainEdge('a', 'b')],
      {},
    )).toEqual([])
  })

  it('fail-open: a media node with no params at all is fine', () => {
    const bare = ({ id: 'a', type: 'media', position: { x: 0, y: 0 },
      data: { label: 'a', modality: 'video', provider: 'local' } } as unknown as TachiNode)
    expect(analyzeFlow([bare, videoMedia('b', {})], [chainEdge('a', 'b')], {})).toEqual([])
  })

  it('a chain wired through an Output card still counts as chained', () => {
    const card = ({ id: 'card', type: 'output', position: { x: 0, y: 0 },
      data: { label: 'card', kind: 'media', sourceId: 'a' } } as unknown as TachiNode)
    const issues = analyzeFlow(
      [videoMedia('a', { duration: 3 }), card, videoMedia('b', { duration: 12 })],
      [chainEdge('a', 'card'), chainEdge('card', 'b')],
      {},
    )
    expect(issues.map(i => i.nodeId)).toEqual(['b'])
  })

  it('coexists with the other checks, still in node order', () => {
    const issues = analyzeFlow(
      [folder('f', ''), videoMedia('a', { duration: 3 }), videoMedia('b', { duration: 12 })],
      [chainEdge('a', 'b')],
      {},
    )
    expect(issues.map(i => i.kind)).toEqual(['folder-missing', 'segment-length'])
  })
})
