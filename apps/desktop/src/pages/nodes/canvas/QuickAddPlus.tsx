// apps/desktop/src/pages/nodes/canvas/QuickAddPlus.tsx
//
// Twenty-style hover "+" quick-add affordance for canvas nodes.
//
// On node hover (the parent toggles `.tachi-node-hover`), a small brutalist "+"
// pill fades in BELOW the node. Clicking it opens a tiny picker (Agent /
// Provider / Permission); choosing a kind creates that node positioned below the
// hovered node and auto-wires an edge from the hovered node to the new one via
// the store's addConnectedNode().
//
// Mounted INSIDE each node type's root <div> (which is position:relative), so it
// positions itself absolutely just under the node. It carries `className="nodrag"`
// so clicking the pill/picker never starts a ReactFlow drag.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../../../hooks/useDialog'
import { useNodesStore } from '../store/nodes.store'
import type { TachiNode } from '../types'

// ── Default node data per kind — mirrors NodePalette.tsx templates ──────────────
//
// We keep the three "structural" kinds the spec calls for: Agent, Provider,
// Permission. Defaults match the first/most-sensible palette template so a
// quick-added node behaves identically to a palette-dropped one.
interface QuickAddKind {
  /** Picker button label. */
  label: string
  /** Semantic accent (matches the target node type's border color). */
  color: string
  /** Builds the addConnectedNode partial. */
  make: () => Omit<TachiNode, 'id' | 'position'>
}

const KINDS: QuickAddKind[] = [
  {
    label: 'Agent',
    color: 'var(--warning)',
    // Mirrors AGENT_TEMPLATES[0] (OpenClaude).
    make: () => ({ type: 'agent', data: { label: 'OpenClaude', harnessId: 'openclaude' } }) as Omit<TachiNode, 'id' | 'position'>,
  },
  {
    label: 'Provider',
    color: 'var(--accent)',
    // Mirrors PROVIDER_TEMPLATES[0] (Bankr).
    make: () => ({
      type: 'provider',
      data: { label: 'Bankr', providerId: 'bankr', endpoint: 'llm.bankr.bot/v1', model: 'claude-sonnet-4.6' },
    }) as Omit<TachiNode, 'id' | 'position'>,
  },
  {
    label: 'Permission',
    color: 'var(--success)',
    // Mirrors the permission tier shape used by SkillNode (read-only default).
    make: () => ({
      type: 'skill',
      data: { label: 'Read-only', skillId: 'read-only', description: 'Read files only — no edits or shell.' },
    }) as Omit<TachiNode, 'id' | 'position'>,
  },
]

interface QuickAddPlusProps {
  /** Id of the node this affordance hangs off — the edge source. */
  sourceId: string
  /** Accent color for the "+" pill (typically the node's border color). */
  color: string
}

export function QuickAddPlus({ sourceId, color }: QuickAddPlusProps) {
  const { t } = useTranslation('nodes')
  const addConnectedNode = useNodesStore(s => s.addConnectedNode)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // A11Y (batch34): while the picker is open it owns focus — first item focused
  // on open, Tab cycles inside, Escape closes, and the "+" pill gets focus back
  // on close. `enabled` is the open flag because the menu mounts on demand.
  const menuRef = useDialog<HTMLDivElement>(() => setOpen(false), open)

  // Close the picker on outside click so it doesn't linger. Escape is owned by
  // useDialog above.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const handlePick = useCallback((kind: QuickAddKind) => {
    addConnectedNode(sourceId, kind.make())
    setOpen(false)
  }, [addConnectedNode, sourceId])

  return (
    <div
      ref={rootRef}
      className="nodrag tachi-quickadd"
      // Sits centered just under the node. Hidden until the parent node is
      // hovered (.tachi-node-hover .tachi-quickadd → opacity 1) OR the picker is
      // open (.tachi-quickadd-open) so it stays put while the user reads the menu.
      style={{
        position: 'absolute',
        left: '50%',
        top: '100%',
        transform: 'translate(-50%, 8px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        zIndex: 10,
      }}
      data-open={open ? 'true' : undefined}
      onMouseDown={(e) => { e.stopPropagation() }}
      onClick={(e) => { e.stopPropagation() }}
    >
      {!open ? (
        <button
          type="button"
          className="nodrag tachi-quickadd-pill"
          title={t('quickAdd.addConnected')}
          aria-label={t('quickAdd.addConnected')}
          onClick={(e) => { e.stopPropagation(); setOpen(true) }}
          style={{
            width: 22,
            height: 22,
            padding: 0,
            border: `2px solid ${color}`,
            background: 'var(--bg-surface)',
            color,
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 15,
            fontWeight: 800,
            lineHeight: 1,
            cursor: 'pointer',
            boxShadow: `2px 2px 0 ${color}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >+</button>
      ) : null}

      {/*
        Scoped hover-reveal — mirrors EightHandles' local <style> approach so the
        affordance works even before the canonical rule lands in globals.css.
        Hidden by default; fades in when the parent node is hovered OR the picker
        is open (data-open). prefers-reduced-motion drops the transition + slide.
      */}
      <style>{`
        .tachi-quickadd {
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms cubic-bezier(0.2,0.8,0.2,1),
                      transform 120ms cubic-bezier(0.2,0.8,0.2,1);
        }
        .tachi-node-hover .tachi-quickadd,
        .tachi-quickadd[data-open="true"],
        /* A11Y (batch34): the "+" pill is in the tab order but was painted at
           opacity 0 with pointer-events:none until the node was HOVERED — so a
           keyboard user landed on an invisible, unclickable control. Focus is
           the keyboard twin of hover; reveal on it too. */
        .tachi-quickadd:focus-within {
          opacity: 1;
          pointer-events: auto;
        }
        @media (prefers-reduced-motion: reduce) {
          .tachi-quickadd { transition: none !important; }
        }
      `}</style>

      {open ? (
        <div
          ref={menuRef}
          className="nodrag tachi-quickadd-menu"
          role="menu"
          aria-label={t('quickAdd.menuAria')}
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-surface)',
            border: '2px solid var(--border-strong)',
            boxShadow: 'var(--shadow-hard)',
            minWidth: 132,
          }}
        >
          <div style={{
            padding: '4px 8px',
            borderBottom: '2px solid var(--border-strong)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
            background: 'var(--bg-elevated)',
          }}>
            {t('quickAdd.header')}
          </div>
          {KINDS.map(kind => (
            <button
              key={kind.label}
              type="button"
              role="menuitem"
              className="nodrag"
              onClick={(e) => { e.stopPropagation(); handlePick(kind) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 8px',
                border: 'none',
                borderBottom: 'var(--border-width) solid var(--border)',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                background: kind.color,
                flexShrink: 0,
                display: 'inline-block',
              }} />
              {kind.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
