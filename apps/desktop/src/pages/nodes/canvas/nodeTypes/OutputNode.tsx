// apps/desktop/src/pages/nodes/canvas/nodeTypes/OutputNode.tsx
//
// Output card — a RESULT that lands on the canvas when a node runs (flowith-style
// conversational canvas). Auto-spawned + wired from its source on each run (one
// card per source, refreshed on re-run). Shows the produced text OR media, and
// has its own handles so you can branch a NEW Prompt / Media node off the result
// and keep the chain going — the whole history stays on the canvas.
//
// Text results feed downstream like a Text node (lastOutput → @ / {{node:<id>}}
// tokens + the media prompt-plug). Media results render inline (image/video/audio).
//
// Uses ResultCardChrome (PanelChrome-style) so its compact header (title + regen
// + delete) only shows on hover — saves space when many cards are on the canvas.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiOutputNode, TachiNode } from '../../types'
import { formatCostChip, asRunCostBasis } from '../../run-cost'
import { useNodesStore } from '../../store/nodes.store'
import { useNodeRun } from '../useNodeRun'
import { EightHandles } from '../EightHandles'
import { ArtifactList } from '../NodeRunUI'
import { ResultCardChrome } from '../ResultCardChrome'

const COLOR = 'var(--border-strong)'

const textBoxStyle: React.CSSProperties = {
  maxHeight: 160, overflowY: 'auto', padding: '6px 8px', border: '2px solid var(--border)',
  background: 'var(--bg-inset)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
const hintStyle: React.CSSProperties = { marginTop: 6, fontSize: 8, lineHeight: 1.4, color: 'var(--text-dim)' }

export function OutputNode({ id, data }: NodeProps<TachiOutputNode>) {
  const { t } = useTranslation('nodes')
  const deleteNode = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)

  const text = typeof data.text === 'string' ? data.text : ''
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : []
  const hasMedia = data.kind === 'media' && artifacts.length > 0
  const title = data.sourceLabel ? t('outputNode.title', { source: data.sourceLabel }) : t('outputNode.titlePlain')

  // Regenerate (chat-style): re-run the SOURCE node — useNodeRun stamps + refreshes
  // this very card via upsertOutputNode. Only when the source still exists.
  const sourceId = typeof data.sourceId === 'string' ? data.sourceId : ''
  const sourceExists = useNodesStore(s => !!sourceId && s.nodes.some(n => n.id === sourceId))
  const { run: srcRun, runNode: regenerate } = useNodeRun(sourceId, { outputTargetId: id })
  const regenerating = srcRun.kind === 'running'

  // NODES-RESEARCH #1/#4: the source node carries the pin + cost estimate.
  const sourcePinned = useNodesStore(s => !!sourceId && !!(s.nodes.find(n => n.id === sourceId)?.data as { pinned?: boolean } | undefined)?.pinned)
  const sourceCostUsd = useNodesStore(s => {
    if (!sourceId) return null
    const v = (s.nodes.find(n => n.id === sourceId)?.data as { lastCostUsd?: unknown } | undefined)?.lastCostUsd
    return typeof v === 'number' ? v : null
  })
  const sourceCostBasis = useNodesStore(s => {
    if (!sourceId) return null
    return asRunCostBasis((s.nodes.find(n => n.id === sourceId)?.data as { lastCostBasis?: unknown } | undefined)?.lastCostBasis)
  })
  const toggleNodePinned = useNodesStore(s => s.toggleNodePinned)
  // FAN-OUT: a sibling card carries its OWN frozen estimate — prefer it so each
  // variant shows its own figure (not the source's last, mutable one).
  const ownCostUsd = typeof data.estUsd === 'number' ? data.estUsd : null
  const ownCostBasis = asRunCostBasis(data.estBasis)
  // Number and basis must come from the SAME frozen estimate — mixing this
  // card's number with the source's basis is how a chip starts lying.
  const costChip = ownCostBasis || ownCostUsd != null
    ? formatCostChip(ownCostUsd, ownCostBasis, (k, fallback) => t(k, { defaultValue: fallback }))
    : formatCostChip(sourceCostUsd, sourceCostBasis, (k, fallback) => t(k, { defaultValue: fallback }))
  // FAN-OUT: 1-based sibling number (v1..vN) for the small badge.
  const variantNo = typeof data.variant === 'number' ? data.variant : null

  // NODES-RESEARCH #2 (flowith branch-from-result): spawn a follow-up agent
  // wired FROM this card — its ancestry (this result's text) flows in as
  // context automatically because the card's lastOutput feeds downstream.
  const followUp = () => {
    useNodesStore.getState().addConnectedNode(id, {
      type: 'agent',
      data: { label: t('outputNode.followUpLabel', { defaultValue: 'Follow-up' }), harnessId: 'openclaude' },
    } as Omit<TachiNode, 'id' | 'position'>)
  }

  // Header actions: pin + regen + delete — shown in the hover header via ResultCardChrome.
  const headerActions = (
    <>
      {sourceExists && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleNodePinned(sourceId) }}
          className="nodrag"
          title={sourcePinned
            ? t('outputNode.unpinTitle', { defaultValue: 'Unpin — Run all will re-run this node again' })
            : t('outputNode.pinTitle', { defaultValue: 'Pin this result — Run all reuses it instead of re-running (and re-paying for) the node' })}
          aria-pressed={sourcePinned}
          style={{
            height: 16, padding: '0 5px',
            border: 'var(--border-width, 2px) solid var(--bg-base)',
            background: sourcePinned ? 'var(--bg-base)' : 'transparent',
            color: sourcePinned ? 'var(--warning)' : 'var(--bg-base)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
            lineHeight: '14px', cursor: 'pointer', letterSpacing: '0.04em',
          }}
        >
          {sourcePinned ? t('outputNode.pinned', { defaultValue: '▪ PINNED' }) : t('outputNode.pin', { defaultValue: 'PIN' })}
        </button>
      )}
      {sourceExists && (
        <button
          onClick={(e) => { e.stopPropagation(); if (!regenerating) regenerate() }}
          className="nodrag"
          title={t('outputNode.regenTitle')}
          aria-label={t('outputNode.regenAria')}
          disabled={regenerating}
          style={{
            height: 16, padding: '0 5px',
            border: 'var(--border-width, 2px) solid var(--bg-base)',
            background: 'transparent', color: 'var(--bg-base)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
            lineHeight: '14px', cursor: regenerating ? 'wait' : 'pointer', letterSpacing: '0.04em',
          }}
        >
          {regenerating ? '…' : t('outputNode.regen')}
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
        className="nodrag"
        title={t('outputNode.deleteResult')}
        aria-label={t('outputNode.deleteResult')}
        style={{
          width: 16, height: 16, padding: 0,
          border: 'var(--border-width, 2px) solid var(--bg-base)',
          background: 'transparent', color: 'var(--bg-base)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800,
          lineHeight: 1, cursor: 'pointer',
        }}
      >×</button>
    </>
  )

  return (
    // ReactFlow needs a positional wrapper; ResultCardChrome is the visual shell.
    // tachi-node-hover class activates EightHandles visibility (see EightHandles.tsx).
    <div
      style={{ position: 'relative', width: 250 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <ResultCardChrome
        title={title}
        accent={COLOR}
        actions={headerActions}
        collapsible
        headerAlwaysVisible
      >
        <div style={{ padding: '8px 10px' }}>
          {hasMedia && <ArtifactList artifacts={artifacts} />}
          {text && (
            <div
              className="nodrag"
              style={{ ...textBoxStyle, marginTop: hasMedia ? 8 : 0 }}
            >
              {text}
            </div>
          )}
          {!text && !hasMedia && (
            <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
              {t('outputNode.noOutput')}
            </span>
          )}
          {/* Footer: variant badge + cost estimate + pinned marker + branch-from-result. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {variantNo != null && (
              <span
                title={t('outputNode.variantTitle', { n: variantNo, defaultValue: 'Fan-out variant {{n}} — one of several sibling runs of the source node' })}
                style={{
                  fontSize: 8, fontWeight: 800, letterSpacing: '0.08em',
                  padding: '1px 5px', border: '1px solid var(--accent)',
                  color: 'var(--accent-text)', background: 'var(--accent-muted)',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >{`V${variantNo}`}</span>
            )}
            {costChip && (
              <span
                title={t('outputNode.costTitle', { defaultValue: 'Estimated cost of the last run of this node (chars/4 token math on the wired model’s rates)' })}
                style={{
                  fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '1px 5px', border: '1px solid var(--border)',
                  color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace',
                }}
              >{costChip}</span>
            )}
            {sourcePinned && (
              <span style={{
                fontSize: 8, fontWeight: 800, letterSpacing: '0.08em',
                padding: '1px 5px', border: '1px solid var(--warning)',
                color: 'var(--warning)', fontFamily: 'JetBrains Mono, monospace',
              }}>{t('outputNode.pinnedChip', { defaultValue: 'PINNED — RUN ALL REUSES THIS' })}</span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); followUp() }}
              className="nodrag"
              title={t('outputNode.followUpTitle', { defaultValue: 'Branch a follow-up agent from this result — it reads this output as its context' })}
              style={{
                marginLeft: 'auto', height: 18, padding: '0 7px',
                border: '2px solid var(--accent)', background: 'transparent',
                color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9, fontWeight: 800, letterSpacing: '0.06em',
                textTransform: 'uppercase', cursor: 'pointer',
              }}
            >⑂ {t('outputNode.followUp', { defaultValue: 'Follow-up' })}</button>
          </div>
          <div style={hintStyle}>{t('outputNode.branchHint')}</div>
        </div>
      </ResultCardChrome>

      {/* Both: receives the wire from its source, and feeds new downstream nodes. */}
      <EightHandles role="both" color={COLOR} />
    </div>
  )
}
