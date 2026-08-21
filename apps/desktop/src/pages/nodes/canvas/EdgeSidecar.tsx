// apps/desktop/src/pages/nodes/canvas/EdgeSidecar.tsx
//
// Small inline popover anchored to an edge midpoint. Contains a textarea for
// the `instruction` prose label on the edge. Saves on blur or Enter (without
// Shift). Closes on Escape.
//
// Adapted from alookai/alook link-sidecar.tsx (MIT).
//
// Dimensions: 140x60 px per spec.

import React, { useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface EdgeSidecarProps {
  /** X pixel position of the edge midpoint (labelX from getBezierPath). */
  x: number
  /** Y pixel position of the edge midpoint (labelY from getBezierPath). */
  y: number
  /** Current instruction text (may be empty string). */
  initialValue: string
  /** Called when the user saves the instruction. */
  onSave(text: string): void
  /** Called when the sidecar should close without saving. */
  onClose(): void
}

export function EdgeSidecar({ x, y, initialValue, onSave, onClose }: EdgeSidecarProps) {
  const { t } = useTranslation('nodes')
  const [value, setValue] = useState(initialValue)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [])

  const commit = () => {
    onSave(value.trim())
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Offset below the midpoint so it doesn't obscure the edge controls
  const TOP_OFFSET = 18

  return (
    <div
      className="nodrag nopan"
      style={{
        position: 'absolute',
        transform: `translate(-50%, 0) translate(${x}px, ${y + TOP_OFFSET}px)`,
        pointerEvents: 'all',
        width: 140,
        zIndex: 1000,
      }}
    >
      <div
        style={{
          border: '2px solid var(--warning)',
          background: 'var(--bg-elevated)',
          boxShadow: '4px 4px 0 var(--border)',
          padding: 4,
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          placeholder={t('edgeSidecar.placeholder')}
          rows={2}
          style={{
            width: '100%',
            height: 44,
            padding: '3px 4px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            lineHeight: 1.4,
            resize: 'none',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 8,
          color: 'var(--text-dim)',
          marginTop: 2,
          letterSpacing: '0.02em',
        }}>
          {t('edgeSidecar.hint')}
        </div>
      </div>
    </div>
  )
}
