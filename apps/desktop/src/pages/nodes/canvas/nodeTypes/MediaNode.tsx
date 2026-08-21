// apps/desktop/src/pages/nodes/canvas/nodeTypes/MediaNode.tsx
//
// Media node — generates non-text media (image / video / music / TTS / STT)
// through the Surplus media engine.
//
// One shared component keyed by data.modality so the five media kinds stay DRY.
// Each node has:
//   - a header showing the modality
//   - a model picker filtered to the node's modality (surplusMedia.listModels)
//   - SCHEMA-DRIVEN params (<ParamFields> rendered from surplusMedia.modelParams)
//   - a reference-aware prompt template (<ReferenceField>: @ / {{ to pull an
//     upstream node's output via a {{node:<id>}} token)
//   - a per-node Run button + inline artifact/transcript preview + a PIN toggle
//
// #1 PARAMS: controls are RENDERED FROM the model's ParamSpec[]; collected
//    values live in data.params keyed by ParamSpec.name and are forwarded to the
//    engine as its `params` field at run time (the compiler strips typed-field
//    keys + the renderer-only audioPath). The STT audio control mirrors its value
//    into params.audioPath, the renderer→multipart key the engine expects.
// #2 REFERENCES: the prompt is a TEMPLATE that may embed {{node:<id>}} tokens;
//    the live "Resolves to:" preview substitutes upstream lastOutputs.
// #3 PER-NODE RUN: Run executes JUST this node via window.tachi.nodes.runNode
//    (the prompt's tokens / wired prompt plug resolve against upstream
//    lastOutputs in main; video/music polling happens in main). PIN freezes the
//    output as a downstream reference source.
//
// TYPED INPUT PLUGS (kept intact — tokens are ADDITIVE):
//   - `prompt` TARGET (left, upper): a wired text chain feeds the prompt.
//   - `folder` TARGET (left, lower): a wired Folder node = the auto-save dir.
//   - `out`    SOURCE (right): reserved for future chaining (e.g. STT text).

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { TachiMediaNode, MediaNodeModality } from '../../types'
import type { ParamSpec } from '../../../../types/electron'
import { useNodesStore } from '../../store/nodes.store'
import { ParamFields } from '../../../media/ParamFields'
import { ReferenceField } from '../ReferenceField'
import { useUpstreamRefs } from '../useUpstreamRefs'
import { useMediaModels, normalizeMediaProvider, type MediaProvider } from '../../useMediaModels'
import { ErrorHandle } from '../EightHandles'
import { useNodeRun } from '../useNodeRun'
import { nextFanoutCount, type FanoutCount } from '../fanout'
// pollinationsVisibleSchema: the pollinations route renders only the controls
// its GET actually carries (prompt/size/seed) — same filter the composer uses.
import { SD_STYLES, presetsForRow, pollinationsVisibleSchema } from '../../../media/mediaHelpers'
// The SHARED pure param module — the same one the local branch in main reads, so
// the canvas cannot drift from the media tab a fourth time (audit D3).
import {
  applyParamEdit, reseedRecipeParams,
  LOCAL_ROW_OWNED_PARAMS, RECIPE_OWNED_PARAMS,
} from '../../../media/localGenParams'
import { RunControls, InlineTextPreview } from '../NodeRunUI'
// The app's ONE stop dispatcher (descriptor → IPC). Reused rather than calling
// sdCpp.cancelGeneration here, so the canvas Stop and the activity rail's Stop
// are provably the same kill — see components/activity/activityCancel.ts.
import { runActivityCancel } from '../../../../components/activity/activityCancel'

// ── Per-modality presentation ─────────────────────────────────────────────────

const COLOR = 'var(--accent)'

const MODALITY_LABEL: Record<MediaNodeModality, string> = {
  image: 'image',
  video: 'video',
  music: 'music',
  tts:   'tts · speech',
  stt:   'stt · transcribe',
}

// ── Styles ───────────────────────────────────────────────────────────────────

const nodeStyle: React.CSSProperties = {
  position: 'relative',
  background: 'var(--bg-surface)',
  border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace',
  width: 260,
  boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: `2px solid ${COLOR}`,
  background: COLOR,
  color: 'var(--bg-base)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginBottom: 3, marginTop: 8,
}
const selectStyle: React.CSSProperties = {
  width: '100%', padding: '3px 4px', border: '2px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
}
const subStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block' }

// Typed plug handle visuals — VISIBLE (unlike EightHandles) + labeled so they
// are discoverable. prompt/folder are targets on the left; out is a source.
const plugHandleStyle: React.CSSProperties = {
  width: 11, height: 11, background: COLOR, border: '2px solid var(--bg-base)', borderRadius: 0,
}
const plugLabelStyle: React.CSSProperties = {
  position: 'absolute', fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace',
  pointerEvents: 'none', whiteSpace: 'nowrap',
}

// Param keys handled by dedicated controls OUTSIDE the schema list, so we don't
// render them twice: the prompt-equivalent text param (image/video/music prompt,
// tts input) is the ReferenceField; the STT audio param is its own control.
const PROMPT_PARAM: Record<MediaNodeModality, string> = {
  image: 'prompt', video: 'prompt', music: 'prompt', tts: 'input', stt: '',
}

// ── Component ────────────────────────────────────────────────────────────────

export function MediaNode({ id, data }: NodeProps<TachiMediaNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const edges          = useNodesStore(s => s.edges)
  const [hover, setHover] = useState(false)

  // When something is wired into the `prompt` plug, that upstream output IS the
  // prompt — so the manual prompt field is disabled (you can't type + wire both).
  const promptWired = edges.some(e => e.target === id && e.targetHandle === 'prompt')
  // Likewise the `image` plug: a wired Reference-Image / Output-card IS the
  // reference, so the in-node "Choose image" control is disabled.
  const imageWired  = edges.some(e => e.target === id && e.targetHandle === 'image')

  const modality = data.modality
  const provider: MediaProvider = normalizeMediaProvider(data.provider, modality)
  const isPinned = data.pinned === true
  const params = useMemo(
    () => (data.params ?? {}) as Record<string, unknown>,
    [data.params],
  )

  const upstream = useUpstreamRefs(id)
  const { run, runNode, reset, cancelFanout, fanout } = useNodeRun(id)
  // FAN-OUT xN — how many sibling runs the next RUN fires (x1 = today's single).
  const [fanoutCount, setFanoutCount] = useState<FanoutCount>(1)

  // ── Performance preset + style (local image/video only) ─────────────────────
  /** Active performance preset id stored on the node data, or null. */
  const activePerfPreset: string | null = typeof data.perfPreset === 'string' ? data.perfPreset : null
  /** Active style id stored on the node data (default 'none'). */
  const activeStyle: string = typeof data.stylePreset === 'string' ? data.stylePreset : 'none'

  // Model catalog filtered to this node's modality — shared hook (also drives
  // the Configure panel) so the dropdown is identical everywhere. `localRows`
  // carries the DECLARED family + recipe of every installed local checkpoint.
  const { models, error: catalogErr, localRows } = useMediaModels(provider, modality)

  /** The INSTALLED row behind this node's model (undefined for cloud). */
  const activeLocalRow = localRows[data.model ?? '']

  // THE FAMILY IS NEVER GUESSED HERE ANY MORE (audit D16). This node used to
  // read it off the id string — `includes('xl')` → sdxl — which
  // mediaLocalModelTruth pins as the trap: `civitai-812345` is an SDXL
  // checkpoint with no substring at all, and an SD 1.5 merge named "…-xl-…"
  // claimed SDXL. MediaPage was fixed and the node was not. Both now ask the
  // ROW, through the same presetsForRow that reads `family` off it directly.

  /** Tiers this ROW can honestly offer — empty for a distilled checkpoint. */
  const offeredPresets = useMemo(
    () => (activeLocalRow ? presetsForRow(activeLocalRow) : []),
    [activeLocalRow],
  )

  /**
   * Apply a performance preset — under the SCHEMA's param names (audit D1).
   * `cfgScale` / `samplingMethod` are read by nothing: the arg builder takes
   * `cfg` / `sampler`, so this picker was writing keys that never ran.
   */
  const applyPerfPreset = useCallback((presetId: string) => {
    const tier = offeredPresets.find(p => p.id === presetId)?.params
    if (!tier) return
    const next: Record<string, unknown> = {
      ...params,
      steps:   tier.steps,
      sampler: tier.samplingMethod,
      cfg:     tier.cfgScale,
    }
    updateNodeData(id, { params: next, perfPreset: presetId })
  }, [offeredPresets, params, id, updateNodeData])

  const model = data.model ?? models[0]?.id ?? ''

  // Schema-driven param specs for the chosen (modality, model). Adding a param
  // is a DATA change in the engine — no UI code here.
  const [schema, setSchema] = useState<ParamSpec[]>([])
  /** The model id this node last RE-SEEDED for. A ref: it gates an effect, it
   *  must not cause a render, and it has to survive the fetch it gates. */
  const seededForModelRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!model) { setSchema([]); return }
    window.tachi.surplusMedia.modelParams({ modality, modelId: model })
      .then(res => {
        if (cancelled) return
        const specs = res.params ?? []
        setSchema(specs)

        // ── A CHECKPOINT SWITCH RE-SEEDS THE PARAMS THE ROW OWNS ──────────────
        //
        // The 'stuck valid params' bug class, on the surface that never got the
        // cure: MediaPage's schema effect has re-seeded the row-owned params
        // since the mush incident (SD-Turbo's steps:1 / euler surviving onto a
        // 20-step checkpoint and rendering mush), and this node wrote
        // `{ model }` and nothing else. So a Wan negative sat in a node's bag
        // through a switch to a distilled row whose schema default is ''
        // PRECISELY to clear it — and healParamsForSchema can never catch that
        // family, because every stale value is in-range and in-enum.
        //
        // ONLY ON A REAL SWITCH. First mount seeds nothing (an untouched canvas
        // node is honest by construction — the FLF fix put the row default in at
        // ENGINE ASSEMBLY instead), and a re-fetch for the SAME model must keep
        // what the user just set. MediaPage's one extra gate — its restore/remix
        // exemption — has no canvas counterpart: nothing restores a params bag
        // into a node, so there is no provenance here to protect.
        const priorModel = seededForModelRef.current
        seededForModelRef.current = model
        if (priorModel === null || priorModel === model) return

        // The BAG is read from the store, not closed over: `params` in the deps
        // would re-fetch the whole schema on every keystroke, and what matters
        // is the bag as it stands now, after the IPC round trip.
        const live = useNodesStore.getState().nodes.find(n => n.id === id)
        const bag = (live?.data as { params?: Record<string, unknown> } | undefined)?.params ?? {}
        // `size` + `negative_prompt` are row-owned on the LOCAL route only —
        // every cloud image schema declares a `size` default too, so re-seeding
        // it there would throw away a deliberate 1536x1536 on each model change.
        const rowOwned = provider === 'local' ? LOCAL_ROW_OWNED_PARAMS : RECIPE_OWNED_PARAMS
        const { next, changed } = reseedRecipeParams(bag, specs, rowOwned)
        if (changed) updateNodeData(id, { params: next })
      })
      .catch(() => { if (!cancelled) setSchema([]) })
    return () => { cancelled = true }
  }, [modality, model, provider, id, updateNodeData])

  // The ReferenceField edits the prompt template stored on data.prompt (NOT in
  // params) so it round-trips through the existing prompt-plug + token compiler.
  const promptParam = PROMPT_PARAM[modality]

  // Schema fields rendered by <ParamFields>: everything EXCEPT the prompt-equivalent
  // text param (handled by ReferenceField). For STT the audio `file` param stays
  // in the schema list (rendered as its own audio control by ParamFields).
  const paramSchema = useMemo(
    () => (provider === 'pollinations' ? pollinationsVisibleSchema(schema) : schema).filter(s =>
      s.name !== promptParam
      // Hide the in-node reference-image control when one is wired into `image`.
      && !(imageWired && (s.kind === 'image' || s.name === 'image_url')),
    ),
    [schema, promptParam, imageWired, provider],
  )

  // Required-param gate: surface a hint when a required field is blank.
  const missingRequired = useMemo(
    () => paramSchema
      .filter(s => s.required)
      .filter(s => { const v = params[s.name]; return v == null || v === '' })
      .map(s => s.label),
    [paramSchema, params],
  )

  const setParam = useCallback((name: string, value: unknown) => {
    // Delete-on-empty, EXCEPT for the negative prompt — see applyParamEdit. This
    // node used to drop the key on '', which re-rendered the row default into the
    // textarea and put Wan's official negative back onto the argv behind the back
    // of a user who had just cleared the field (review of the FLF fix lane).
    const next: Record<string, unknown> = applyParamEdit(params, name, value)
    // STT: the engine reads the audio file from params.audioPath (renderer key),
    // so mirror whatever the audio control wrote into audioPath too.
    if (modality === 'stt') {
      const audioSpec = schema.find(s => s.kind === 'audio')
      if (audioSpec && name === audioSpec.name) {
        if (value == null || value === '') delete next.audioPath
        else next.audioPath = value
      }
    }
    updateNodeData(id, { params: next })
  }, [id, params, updateNodeData, modality, schema])

  const clearOutput = useCallback(() => {
    updateNodeData(id, { lastOutput: undefined, lastArtifacts: undefined })
    reset()
  }, [id, updateNodeData, reset])

  /**
   * Stop THIS render. Offered on the LOCAL IMAGE/VIDEO route and nowhere else —
   * a queued cloud job has no handle, and a button that cannot stop anything is
   * the lie the activity rail already refuses to print.
   *
   * WHY THE MODALITY IS PART OF THE GATE (review of the FLF fix lane): this
   * descriptor resolves to sdCpp.cancelGeneration and nothing else. On a local
   * TTS node (piper) it killed NOTHING while latching media.store's stopping
   * flag — and worse, whatever sd render happened to be running elsewhere is the
   * process that actually died. A stop that stops someone else's work is a
   * sharper version of the same lie.
   *
   * No confirm: `window.confirm` freezes this renderer (house gotcha), and
   * asking "are you sure" while a GPU burns is the wrong question anyway.
   */
  const stopLocalRun = useCallback(() => {
    void runActivityCancel({ kind: 'sd-generate' })
  }, [])

  const cachedArtifacts = Array.isArray(data.lastArtifacts) ? data.lastArtifacts : []
  const hasOutput =
    (typeof data.lastOutput === 'string' && data.lastOutput.length > 0) ||
    cachedArtifacts.length > 0

  return (
    <div
      style={isPinned ? { ...nodeStyle, boxShadow: `0 0 0 2px var(--accent-muted), 4px 4px 0 ${COLOR}` } : nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>media · {MODALITY_LABEL[modality]}{isPinned ? ' · PINNED' : ''}</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        )}
      </div>

      <div style={bodyStyle}>
        {/* Provider — Surplus (marketplace), Venice (standalone), imgnAI Katana
            (image + video), Pollinations (image, keyless cloud), or Local
            (sd.cpp / piper). */}
        <label style={{ ...fieldLabelStyle, marginTop: 0 }}>{t('mediaNode.providerLabel')}</label>
        <select
          className="nodrag"
          value={provider}
          onChange={(e) => updateNodeData(id, { provider: e.target.value as MediaProvider, model: undefined })}
          style={selectStyle}
        >
          <option value="surplus">Surplus</option>
          <option value="venice">Venice</option>
          {(modality === 'image' || modality === 'video') && <option value="imgnai">imgnAI</option>}
          {modality === 'image' && <option value="pollinations">Pollinations</option>}
          {(modality === 'image' || modality === 'video' || modality === 'tts') && <option value="local">{t('mediaNode.providerLocal')}</option>}
        </select>

        {/* Model picker (filtered to this modality + provider) */}
        <label style={fieldLabelStyle}>{t('mediaNode.modelLabel')}</label>
        {models.length > 0 ? (
          <select
            className="nodrag"
            value={model}
            onChange={(e) => updateNodeData(id, { model: e.target.value })}
            style={selectStyle}
          >
            {/* THE STALE-MODEL LIE (audit 3D-3): a saved node whose model id
                fell out of the catalog (removed, renamed, or never installed
                on this machine) rendered NO option for it — the select looked
                blank while `model` (what RUN actually sends) stayed the stale
                id. Rendered here as a visible, DISABLED option instead: the
                user sees exactly what would run and that it is not a real
                choice, rather than a control that shows nothing while the
                node quietly keeps it. Mirrors NodeConfigPanel's ModelField
                out-of-catalog option, disabled here because — unlike that
                free-text field — re-selecting this value is never the fix. */}
            {model !== '' && !models.some(m => m.id === model) && (
              <option value={model} disabled>
                {t('mediaNode.staleModel', { id: model, defaultValue: '{{id}} (not installed)' })}
              </option>
            )}
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </select>
        ) : (
          <span style={{ ...subStyle, color: 'var(--warning)', fontSize: 9 }}>
            {catalogErr ? t('mediaNode.noModelsErr', { error: catalogErr }) : t('mediaNode.noModels')}
          </span>
        )}

        {/* ── Performance preset + style (local image/video only) ──────────── */}
        {/* Fills steps/samplingMethod/cfgScale from a single tier pick. The node
            runner already reads these from params at run time — no IPC change. */}
        {provider === 'local' && (modality === 'image' || modality === 'video') && (
          <>
            {/* Hidden when the row can offer no honest tier (audit D5). */}
            {offeredPresets.length > 0 && (<>
            <label style={{ ...fieldLabelStyle, marginTop: 10 }}>{t('mediaNode.perfPreset')}</label>
            <select
              className="nodrag"
              value={activePerfPreset ?? ''}
              onChange={e => {
                const presetId = e.target.value
                if (presetId) applyPerfPreset(presetId)
                else updateNodeData(id, { perfPreset: null })
              }}
              style={selectStyle}
            >
              <option value="">{t('mediaNode.perfPresetPlaceholder')}</option>
              {offeredPresets.map(p => (
                <option key={p.id} value={p.id} title={`${p.params.steps} · cfg ${p.params.cfgScale} · ${p.params.samplingMethod}`}>
                  {t(`presets.${p.id}.label`, { ns: 'media' })} · {p.params.steps}
                </option>
              ))}
            </select>
            </>)}

            {modality === 'image' && (
              <>
                <label style={{ ...fieldLabelStyle, marginTop: 8 }}>{t('mediaNode.stylePreset')}</label>
                <select
                  className="nodrag"
                  value={activeStyle}
                  onChange={e => updateNodeData(id, { stylePreset: e.target.value })}
                  style={selectStyle}
                >
                  {SD_STYLES.map(s => (
                    <option key={s.id} value={s.id}>{t(`styles.${s.id}.label`, { ns: 'media' })}</option>
                  ))}
                </select>
              </>
            )}
          </>
        )}

        {/* Prompt template (image/tts/video/music) — STT has no text prompt.
            When a prompt plug is wired, the manual field is replaced by a note. */}
        {promptParam && (promptWired ? (
          <>
            <label style={fieldLabelStyle}>{t('mediaNode.promptLabel')}</label>
            <div style={{
              padding: '6px 8px', border: '2px solid var(--accent)', background: 'var(--accent-muted)',
              color: 'var(--accent-text)', fontSize: 10, lineHeight: 1.5,
            }}>
              {t('mediaNode.promptWired1')}<strong>prompt ▸</strong>{t('mediaNode.promptWired2')}
            </div>
          </>
        ) : (
          <>
            <label style={fieldLabelStyle}>{t('mediaNode.promptLabelRef')}</label>
            <ReferenceField
              value={data.prompt ?? ''}
              onChange={(v) => updateNodeData(id, { prompt: v })}
              upstream={upstream}
              rows={2}
              placeholder={t('mediaNode.promptPlaceholder')}
            />
          </>
        ))}

        {/* Schema-driven params for the chosen model. Adding a param = data. */}
        {paramSchema.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <ParamFields schema={paramSchema} values={params} onChange={setParam} />
          </div>
        )}

        {/* Reference image wired in → the in-node picker is replaced by a note. */}
        {imageWired && (
          <div style={{ marginTop: 10, padding: '6px 8px', border: '2px solid var(--accent)', background: 'var(--accent-muted)', color: 'var(--accent-text)', fontSize: 10, lineHeight: 1.5 }}>
            {t('mediaNode.imageWired1')}<strong>image ▸</strong>{t('mediaNode.imageWired2')}
          </div>
        )}

        {missingRequired.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 9, color: 'var(--warning)' }}>
            {t('mediaNode.required')} {missingRequired.join(', ')}
          </div>
        )}

        {/* Per-node run + fan-out xN + pin + clear */}
        <RunControls
          accent={COLOR}
          run={run}
          pinned={isPinned}
          hasOutput={hasOutput}
          onRun={() => runNode(fanoutCount)}
          onTogglePin={() => updateNodeData(id, { pinned: !isPinned })}
          onClear={clearOutput}
          runTitle={t('mediaNode.runTitle')}
          fanoutCount={fanoutCount}
          onCycleFanout={() => setFanoutCount(c => nextFanoutCount(c))}
          fanoutActive={fanout.active}
          fanoutProgress={{ done: fanout.done, total: fanout.total }}
          onStopFanout={cancelFanout}
          {...(provider === 'local' && (modality === 'image' || modality === 'video')
            ? { onStopRun: stopLocalRun }
            : {})}
        />

        {/* Status only (spinner / error). The actual RESULT lands on a separate
            Output card on the canvas — not duplicated inline in the node. */}
        {(run.kind === 'running' || run.kind === 'error') && (
          <InlineTextPreview run={run} />
        )}
      </div>

      {/* Typed plugs — labeled + visible (discoverable), unlike the 8-handle set.
          Labels sit OUTSIDE the node body so they never collide with controls. */}
      {/* prompt: TARGET (left, upper). A wired text chain feeds the prompt. */}
      <Handle
        id="prompt" type="target" position={Position.Left}
        style={{ ...plugHandleStyle, top: 26 }}
      />
      <span style={{ ...plugLabelStyle, right: 'calc(100% + 6px)', top: 21, textAlign: 'right' }}>prompt ▸</span>

      {/* folder: TARGET (left, lower). A wired Folder node = auto-save dir. */}
      <Handle
        id="folder" type="target" position={Position.Left}
        style={{ ...plugHandleStyle, top: 64 }}
      />
      <span style={{ ...plugLabelStyle, right: 'calc(100% + 6px)', top: 59, textAlign: 'right' }}>folder ▸</span>

      {/* image: TARGET (left, lowest) — a Reference-Image node feeds this node's
          reference image (image-to-video init frame / image-model style ref).
          Only image + video use image_url, so the plug shows only there. */}
      {(modality === 'image' || modality === 'video') && (
        <>
          <Handle
            id="image" type="target" position={Position.Left}
            style={{ ...plugHandleStyle, top: 102, background: 'var(--warning)' }}
          />
          <span style={{ ...plugLabelStyle, right: 'calc(100% + 6px)', top: 97, textAlign: 'right', color: 'var(--warning)' }}>image ▸</span>
        </>
      )}

      {/* out: SOURCE (right) — reserved for future chaining (e.g. STT text). */}
      <Handle
        id="out" type="source" position={Position.Right}
        style={{ ...plugHandleStyle, top: 26 }}
      />
      <span style={{ ...plugLabelStyle, left: 'calc(100% + 6px)', top: 21 }}>▸ out</span>

      {/* #6: extra ERROR output (bottom-right corner) — wire it to a node that
       *  handles this media node's failure. Run-all feeds that node the error
       *  text; the edge renders red. Hover-revealed like the other handles. */}
      <ErrorHandle />
    </div>
  )
}
