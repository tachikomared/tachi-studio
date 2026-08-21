// apps/desktop/src/pages/nodes/canvas/nodeTypes/PromptNode.tsx
//
// Prompt node — a SELF-CONTAINED text step. Pick a provider + model, write an
// instruction (what kind of prompt to write), Run it, and it emits a generated
// prompt. Wire its output into a Media node's `prompt` plug (or reference it via
// @ / {{node:<id>}}) so a text model authors your image/video/music prompt.
//
// It carries its OWN provider+model (no separate Provider node needed). At
// run/compile time the main process expands a prompt node into a provider+agent
// pair, so it reuses the whole agent pipeline (per-node Run, token resolution,
// media prompt-feeding). The Instructions field is a <ReferenceField> so it can
// also fold in upstream node outputs.
import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiPromptNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { useProviderModels } from '../../useProviderModels'
import { EightHandles, ErrorHandle } from '../EightHandles'
import { ReferenceField } from '../ReferenceField'
import { useUpstreamRefs } from '../useUpstreamRefs'
import { useNodeRun } from '../useNodeRun'
import { nextFanoutCount, type FanoutCount } from '../fanout'
import { RunControls, ResultCard } from '../NodeRunUI'
import { graphProviderSeeds, canonicalProviderId } from '../../providerCompat'
import { PromptPicker } from '../../../../components/PromptPicker'

// Text providers a prompt node can run on — DERIVED from the shared provider
// registry (packages/core), filtered to graph-capable providers, so this list
// stays in sync with chat/agents instead of drifting. Each seed carries the
// canonical id + a default model the engine adapter understands.
const PROMPT_PROVIDERS = graphProviderSeeds()

const COLOR = 'var(--accent)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', width: 230, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginTop: 6, marginBottom: 2,
}
const selectStyle: React.CSSProperties = {
  width: '100%', padding: '3px 4px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '4px 6px', border: '2px solid var(--border)',
  background: 'var(--bg-inset)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
}

export function PromptNode({ id, data }: NodeProps<TachiPromptNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const edges          = useNodesStore(s => s.edges)
  const nodes          = useNodesStore(s => s.nodes)
  const [hover, setHover] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false) // prompt-library picker
  const isFinal  = data.final === true
  const isPinned = data.pinned === true

  // Reference-Image nodes wired into this Prompt → it runs as VISION: the model
  // SEES the image(s) while writing (so the prompt can feature that character /
  // object). Needs a vision-capable model on a cloud gateway (handled in graph.ipc).
  const visionRefs = nodes.filter(n => n.type === 'imageref' && edges.some(e => e.source === n.id && e.target === id))

  const upstream = useUpstreamRefs(id)
  const { run, runNode, reset, cancelFanout, fanout } = useNodeRun(id)
  // FAN-OUT xN — how many sibling runs the next RUN fires (x1 = today's single).
  const [fanoutCount, setFanoutCount] = useState<FanoutCount>(1)

  const providerId = canonicalProviderId(data.providerId) || 'freellmapi-local'
  const model = data.model ?? PROMPT_PROVIDERS.find(p => p.providerId === providerId)?.model ?? 'auto'
  const accent = isFinal ? 'var(--accent)' : COLOR

  // ALL available models for this provider → one real dropdown (no hand-typing),
  // live + static fallback, shared with the Configure panel. Venice models carry
  // vision/caps tags.
  const { models: providerModels } = useProviderModels(providerId)
  const selectedIsVision = providerModels.find(m => m.id === model)?.vision

  // llama.cpp runs ONE local model at a time → default to the first installed
  // when the node still carries the seed 'auto' (not a real local model id).
  useEffect(() => {
    if (providerId !== 'llama-cpp' || providerModels.length === 0) return
    const m = data.model
    if (!m || m === 'auto' || !providerModels.some(o => o.id === m)) {
      updateNodeData(id, { model: providerModels[0].id })
    }
  }, [providerId, providerModels]) // eslint-disable-line react-hooks/exhaustive-deps

  const onProvider = (pid: string) => {
    const p = PROMPT_PROVIDERS.find(x => x.providerId === pid)
    updateNodeData(id, { providerId: pid, ...(p ? { endpoint: p.endpoint, model: p.model } : {}) })
  }
  const clearOutput = () => { updateNodeData(id, { lastOutput: undefined, lastArtifacts: undefined }); reset() }

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>{isFinal ? 'prompt · MAIN' : 'prompt'}{isPinned ? ' · PINNED' : ''}</span>
        <span style={{ display: 'inline-flex', gap: 4 }}>
          <button
            onClick={(e) => { e.stopPropagation(); updateNodeData(id, { final: !isFinal }) }}
            className="nodrag"
            title={isFinal ? t('promptNode.mainUnset') : t('promptNode.mainSet')}
            aria-pressed={isFinal}
            style={{ height: 16, padding: '0 4px', border: 'var(--border-width) solid var(--bg-base)', background: isFinal ? 'var(--bg-base)' : 'transparent', color: isFinal ? 'var(--accent)' : 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800, lineHeight: '14px', cursor: 'pointer' }}
          >MAIN</button>
          {hover && (
            <button
              onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
              className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
              style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
            >×</button>
          )}
        </span>
      </div>

      <div style={bodyStyle}>
        <label style={{ ...fieldLabelStyle, marginTop: 0 }}>{t('promptNode.providerLabel')}</label>
        <select className="nodrag" value={providerId} onChange={(e) => onProvider(e.target.value)} style={selectStyle}>
          {PROMPT_PROVIDERS.map(p => <option key={p.providerId} value={p.providerId}>{p.label}</option>)}
        </select>

        <label style={fieldLabelStyle}>{t('promptNode.modelLabel')}{selectedIsVision ? t('promptNode.visionSuffix') : ''}</label>
        {providerModels.length > 0 ? (
          <select
            className="nodrag" value={model}
            onChange={(e) => updateNodeData(id, { model: e.target.value })}
            style={selectStyle}
          >
            {/* Keep the current value selectable even if it isn't in the catalog. */}
            {model && !providerModels.some(m => m.id === model) && <option value={model}>{model}</option>}
            {providerModels.map(m => (
              <option key={m.id} value={m.id}>{m.label}{m.caps && m.caps.length > 0 ? ` · ${m.caps.join(' · ')}` : ''}</option>
            ))}
          </select>
        ) : providerId === 'llama-cpp' ? (
          <span style={{ display: 'block', fontSize: 9, color: 'var(--warning)', padding: '2px 0' }}>
            {t('promptNode.noLocalModels')}
          </span>
        ) : (
          <input
            className="nodrag" type="text" value={model}
            onChange={(e) => updateNodeData(id, { model: e.target.value })}
            placeholder={t('promptNode.modelIdPlaceholder')} style={inputStyle}
          />
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={fieldLabelStyle}>{t('promptNode.instructionLabel')}</label>
          {/* Prompt library (shared with the chat picker — nodes rule). */}
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); setShowLibrary(v => !v) }}
            title={t('promptNode.libraryTitle')}
            style={{ border: '1px solid var(--border)', background: showLibrary ? 'var(--accent-muted)' : 'transparent', color: showLibrary ? 'var(--accent-text)' : 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', fontSize: 8, padding: '1px 6px', cursor: 'pointer' }}
          >{t('promptNode.library')}</button>
        </div>
        {showLibrary && (
          <div style={{ position: 'relative' }} className="nodrag">
            <PromptPicker
              currentText={typeof data.instruction === 'string' ? data.instruction : ''}
              onClose={() => setShowLibrary(false)}
              onInsert={(tpl) => updateNodeData(id, { instruction: tpl })}
            />
          </div>
        )}
        <ReferenceField
          value={typeof data.instruction === 'string' ? data.instruction : ''}
          onChange={(v) => updateNodeData(id, { instruction: v })}
          upstream={upstream}
          rows={3}
          placeholder={t('promptNode.instructionPlaceholder')}
        />

        {/* Warn only when an image is wired but the SELECTED model can't read it —
            any provider. A vision-capable model (Claude, Gemini, GPT-4o/5, Qwen-VL,
            Pixtral, a Venice vision model…) shows nothing — no nagging when it works. */}
        {visionRefs.length > 0 && selectedIsVision !== true && (
          <div style={{ marginTop: 6, padding: '4px 6px', border: '2px solid var(--warning)', background: 'var(--bg-inset)', fontSize: 8, lineHeight: 1.45, color: 'var(--warning)' }}>
            {t('promptNode.visionWarning')}
          </div>
        )}

        <RunControls
          accent={accent}
          run={run}
          pinned={isPinned}
          hasOutput={typeof data.lastOutput === 'string' && data.lastOutput.length > 0}
          onRun={() => runNode(fanoutCount)}
          onTogglePin={() => updateNodeData(id, { pinned: !isPinned })}
          onClear={clearOutput}
          runTitle={t('promptNode.runTitle')}
          fanoutCount={fanoutCount}
          onCycleFanout={() => setFanoutCount(c => nextFanoutCount(c))}
          fanoutActive={fanout.active}
          fanoutProgress={{ done: fanout.done, total: fanout.total }}
          onStopFanout={cancelFanout}
        />

        {/* ResultCard: PanelChrome-style wrapper — hover reveals header + collapse. */}
        <ResultCard
          title={data.label || 'prompt'}
          accent={accent}
          run={run}
          cached={typeof data.lastOutput === 'string' ? data.lastOutput : undefined}
          emptyLabel={t('promptNode.empty')}
        />
      </div>

      {/* 8 invisible handles (drag-anywhere). Wire `out` into a Media node's
       *  `prompt` plug; the canvas onConnect coerces the media side to its plug. */}
      <EightHandles role="both" color={COLOR} />
      {/* #6: extra ERROR output — wire it to a node that handles this prompt's
       *  failure (Run-all feeds that node the error text; the edge is red). */}
      <ErrorHandle />
    </div>
  )
}
