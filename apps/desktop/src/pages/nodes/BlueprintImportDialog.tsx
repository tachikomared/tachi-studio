// apps/desktop/src/pages/nodes/BlueprintImportDialog.tsx
//
// Blueprint import — paste markdown with numbered steps and turn it into a
// vertical chain of agent nodes (one per step), wired sequentially. Each step's
// TITLE becomes the node label and its BODY becomes the agent's systemPrompt.
//
// Parsing is dependency-free: we split on numbered headings (`1.`, `2)`, or
// markdown headings `## 1. Title`) and treat everything up to the next number
// as that step's body. A leading "**Title**" / "Title —" on the first line of a
// step is used as the label when present.
//
// Brutalist modal: centered card over a dim backdrop, 2px borders, JetBrains
// Mono. The card entrance uses .tachi-blueprint-card (keyframes in globals.css —
// see wiring[]); guarded by prefers-reduced-motion.

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../../hooks/useDialog'
import type { TachiNode, TachiEdge } from './types'
import { nearestHandlePair, APPROX_NODE_RECT } from './canvas/EightHandles'

export interface BlueprintStep {
  title: string
  body: string
}

// ── Parser ─────────────────────────────────────────────────────────────────────
//
// Recognise lines that START a numbered step:
//   "1. Research"            "2) Draft"      "3 - Review"
//   "## 1. Research"         "### Step 2: Draft"
// Everything between two step starts is the body of the first.

const STEP_START = /^\s*(?:#{1,6}\s*)?(?:step\s*)?(\d+)\s*[.):\-]\s+(.*)$/i

export function parseBlueprint(md: string): BlueprintStep[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const steps: BlueprintStep[] = []
  let current: BlueprintStep | null = null

  for (const line of lines) {
    const m = line.match(STEP_START)
    if (m) {
      if (current) steps.push(current)
      // The text after the number is the title (strip markdown bold / trailing colon).
      const rawTitle = m[2].trim()
      const title = rawTitle.replace(/\*\*/g, '').replace(/[:\-–—]\s*$/, '').trim()
      current = { title: title || `Step ${m[1]}`, body: '' }
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }
  if (current) steps.push(current)

  // Trim bodies; drop fully-empty trailing whitespace.
  return steps.map((s) => ({ title: s.title, body: s.body.trim() }))
}

// ── Graph builder ───────────────────────────────────────────────────────────────
//
// Build a vertical chain of agent nodes (label = step title, systemPrompt =
// step body), wired top→bottom with auto-routed handles. The last node is
// marked final:true. Ids are stamped with a shared timestamp for uniqueness.

const COL_X = 360
const ROW_GAP = 180
const TOP_Y = 120

export function buildBlueprintGraph(steps: BlueprintStep[]): { nodes: TachiNode[]; edges: TachiEdge[] } {
  const ts = Date.now()
  const nodes: TachiNode[] = steps.map((step, i) => ({
    id: `bp-${ts}-${i}`,
    type: 'agent',
    position: { x: COL_X, y: TOP_Y + i * ROW_GAP },
    data: {
      label: step.title,
      harnessId: 'openclaude',
      ...(step.body ? { systemPrompt: step.body } : {}),
      ...(i === steps.length - 1 ? { final: true } : {}),
    },
  } as TachiNode))

  const edges: TachiEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    const src = nodes[i]
    const tgt = nodes[i + 1]
    const sRect = { x: src.position.x, y: src.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
    const tRect = { x: tgt.position.x, y: tgt.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
    const { sourceHandle, targetHandle } = nearestHandlePair(sRect, tRect)
    edges.push({
      id: `bp-e-${ts}-${i}`,
      source: src.id,
      target: tgt.id,
      sourceHandle,
      targetHandle,
      type: 'link',
      data: { instruction: 'then' },
    })
  }

  return { nodes, edges }
}

// ── Styles ───────────────────────────────────────────────────────────────────

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const cardStyle: React.CSSProperties = {
  width: 520,
  maxWidth: '92vw',
  maxHeight: '86vh',
  display: 'flex',
  flexDirection: 'column',
  border: '2px solid var(--accent)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  borderBottom: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  flexShrink: 0,
}

const titleStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
}

const btnStyle: React.CSSProperties = {
  padding: '5px 12px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  border: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  boxShadow: 'var(--shadow-hard)',
}

// ── Component ────────────────────────────────────────────────────────────────

export function BlueprintImportDialog(props: {
  open: boolean
  onClose: () => void
  /** Called with the generated chain on Import. */
  onImport: (nodes: TachiNode[], edges: TachiEdge[]) => void
}) {
  const { t } = useTranslation('nodes')
  const { open, onClose, onImport } = props
  const [text, setText] = useState('')

  const steps = useMemo(() => parseBlueprint(text), [text])
  const cardRef = useDialog<HTMLDivElement>(onClose, open)

  if (!open) return null

  const canImport = steps.length > 0

  const handleImport = () => {
    if (!canImport) return
    const { nodes, edges } = buildBlueprintGraph(steps)
    onImport(nodes, edges)
    setText('')
    onClose()
  }

  return (
    <div style={backdropStyle} onClick={onClose} role="presentation">
      <div
        ref={cardRef}
        tabIndex={-1}
        style={cardStyle}
        className="tachi-blueprint-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('blueprint.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <span style={titleStyle}>{t('blueprint.title')}</span>
          <button onClick={onClose} title={t('blueprint.close')} style={btnStyle}>{t('blueprint.close')}</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {t('blueprint.description')}
          </p>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('blueprint.placeholder')}
            rows={12}
            autoFocus
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              padding: '8px 10px',
              border: '2px solid var(--border)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              outline: 'none',
            }}
          />

          {/* Live preview of detected steps */}
          {text.trim().length > 0 && (
            <div style={{ border: '2px solid var(--border)', background: 'var(--bg-elevated)' }}>
              <div style={{
                padding: '4px 8px', borderBottom: 'var(--border-width) solid var(--border)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)',
              }}>
                {t('blueprint.stepsDetected', { count: steps.length })}
              </div>
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
                {steps.length === 0 && (
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                    {t('blueprint.noSteps')}
                  </span>
                )}
                {steps.map((s, i) => (
                  <div key={i} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-primary)' }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{i + 1}.</span>{' '}
                    {s.title}
                    {i === steps.length - 1 && (
                      <span style={{ color: 'var(--accent)', marginLeft: 6, fontSize: 9, fontWeight: 700 }}>{t('blueprint.final')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '2px solid var(--border)', flexShrink: 0 }}>
          <button onClick={onClose} style={btnStyle}>{t('blueprint.cancel')}</button>
          <button
            onClick={handleImport}
            disabled={!canImport}
            title={canImport ? t('blueprint.importTitleReady') : t('blueprint.importTitleEmpty')}
            style={{ ...btnPrimaryStyle, opacity: canImport ? 1 : 0.5, cursor: canImport ? 'pointer' : 'not-allowed' }}
          >
            {steps.length > 0 ? t('blueprint.importCount', { count: steps.length }) : t('blueprint.import')}
          </button>
        </div>
      </div>
    </div>
  )
}
