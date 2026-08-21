import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMemoryStore, hasActiveMemory } from '../../store/memory.store'
import { usePrivacyStore } from '../../store/privacy.store'
import { useAgentStore, getContextZone } from '../../store/agent.store'
import { useContextWindow, describeContextUsage, contextUsageTitle } from '../../store/modelWindow.store'
import { modelDisplayName } from '../../utils/model-display'

interface PageTopbarProps {
  section: string
  sessionName?: string
  badge?: string
  /** Optional model readout in the header. NOTE (UX F17): the CHAT surface no
   *  longer passes this — its composer footer strip is the single source for
   *  provider · model · tokens state, so the header stays title + New +
   *  overflow. Kept for any other surface that wants a header model readout. */
  modelName?: string
  onNew?: () => void
  leftAction?: React.ReactNode
  rightAction?: React.ReactNode
  /** D4: When set, renders the [CTX nn%] badge for this conversation. */
  ctxConversationId?: string
  /** D4: Provider ID for the active conversation — scopes the model lookup
   *  (two gateways serve same-named models at different windows). */
  ctxProviderId?: string
  /**
   * Model id for the active conversation. REQUIRED for an honest badge: the
   * window is a per-model fact, and without it this chip did what it did until
   * 2026-08-02 — read a per-PROVIDER constant and tell a 200k Venice model it
   * had 32k while the picker beside it said otherwise.
   */
  ctxModelId?: string
}

// D4: CTX badge — shows [CTX 73%] in brutalist style. Border color follows zone.
//
// THE NUMBER COMES FROM `useContextWindow` (→ resolveContextWindow + the window
// the provider's own catalog published, as recorded by the model pickers), which
// is the SAME source the picker rows are built from. Do not reintroduce a
// per-provider table here: a provider does not have a context window, a model
// does. When nobody published one for this model we show tokens used and NO
// percentage — a percentage needs a denominator we do not have.
function CtxBadge({ conversationId, providerId, modelId }: { conversationId: string; providerId: string; modelId: string }) {
  const [tooltipVisible, setTooltipVisible] = useState(false)

  // Chars are the only MEASURED quantity here (main counts them per turn); the
  // denominator is resolved, not stored. Selecting the single number keeps this
  // out of every unrelated store update.
  const chars     = useAgentStore(s => s.contextChars[conversationId] ?? 0)
  const win       = useContextWindow(providerId, modelId)
  const usage     = describeContextUsage(chars, win)
  // No known window ⇒ no zone: colouring by an invented denominator is the same
  // lie in another channel. Neutral until the provider tells us the size.
  const zone      = usage.pct === null ? null : getContextZone(usage.pct / 100)

  const borderColor = zone === null
    ? 'var(--border)'
    : zone === 'red'
      ? 'var(--danger)'
      : zone === 'yellow'
        ? 'var(--warning)'
        : 'var(--success)'
  const textColor = zone === null ? 'var(--text-muted)' : borderColor

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setTooltipVisible(v => !v)}
        /* The percentage and the zone colour are claims about how much room is
           LEFT, so they inherit every doubt the denominator carries: the title
           names who supplied the window whenever it was not the provider. Shared
           with the CODE meter so the two cannot word one reading two ways. */
        title={contextUsageTitle(usage, win, modelId)}
        style={{
          padding: '1px 6px',
          border: `2px solid ${borderColor}`,
          background: 'transparent',
          color: textColor,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.05em',
          cursor: 'pointer',
          lineHeight: 1.6,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {usage.pct === null
          ? `[CTX ${usage.tokens.toLocaleString()} TOK]`
          : `[CTX ${usage.pct}%]`}
      </button>
      {tooltipVisible && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: 'var(--bg-elevated)',
            border: `2px solid ${borderColor}`,
            padding: '8px 12px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: 'var(--text-primary)',
            zIndex: 9999,
            minWidth: 220,
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Context window</div>
          <div>chars: {chars.toLocaleString()}</div>
          <div>tokens (est): {usage.tokens.toLocaleString()}</div>
          {/* The window row prints ONLY what is known about this model. The
              source line says who answered, so a family estimate can never be
              mistaken for the provider's own number. This is the DETAIL view, so
              it names 'live' explicitly instead of leaving it as the unmarked
              case the compact surfaces use. */}
          {usage.windowTokens === null
            ? <div style={{ color: 'var(--text-muted)' }}>max tokens: not published for this model</div>
            : <div>max tokens: {usage.windowTokens.toLocaleString()} <span style={{ color: 'var(--text-dim)' }}>({win.source})</span></div>}
          <div>provider: {providerId || 'unknown'}</div>
          <div>model: {modelId || 'unknown'}</div>
          {zone !== null && (
            <div style={{ marginTop: 4, color: borderColor }}>zone: {zone.toUpperCase()}</div>
          )}
        </div>
      )}
    </div>
  )
}

export function PageTopbar({ section, sessionName, badge, modelName, onNew, leftAction, rightAction, ctxConversationId, ctxProviderId, ctxModelId }: PageTopbarProps) {
  const [newHovered, setNewHovered] = React.useState(false)
  const [menuHovered, setMenuHovered] = React.useState(false)
  const navigate = useNavigate()
  const memoryActive = useMemoryStore(s => hasActiveMemory(s.facts))
  const privateMode = usePrivacyStore(s => s.mode === 'private')

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 16px',
      borderBottom: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-surface)',
      minHeight: 40,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 12,
    }}>
      {leftAction}
      {/* Breadcrumb */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
        <span>{section}</span>
        {sessionName && (
          <>
            <span>/</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{sessionName}</span>
          </>
        )}
        {memoryActive && (
          <button
            onClick={() => navigate('/settings')}
            title="Memory is active — click to edit"
            style={{
              padding: '1px 6px',
              border: 'var(--border-width) solid var(--accent)',
              background: 'transparent',
              color: 'var(--accent)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              lineHeight: 1.6,
            }}
          >
            MEMORY
          </button>
        )}
        {privateMode && (
          <button
            onClick={() => navigate('/settings')}
            title="Private mode is active — click to edit"
            style={{
              padding: '1px 6px',
              border: 'var(--border-width) solid var(--border)',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              lineHeight: 1.6,
            }}
          >
            [STRICT]
          </button>
        )}
      </div>

      {/* Badge */}
      <div style={{
        padding: '2px 8px',
        border: 'var(--border-width) solid var(--accent)',
        background: 'var(--accent-muted)',
        color: 'var(--accent-text)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}>
        {badge ?? section}
      </div>

      {/* Right side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {modelName && (
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }} title={modelName}>{modelDisplayName(modelName)}</span>
        )}
        {onNew && (
          <button
            onClick={onNew}
            style={{
              padding: '4px 10px',
              border: 'var(--border-width) solid var(--border-strong)',
              background: newHovered ? 'var(--accent-muted)' : 'var(--bg-elevated)',
              color: newHovered ? 'var(--accent-text)' : 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              cursor: 'pointer',
              boxShadow: newHovered ? 'none' : 'var(--shadow-hard)',
              transition: 'none',
            }}
            onMouseEnter={() => setNewHovered(true)}
            onMouseLeave={() => setNewHovered(false)}
          >
            New
          </button>
        )}
        {/* D4: context window badge — only shown when a chat conversation is active */}
        {ctxConversationId && ctxProviderId && (
          <CtxBadge conversationId={ctxConversationId} providerId={ctxProviderId} modelId={ctxModelId ?? ''} />
        )}
        {rightAction}
        {/* More-options: opens the command palette (⌘K) — every page-level action
            lives there, so this is the discoverable entry point for mouse users. */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('tachi:toggle-palette'))}
          style={{
            padding: '4px 8px',
            border: 'var(--border-width) solid var(--border-strong)',
            background: menuHovered ? 'var(--bg-elevated)' : 'transparent',
            color: menuHovered ? 'var(--text-primary)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            cursor: 'pointer',
            lineHeight: 1,
            transition: 'none',
          }}
          aria-label="Open command palette"
          title="Command palette (⌘K)"
          onMouseEnter={() => setMenuHovered(true)}
          onMouseLeave={() => setMenuHovered(false)}
        >
          ⋯
        </button>
      </div>
    </div>
  )
}
