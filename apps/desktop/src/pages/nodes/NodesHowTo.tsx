// apps/desktop/src/pages/nodes/NodesHowTo.tsx
//
// Interactive "how to build a workflow" walkthrough for the Nodes canvas.
// Instead of just describing, it BUILDS a real example on the canvas
// step-by-step (Provider -> Writer -> Reviewer), so the user watches a
// workflow come together piece by piece, then runs it.
//
// Safety: the user's existing canvas is snapshotted when the tour opens and
// restored on exit (unless they choose "Keep example"). Each step replaces the
// canvas with a progressively larger, fully-valid subset of the sample graph,
// so nothing is ever in a broken intermediate state.
//
// Brutalist: 2px borders, no radius, JetBrains Mono, semantic CSS vars, no emojis.

import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNodesStore } from './store/nodes.store'
import { nearestHandlePair, APPROX_NODE_RECT } from './canvas/EightHandles'
import type { TachiNode, TachiEdge } from './types'

// ── Sample graph (stable ids so edges can reference nodes) ────────────────────
const POS = {
  provider: { x: 60,  y: 150 },
  writer:   { x: 360, y: 150 },
  reviewer: { x: 660, y: 150 },
} as const

const providerNode: TachiNode = {
  id: 'howto-provider', type: 'provider', position: POS.provider,
  data: { label: 'Free models', providerId: 'freellmapi', model: 'auto' },
}
const writerNode: TachiNode = {
  id: 'howto-writer', type: 'agent', position: POS.writer,
  data: { label: 'Writer', harnessId: 'openclaude' },
}
const reviewerNode: TachiNode = {
  id: 'howto-reviewer', type: 'agent', position: POS.reviewer,
  data: { label: 'Reviewer', harnessId: 'openclaude' },
}

function makeEdge(id: string, src: TachiNode, tgt: TachiNode, instruction?: string): TachiEdge {
  const sRect = { x: src.position.x, y: src.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const tRect = { x: tgt.position.x, y: tgt.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const { sourceHandle, targetHandle } = nearestHandlePair(sRect, tRect)
  return {
    id, source: src.id, target: tgt.id, sourceHandle, targetHandle,
    type: 'link', data: instruction ? { instruction } : {},
  }
}

const edgeProviderWriter = makeEdge('howto-e1', providerNode, writerNode)
const edgeWriterReviewer = makeEdge('howto-e2', writerNode, reviewerNode, 'needs review')

interface Step {
  /** i18n key suffix under howto.steps.<key> for { title, body }. */
  key: string
  nodes: TachiNode[]
  edges: TachiEdge[]
}

const STEPS: Step[] = [
  { key: 'intro',    nodes: [], edges: [] },
  { key: 'provider', nodes: [providerNode], edges: [] },
  { key: 'agent',    nodes: [providerNode, writerNode], edges: [] },
  { key: 'wire',     nodes: [providerNode, writerNode], edges: [edgeProviderWriter] },
  { key: 'second',   nodes: [providerNode, writerNode, reviewerNode], edges: [edgeProviderWriter, edgeWriterReviewer] },
  { key: 'run',      nodes: [providerNode, writerNode, reviewerNode], edges: [edgeProviderWriter, edgeWriterReviewer] },
  { key: 'beyond',   nodes: [providerNode, writerNode, reviewerNode], edges: [edgeProviderWriter, edgeWriterReviewer] },
]

export function NodesHowTo({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('nodes')
  const setNodes = useNodesStore(s => s.setNodes)
  const setEdges = useNodesStore(s => s.setEdges)
  const [step, setStep] = useState(0)
  const snapshotRef = useRef<{ nodes: TachiNode[]; edges: TachiEdge[] } | null>(null)

  const isLast = step === STEPS.length - 1

  // On open: snapshot the user's canvas, jump to step 0, render it.
  useEffect(() => {
    if (!open) return
    const st = useNodesStore.getState()
    snapshotRef.current = { nodes: st.nodes, edges: st.edges }
    setStep(0)
    setNodes(STEPS[0].nodes)
    setEdges(STEPS[0].edges)
  }, [open, setNodes, setEdges])

  // On the final step, pulse the real "Run flow" toolbar button itself (no
  // offset ring to drift) so the user sees exactly what to click.
  useEffect(() => {
    if (!open || !isLast) return
    const el = document.querySelector('[data-howto="run-flow"]') as HTMLElement | null
    if (!el) return
    el.classList.add('tachi-tour-pulse')
    return () => { el.classList.remove('tachi-tour-pulse') }
  }, [open, isLast])

  // A11Y (batch34): Escape must close what the × closes. NOT a focus trap: this
  // is a NON-MODAL coach panel — the whole point of the last step is to click a
  // toolbar button on the page behind it, so trapping focus here would break the
  // very thing the tour teaches. It exits the same way the × does (canvas
  // restored), and hands focus back to whatever opened it.
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null
    return () => { openerRef.current?.focus?.() }
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      const snap = snapshotRef.current
      if (snap) { setNodes(snap.nodes); setEdges(snap.edges) }
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, setNodes, setEdges])

  if (!open) return null

  const goto = (i: number) => {
    const c = Math.max(0, Math.min(STEPS.length - 1, i))
    setStep(c)
    setNodes(STEPS[c].nodes)
    setEdges(STEPS[c].edges)
  }
  const restoreAndClose = () => {
    const snap = snapshotRef.current
    if (snap) { setNodes(snap.nodes); setEdges(snap.edges) }
    onClose()
  }
  const keepAndClose = () => onClose()

  const s = STEPS[step]
  const isFirst = step === 0

  return (
    <>
    <div
      role="dialog"
      aria-label={t('howto.title')}
      style={{
        position: 'fixed', left: 16, bottom: 16, width: 380, zIndex: 1200,
        border: '2px solid var(--accent)', background: 'var(--bg-surface)',
        boxShadow: '6px 6px 0 0 var(--border)', fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '2px solid var(--border)', background: 'var(--bg-elevated)',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', flex: 1 }}>
          {t('howto.title')}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{step + 1} / {STEPS.length}</span>
        <button onClick={restoreAndClose} aria-label={t('howto.closeAria')} title={t('howto.closeTitle')}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>
          x
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t(`howto.steps.${s.key}.title`)}</div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>{t(`howto.steps.${s.key}.body`)}</div>

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
          {STEPS.map((_, i) => (
            <span key={i} style={{
              width: 18, height: 4,
              background: i <= step ? 'var(--accent)' : 'var(--border)',
            }} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderTop: '2px solid var(--border)' }}>
        <button onClick={() => goto(step - 1)} disabled={isFirst} style={{ ...btn, opacity: isFirst ? 0.4 : 1, cursor: isFirst ? 'default' : 'pointer' }}>
          {t('howto.back')}
        </button>
        {!isLast ? (
          <button onClick={() => goto(step + 1)} style={{ ...btn, ...btnAccent, marginLeft: 'auto' }}>
            {t('howto.next')}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button onClick={restoreAndClose} style={btn} title={t('howto.restoreTitle')}>
              {t('howto.restore')}
            </button>
            <button onClick={keepAndClose} style={{ ...btn, ...btnAccent }} title={t('howto.keepTitle')}>
              {t('howto.keep')}
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: '0 12px 10px', fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        {t('howto.restoreNote')}
      </div>
    </div>
    </>
  )
}

const btn: React.CSSProperties = {
  padding: '5px 12px', border: '2px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
  fontWeight: 700, letterSpacing: '0.04em', cursor: 'pointer', textTransform: 'uppercase',
}
const btnAccent: React.CSSProperties = {
  border: '2px solid var(--accent)', background: 'var(--accent)', color: 'var(--bg-base)',
}
