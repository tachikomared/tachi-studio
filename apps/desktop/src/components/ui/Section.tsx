import React from 'react'

/**
 * Section (Twenty-style)
 *
 * A purely structural settings-section wrapper: an H2-style uppercase title, an
 * optional muted description, and children below — with consistent spacing. No
 * logic, no state. Use it to group related settings rows/cards so every section
 * shares the same rhythm.
 *
 * Brutalist: monospace label, uppercase + letter-spacing, hard edges. Reads CSS
 * vars only, so it themes automatically across bankr/tachi-dark/tachi-neon.
 *
 * @example
 * <Section title="Connections" description="API keys for bundled providers.">
 *   <ProvidersCard />
 *   <SettingsCard title="GitHub" description="Connect a repo" onClick={...} />
 * </Section>
 */
export interface SectionProps {
  /** Section heading (rendered as an H2-style label). */
  title: string
  /** Optional muted description shown under the title. */
  description?: React.ReactNode
  /** Section body. */
  children?: React.ReactNode
  /** Optional right-aligned slot in the title row (e.g. a "+ Add" button). */
  action?: React.ReactNode
  /** Bottom margin in px between this section and the next. Default 24. */
  gap?: number
  /** Optional className merged onto the section wrapper. */
  className?: string
  /** Optional style merged onto the section wrapper. */
  style?: React.CSSProperties
}

export function Section({
  title,
  description,
  children,
  action,
  gap = 24,
  className,
  style,
}: SectionProps) {
  return (
    <section
      className={className}
      style={{
        marginBottom: gap,
        fontFamily: 'JetBrains Mono, monospace',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: description ? 4 : 8,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {title}
        </h2>
        {action != null && <div style={{ flexShrink: 0 }}>{action}</div>}
      </div>
      {description != null && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            lineHeight: 1.5,
            marginBottom: 8,
          }}
        >
          {description}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </section>
  )
}

export default Section
