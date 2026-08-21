// apps/desktop/src/pages/settings/ShortcutsSection.tsx
//
// Keyboard shortcuts customisation panel. Lets users remap every action in
// HOTKEY_ACTIONS and warns if the chosen combo conflicts with a known OS
// reservation.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HOTKEY_ACTIONS, type HotkeyAction } from '../../types/hotkeys'
import { findConflict, normaliseAccelerator } from '../../types/hotkey-conflicts'
import { getShortcutBadgeState, type HotkeyRegistrationRow, type ShortcutBadgeState } from './shortcutBadge'

// ── Platform detection ────────────────────────────────────────────────────────

function detectPlatform(): NodeJS.Platform {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win'))   return 'win32'
  if (ua.includes('mac'))   return 'darwin'
  if (ua.includes('linux')) return 'linux'
  return 'linux'
}

const PLATFORM = detectPlatform()

const PLATFORM_LABEL: Record<string, string> = {
  win32:  'Windows',
  darwin: 'macOS',
  linux:  'Linux',
}

// ── Accelerator capture helpers ───────────────────────────────────────────────

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt'])

/**
 * Convert a KeyboardEvent into an Electron accelerator string.
 * Returns null if only modifier keys were pressed.
 */
function eventToAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null

  const parts: string[] = []
  if (e.metaKey)  parts.push('Command')
  if (e.ctrlKey)  parts.push('Control')
  if (e.altKey)   parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  const KEY_MAP: Record<string, string> = {
    ' ':          'Space',
    'ArrowUp':    'Up',
    'ArrowDown':  'Down',
    'ArrowLeft':  'Left',
    'ArrowRight': 'Right',
    'Escape':     'Escape',
    'Enter':      'Return',
    'Backspace':  'Backspace',
    'Delete':     'Delete',
    'Tab':        'Tab',
    'Home':       'Home',
    'End':        'End',
    'PageUp':     'PageUp',
    'PageDown':   'PageDown',
    'Insert':     'Insert',
  }
  const key = KEY_MAP[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  parts.push(key)
  return parts.join('+')
}

/** Format an accelerator string for display: 'CommandOrControl+K' -> 'Ctrl + K'
 *  (⌘ on mac). Electron's internal token names are developer-speak — users
 *  should see the key that is actually on their keyboard (QA 2026-07-18). */
function formatAccelerator(accel: string): string {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  return accel.split('+').map(part => {
    switch (part) {
      case 'CommandOrControl': case 'CmdOrCtrl': return isMac ? '⌘' : 'Ctrl'
      case 'Command': return '⌘'
      case 'Control': return 'Ctrl'
      case 'Option': return isMac ? '⌥' : 'Alt'
      default: return part
    }
  }).join(' + ')
}

// ── Styles (inline brutalist) ─────────────────────────────────────────────────

const FONT: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const CHIP_BASE: React.CSSProperties = {
  ...FONT,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '2px 6px',
  border: 'var(--border-width, 2px) solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  flexShrink: 0,
}

const ACCEL_DISPLAY: React.CSSProperties = {
  ...FONT,
  fontSize: 11,
  padding: '5px 10px',
  border: 'var(--border-width, 2px) solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  minWidth: 180,
  textAlign: 'center' as const,
  boxShadow: 'var(--shadow-hard)',
  userSelect: 'none' as const,
}

const ACCEL_CAPTURE: React.CSSProperties = {
  ...ACCEL_DISPLAY,
  border: 'var(--border-width, 2px) solid var(--accent)',
  color: 'var(--accent)',
  outline: 'none',
}

const BTN_RESET: React.CSSProperties = {
  ...FONT,
  fontSize: 9,
  fontWeight: 700,
  padding: '4px 10px',
  border: 'var(--border-width, 2px) solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
}

const BTN_PRIMARY: React.CSSProperties = {
  ...FONT,
  fontSize: 9,
  fontWeight: 700,
  padding: '5px 14px',
  border: 'var(--border-width, 2px) solid var(--border)',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
  boxShadow: 'var(--shadow-hard)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
}

const BTN_SECONDARY: React.CSSProperties = {
  ...FONT,
  fontSize: 9,
  fontWeight: 700,
  padding: '5px 14px',
  border: 'var(--border-width, 2px) solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
}

// Red badge shown per-row when the last global-shortcut registration attempt
// failed (another app already owns the accelerator) — see shortcutBadge.ts.
const NOT_REGISTERED_BADGE: React.CSSProperties = {
  ...FONT,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.04em',
  padding: '2px 6px',
  border: '2px solid #d64545',
  background: 'transparent',
  color: '#d64545',
  textTransform: 'uppercase' as const,
  flexShrink: 0,
  cursor: 'default',
}

const NOT_REGISTERED_BLOCK: React.CSSProperties = {
  ...FONT,
  fontSize: 10,
  color: 'var(--text-primary)',
  background: 'var(--bg-elevated)',
  border: '2px solid #d64545',
  padding: '6px 10px',
  marginBottom: 6,
  borderTop: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap' as const,
}

// ── ShortcutRow ───────────────────────────────────────────────────────────────

interface ShortcutRowProps {
  action:         HotkeyAction
  currentAccel:   string   // resolved (override or default)
  isModified:     boolean
  conflictOwner:  string | null
  badge:          ShortcutBadgeState
  capturing:      boolean
  onStartCapture: () => void
  onCommit:       (accel: string) => void
  onCancel:       () => void
  onReset:        () => void
}

function ShortcutRow({
  action,
  currentAccel,
  isModified,
  conflictOwner,
  badge,
  capturing,
  onStartCapture,
  onCommit,
  onCancel,
  onReset,
}: ShortcutRowProps) {
  const { t } = useTranslation('settings')
  const captureRef = useRef<HTMLDivElement>(null)

  // Focus the capture div when entering capture mode so keydown fires.
  useEffect(() => {
    if (capturing && captureRef.current) {
      captureRef.current.focus()
    }
  }, [capturing])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      onCancel()
      return
    }
    const accel = eventToAccelerator(e)
    if (accel !== null) {
      onCommit(accel)
    }
  }, [onCommit, onCancel])

  useEffect(() => {
    if (!capturing || !captureRef.current) return
    const el = captureRef.current
    el.addEventListener('keydown', handleKeyDown as EventListener)
    return () => el.removeEventListener('keydown', handleKeyDown as EventListener)
  }, [capturing, handleKeyDown])

  return (
    <div>
      {/* Main row: 4-column grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto auto auto',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderBottom: (conflictOwner || badge.notRegistered) ? 'none' : 'var(--border-width) solid var(--border)',
      }}>
        {/* Label + description */}
        <div>
          <div style={{ ...FONT, fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
            {action.label}
          </div>
          <div style={{ ...FONT, fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {action.description}
          </div>
        </div>

        {/* Scope chip */}
        <div style={CHIP_BASE}>
          {action.scope === 'global' ? t('shortcuts.scopeGlobal') : t('shortcuts.scopeInApp')}
        </div>

        {/* Accelerator display / capture mode */}
        <div
          ref={captureRef}
          tabIndex={capturing ? 0 : -1}
          title={capturing ? t('shortcuts.captureTitle') : t('shortcuts.remapTitle')}
          onClick={() => { if (!capturing) onStartCapture() }}
          style={capturing ? ACCEL_CAPTURE : { ...ACCEL_DISPLAY, opacity: isModified ? 1 : 0.85 }}
        >
          {capturing ? t('shortcuts.pressKeys') : formatAccelerator(currentAccel)}
        </div>

        {/* Reset to default */}
        <button
          onClick={onReset}
          disabled={!isModified}
          title={t('shortcuts.resetTitle')}
          style={{ ...BTN_RESET, opacity: isModified ? 1 : 0.35 }}
        >
          {t('shortcuts.reset')}
        </button>
      </div>

      {/* Conflict warning — shown after capture if a conflict was detected */}
      {conflictOwner && (
        <div style={{
          ...FONT,
          fontSize: 10,
          color: 'var(--text-primary)',
          background: 'var(--bg-elevated)',
          border: '2px solid #d4a017',
          padding: '6px 10px',
          marginBottom: 6,
          borderTop: 'none',
          borderBottom: badge.notRegistered ? 'none' : 'var(--border-width) solid var(--border)',
        }}>
          {t('shortcuts.conflictWarning', { owner: conflictOwner, platform: PLATFORM_LABEL[PLATFORM] ?? PLATFORM })}
        </div>
      )}

      {/* NOT REGISTERED badge — this action's last global-shortcut registration
          attempt failed because another app already owns the accelerator. */}
      {badge.notRegistered && (
        <div style={{ ...NOT_REGISTERED_BLOCK, borderBottom: 'var(--border-width) solid var(--border)' }}>
          <span
            style={NOT_REGISTERED_BADGE}
            title={t('shortcuts.notRegisteredTooltip', { accel: formatAccelerator(badge.failedAccel ?? '') })}
          >
            {t('shortcuts.notRegistered')}
          </span>
          <span>{t('shortcuts.notRegisteredHint')}</span>
        </div>
      )}
    </div>
  )
}

// ── ShortcutsSection ──────────────────────────────────────────────────────────

export function ShortcutsSection() {
  const { t } = useTranslation('settings')
  // overrides: currently displayed values (user's edits not yet saved)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  // savedOverrides: what was last persisted to disk
  const [savedOverrides, setSavedOverrides] = useState<Record<string, string>>({})
  // conflictOwners: per-action conflict owner string, set after capture
  const [conflictOwners, setConflictOwners] = useState<Record<string, string | null>>({})
  const [capturingId, setCapturingId] = useState<string | null>(null)
  const [saving, setSaving]     = useState(false)
  const [savedOk, setSavedOk]   = useState(false)
  // Per-action global-shortcut registration results ({id, accel, ok}), loaded
  // ONCE on mount — no polling. null until the load resolves (or on failure),
  // in which case no NOT-REGISTERED badge is shown (see shortcutBadge.ts).
  const [registrations, setRegistrations] = useState<HotkeyRegistrationRow[] | null>(null)

  // Load saved overrides on mount.
  useEffect(() => {
    window.tachi.hotkeys.load().then(h => {
      setOverrides(h)
      setSavedOverrides(h)
    }).catch(() => {})
  }, [])

  // Load hotkey registration results ONCE on mount — no polling. Surfaces
  // the "NOT REGISTERED" badge for global shortcuts another app already owns.
  useEffect(() => {
    window.tachi.hotkeys.registrations().then(setRegistrations).catch(() => {})
  }, [])

  const startCapture = useCallback((id: string) => {
    setCapturingId(id)
  }, [])

  const cancelCapture = useCallback(() => {
    setCapturingId(null)
  }, [])

  const commitCapture = useCallback((id: string, rawAccel: string) => {
    const normalised = normaliseAccelerator(rawAccel)
    setOverrides(prev => ({ ...prev, [id]: normalised }))
    // Check for OS conflict and surface the warning.
    const hit = findConflict(normalised, PLATFORM)
    setConflictOwners(prev => ({ ...prev, [id]: hit ? hit.owner : null }))
    setCapturingId(null)
  }, [])

  const resetAction = useCallback((id: string) => {
    setOverrides(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setConflictOwners(prev => ({ ...prev, [id]: null }))
  }, [])

  const resetAll = useCallback(() => {
    setOverrides({})
    setConflictOwners({})
  }, [])

  const saveAll = useCallback(async () => {
    setSaving(true)
    setSavedOk(false)
    try {
      await window.tachi.hotkeys.save(overrides)
      setSavedOverrides(overrides)
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2000)
    } finally {
      setSaving(false)
    }
  }, [overrides])

  const hasUnsaved = JSON.stringify(overrides) !== JSON.stringify(savedOverrides)

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Header row */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: 20,
        gap: 16,
      }}>
        <div>
          <h2 style={{ ...FONT, fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>
            {t('shortcuts.title')}
          </h2>
          <p style={{ ...FONT, fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
            {t('shortcuts.description')}
          </p>
        </div>
        <button onClick={resetAll} style={BTN_SECONDARY} title={t('shortcuts.resetAllTitle')}>
          {t('shortcuts.resetAll')}
        </button>
      </div>

      {/* Shortcut list */}
      <div style={{
        border: 'var(--border-width, 2px) solid var(--border)',
        background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-hard)',
        padding: '0 16px',
      }}>
        {HOTKEY_ACTIONS.map((action) => {
          const currentAccel   = overrides[action.id] ?? action.defaultAccelerator
          const isModified     = !!overrides[action.id]
          const conflictOwner  = conflictOwners[action.id] ?? null
          const badge          = getShortcutBadgeState(registrations, action.id)
          return (
            <ShortcutRow
              key={action.id}
              action={action}
              currentAccel={currentAccel}
              isModified={isModified}
              conflictOwner={conflictOwner}
              badge={badge}
              capturing={capturingId === action.id}
              onStartCapture={() => startCapture(action.id)}
              onCommit={(accel) => commitCapture(action.id, accel)}
              onCancel={cancelCapture}
              onReset={() => resetAction(action.id)}
            />
          )
        })}
      </div>

      {/* Save bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button
          onClick={saveAll}
          disabled={saving || !hasUnsaved}
          style={{ ...BTN_PRIMARY, opacity: hasUnsaved && !saving ? 1 : 0.5 }}
        >
          {saving ? t('shortcuts.saving') : savedOk ? t('shortcuts.saved') : t('shortcuts.saveChanges')}
        </button>
        {hasUnsaved && !saving && (
          <span style={{ ...FONT, fontSize: 10, color: 'var(--text-muted)' }}>
            {t('shortcuts.unsaved')}
          </span>
        )}
      </div>
    </div>
  )
}
