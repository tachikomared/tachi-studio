import React, { useState } from 'react'

/**
 * SettingsCard (Twenty-style)
 *
 * A brutalist clickable row/card: optional leading icon, a title, a muted
 * description, an optional right-aligned status slot, and a trailing chevron.
 * 2px border + hard offset shadow, with a hover "lift" (translate up/left so the
 * shadow grows) when interactive. Renders as a `<button>` when `onClick` is
 * provided (keyboard + focusable), otherwise a static `<div>`.
 *
 * The hover lift is guarded by `prefers-reduced-motion` via the
 * `.tachi-settings-card` class (transition lives in globals.css — see the
 * implementing agent's `wiring` notes). Without that CSS the card still works;
 * it just snaps instead of easing.
 *
 * @example
 * <SettingsCard
 *   icon={<GitHubIcon />}
 *   title="GitHub"
 *   description="Connect a repository to run swarms against."
 *   status={<span style={{ color: 'var(--success)' }}>Connected</span>}
 *   onClick={() => navigate('/settings/github')}
 * />
 */
export interface SettingsCardProps {
  /** Title text (bold, primary color). */
  title: string
  /** Muted one-line description under the title. */
  description?: React.ReactNode
  /** Optional leading icon (rendered in a fixed 28px box). */
  icon?: React.ReactNode
  /** Optional right-aligned status slot (badge, "Connected", count, etc.). */
  status?: React.ReactNode
  /** Click handler — when present the card becomes a focusable button. */
  onClick?: () => void
  /** Hide the trailing chevron (shown by default when `onClick` is set). */
  hideChevron?: boolean
  /** Disable interaction (dims + removes pointer). */
  disabled?: boolean
  /** Optional className merged onto the card. */
  className?: string
  /** Optional style merged onto the card. */
  style?: React.CSSProperties
}

export function SettingsCard({
  title,
  description,
  icon,
  status,
  onClick,
  hideChevron,
  disabled,
  className,
  style,
}: SettingsCardProps) {
  const [hover, setHover] = useState(false)
  const interactive = !!onClick && !disabled
  const showChevron = interactive && !hideChevron

  // Hover lift: shift the card up/left and grow the shadow. The CSS transition
  // (and its reduced-motion guard) come from .tachi-settings-card in globals.
  const lifted = interactive && hover

  const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    textAlign: 'left',
    padding: 12,
    border: 'var(--border-width, 2px) solid var(--border)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'JetBrains Mono, monospace',
    boxShadow: lifted ? 'var(--shadow-hard-lg, 6px 6px 0 #000)' : 'var(--shadow-hard)',
    transform: lifted ? 'translate(-2px, -2px)' : 'translate(0, 0)',
    cursor: interactive ? 'pointer' : 'default',
    opacity: disabled ? 0.5 : 1,
    // Brutalist: no rounded corners.
    borderRadius: 0,
  }

  const content = (
    <>
      {icon != null && (
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent)',
          }}
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        {description != null && (
          <span
            style={{
              display: 'block',
              fontSize: 10,
              color: 'var(--text-muted)',
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {description}
          </span>
        )}
      </span>
      {status != null && (
        <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--text-muted)' }}>{status}</span>
      )}
      {showChevron && (
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            fontSize: 14,
            color: 'var(--text-dim)',
            lineHeight: 1,
          }}
        >
          ›
        </span>
      )}
    </>
  )

  if (interactive) {
    return (
      <button
        type="button"
        className={`tachi-settings-card ${className ?? ''}`.trim()}
        onClick={onClick}
        disabled={disabled}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        style={{ ...baseStyle, ...style }}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      className={`tachi-settings-card ${className ?? ''}`.trim()}
      style={{ ...baseStyle, ...style }}
    >
      {content}
    </div>
  )
}

export default SettingsCard
