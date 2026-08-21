// Modal — the brutalist dialog primitive.
//
// Bundles everything the app's hand-rolled modals were each re-implementing
// (inconsistently): a dimmed backdrop, a centered 2px-border card, click-
// backdrop-to-close, and — via useDialog — Escape, focus trap, and focus
// restore, plus the required role="dialog"/aria-modal/aria-labelledby.
//
//   <Modal title="Post bounty" onClose={close}>
//     ...form...
//   </Modal>
//
// Pass `width` (number px or CSS string) to size the card. The title becomes
// the accessible name; pass `hideTitle` to render a label-less dialog (still
// announced via aria-label).
import React, { useId } from 'react'
import { useDialog } from '../../hooks/useDialog'

export interface ModalProps {
  /** Accessible name + visible header text (unless hideTitle). */
  title: string
  /** Called on Escape, backdrop click, or the × button. */
  onClose: () => void
  /** Card width — number (px) or any CSS width. Default 440. */
  width?: number | string
  /** Hide the visible header bar (title still used as aria-label). */
  hideTitle?: boolean
  /** Extra style merged onto the card. */
  style?: React.CSSProperties
  children: React.ReactNode
}

export function Modal({ title, onClose, width = 440, hideTitle, style, children }: ModalProps) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const titleId = useId()

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hideTitle ? undefined : titleId}
        aria-label={hideTitle ? title : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: typeof width === 'number' ? Math.min(width, window.innerWidth - 32) : width,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--bg-elevated)',
          border: 'var(--border-width) solid var(--border)',
          boxShadow: 'var(--shadow-hard)',
          fontFamily: 'JetBrains Mono, monospace',
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
          ...style,
        }}
      >
        {!hideTitle && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '10px 12px',
              borderBottom: 'var(--border-width) solid var(--border)',
            }}
          >
            <span
              id={titleId}
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--text-primary)',
              }}
            >
              {title}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
                padding: '0 2px',
              }}
            >
              ×
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export default Modal
