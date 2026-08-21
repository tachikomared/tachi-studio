// apps/desktop/src/pages/nodes/canvas/nodeTypes/AgentNode.tsx
//
// Agent node — picks the HARNESS (OpenClaude / Codex / …). No model field:
// the model is supplied by whichever provider node is wired into this
// agent's target handle.
//
// #2 REFERENCES: the Instructions field is a <ReferenceField> — type '@' or
// '{{' to pull an upstream node's output into the system prompt via a
// {{node:<id>}} token; a live "Resolves to:" preview shows the substituted text.
// #3 PER-NODE RUN: a Run button executes JUST this agent (its provider + wired
// tools, with upstream lastOutputs as input) and caches the answer as
// `lastOutput` for an inline preview + downstream token resolution. A PIN toggle
// freezes that output as a reference source for downstream steps.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiAgentNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles, ErrorHandle } from '../EightHandles'
import { ReferenceField } from '../ReferenceField'
import { useUpstreamRefs } from '../useUpstreamRefs'
import { useNodeRun } from '../useNodeRun'
import { RunControls, ResultCard } from '../NodeRunUI'
import { QuickAddPlus } from '../QuickAddPlus'

const nodeStyle: React.CSSProperties = {
  position: 'relative',
  background: 'var(--bg-surface)',
  border: '2px solid var(--warning)',
  fontFamily: 'JetBrains Mono, monospace',
  minWidth: 200,
  width: 220,
  boxShadow: '4px 4px 0 var(--warning)',
}

const headerStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '2px solid var(--warning)',
  background: 'var(--warning)',
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
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }
const subStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block' }
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginTop: 6, marginBottom: 2,
}

export function AgentNode({ id, data }: NodeProps<TachiAgentNode>) {
  const { t } = useTranslation('nodes')
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const [hover, setHover] = useState(false)
  const isFinal = data.final === true
  const isPinned = data.pinned === true

  const upstream = useUpstreamRefs(id)
  const { run, runNode, reset } = useNodeRun(id)

  const accent = isFinal ? 'var(--accent)' : 'var(--warning)'

  const clearOutput = () => {
    updateNodeData(id, { lastOutput: undefined, lastArtifacts: undefined })
    reset()
  }

  return (
    <div
      style={isFinal ? { ...nodeStyle, border: '2px solid var(--accent)', boxShadow: '4px 4px 0 var(--accent)' } : nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={isFinal ? { ...headerStyle, background: 'var(--accent)', borderBottom: '2px solid var(--accent)' } : headerStyle}>
        <span>{isFinal ? 'agent · MAIN' : 'agent'}</span>
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {/* MAIN toggle — designate this agent's output as the final answer. */}
          <button
            onClick={(e) => { e.stopPropagation(); updateNodeData(id, { final: !isFinal }) }}
            className="nodrag"
            title={isFinal ? t('agentNode.mainUnset') : t('agentNode.mainSet')}
            aria-label={t('node.toggleMain')}
            aria-pressed={isFinal}
            style={{
              height: 16, padding: '0 4px',
              border: 'var(--border-width) solid var(--bg-base)',
              background: isFinal ? 'var(--bg-base)' : 'transparent',
              color: isFinal ? 'var(--accent)' : 'var(--bg-base)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 800,
              lineHeight: '14px', cursor: 'pointer',
            }}
          >MAIN</button>
          {hover && (
            <button
              onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
              className="nodrag"
              title={t('node.delete')}
              aria-label={t('node.delete')}
              style={{
                width: 16, height: 16, padding: 0,
                border: 'var(--border-width) solid var(--bg-base)',
                background: 'transparent', color: 'var(--bg-base)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800,
                lineHeight: 1, cursor: 'pointer',
              }}
            >×</button>
          )}
        </span>
      </div>
      <div style={bodyStyle}>
        <span style={labelStyle}>{data.label}</span>
        {data.harnessId && <span style={subStyle}>{data.harnessId}</span>}
        <span style={{ ...subStyle, color: 'var(--text-dim)', marginTop: 2, fontStyle: 'italic' }}>
          {t('agentNode.modelFromUpstream')}
        </span>

        {/* Per-agent instructions / pre-prompt: who this agent is + its job.
            ReferenceField lets it embed {{node:<id>}} tokens pulling upstream
            outputs (resolved at run/compile time). */}
        <label style={fieldLabelStyle}>{t('agentNode.instructionsLabel')}</label>
        <ReferenceField
          value={typeof data.systemPrompt === 'string' ? data.systemPrompt : ''}
          onChange={(v) => updateNodeData(id, { systemPrompt: v })}
          upstream={upstream}
          rows={2}
          placeholder={t('agentNode.instructionsPlaceholder')}
        />

        <RunControls
          accent={accent}
          run={run}
          pinned={isPinned}
          hasOutput={typeof data.lastOutput === 'string' && data.lastOutput.length > 0}
          onRun={runNode}
          onTogglePin={() => updateNodeData(id, { pinned: !isPinned })}
          onClear={clearOutput}
          runTitle={t('agentNode.runTitle')}
        />

        {/* Inline result: prefer the live run state, else the cached lastOutput.
            Wrapped in ResultCard (PanelChrome-style) — hover reveals a title bar
            and a collapse toggle, keeping the canvas tidy at rest. */}
        <ResultCard
          title={data.label || 'agent'}
          accent={accent}
          run={run}
          cached={typeof data.lastOutput === 'string' ? data.lastOutput : undefined}
          emptyLabel={t('agentNode.empty')}
        />
      </div>
      {/* A4: 8 invisible handles, both source and target — agents sit
       *  between providers (target) and permissions (source). */}
      <EightHandles role="both" color="var(--warning)" />
      {/* #6: extra ERROR output — wire it to a node that handles this agent's
       *  failure (Run-all feeds that node the error text; the edge is red). */}
      <ErrorHandle />
      {/* Twenty-style hover "+" — add + auto-connect a node below this one. */}
      <QuickAddPlus sourceId={id} color={accent} />
    </div>
  )
}
