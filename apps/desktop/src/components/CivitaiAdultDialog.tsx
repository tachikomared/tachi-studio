// apps/desktop/src/components/CivitaiAdultDialog.tsx
//
// THE 18+ OPT-IN. The ONLY control in the app that can turn adult browsing on.
//
// It is a dedicated dialog and not a switch, because the spec's wording is not
// decoration: the affirmation must be EXPLICIT, AFFIRMATIVE, TIMESTAMPED, never
// a default, and never bundled into another toggle. A switch in a settings list
// satisfies none of those — it is one accidental click, it says nothing, and it
// leaves no record of what was agreed to. So the switch in the Civitai card
// OPENS this, and only the button below writes anything.
//
// FOUR THINGS THIS DIALOG OWES THE USER, ALL ON SCREEN AT ONCE:
//   1. what actually changes    — the host becomes civitai.red and R/X/XXX
//                                 rated models appear;
//   2. what NEVER changes       — layer 0. Real people, minors, taken-down
//                                 models and Blocked-flagged content are
//                                 excluded by a predicate that takes no
//                                 parameters. There is no setting for it, and
//                                 saying so here is the honest version of a
//                                 promise we are actually keeping;
//   3. why a key is required    — it is a POLICY choice, not a technical
//                                 unlock, and it is stated as one. Pretending
//                                 Civitai enforces this would be a lie (live
//                                 probes returned adult listings anonymously);
//   4. how to undo it           — deleting the key, or the switch, and either
//                                 takes effect on the next request.
//
// A11Y is the house useDialog() hook — Escape closes, Tab is trapped, focus
// returns to the switch that opened it — plus role="dialog" aria-modal and a
// real <input type="checkbox"> with a <label>, so the affirmation is keyboard-
// operable and announced without a line of our own keyboard code.
//
// The RULES live in civitaiAdultPolicy.ts (pure, unit-tested); this file is the
// markup that applies them.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../hooks/useDialog'
import { canAffirmCivitaiAdult, civitaiAdultUnlockPatch } from './civitaiAdultPolicy'

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

export interface CivitaiAdultDialogProps {
  /** Is the user's own Civitai key stored? Read from main, never guessed. */
  hasKey: boolean
  /** Called AFTER the settings write succeeds, so the caller can re-read main's
   *  state rather than assuming the write landed. */
  onConfirmed: () => void
  onCancel: () => void
  /** Test seam: the moment stamped into `civitaiAdultAcceptedAt`. */
  now?: () => number
}

export function CivitaiAdultDialog({
  hasKey,
  onConfirmed,
  onCancel,
  now = Date.now,
}: CivitaiAdultDialogProps): React.ReactElement {
  const { t } = useTranslation('settings')
  // NEVER PRE-CHECKED. An affirmation the user did not make is not one.
  const [affirmed, setAffirmed] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  const ref = useDialog<HTMLDivElement>(onCancel)
  const titleId = React.useId()
  const bodyId = React.useId()
  const affirmId = React.useId()

  const canConfirm = canAffirmCivitaiAdult({ affirmed, hasKey }) && !saving

  const confirm = async () => {
    if (!canConfirm) return
    setSaving(true)
    setFailed(false)
    try {
      // ONE save, BOTH keys. See civitaiAdultUnlockPatch for why they cannot be
      // written separately.
      await window.tachi.settings.save(civitaiAdultUnlockPatch(now()))
      onConfirmed()
    } catch {
      // A failed write must not leave the caller believing 18+ is on. Main is
      // the source of truth either way, but saying nothing here would make a
      // dead dialog look like a working one.
      setFailed(true)
      setSaving(false)
    }
  }

  return (
    // Backdrop — click outside cancels (nothing is written by cancelling).
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0, 0, 0, 0.50)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        data-testid="civitai-adult-dialog"
        style={{
          ...MONO,
          width: 'min(560px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--bg-surface)',
          border: '2px solid var(--accent)',
          boxShadow: 'var(--shadow-hard)',
          display: 'flex', flexDirection: 'column',
          outline: 'none',
        }}
      >
        <div style={{
          padding: '10px 14px 8px',
          borderBottom: '2px solid var(--accent)',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--accent)',
        }}>
          <span id={titleId}>{t('civitai.adult.title')}</span>
        </div>

        <div id={bodyId} style={{ padding: '14px 14px 4px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--text-primary)' }}>
            {t('civitai.adult.whatChanges')}
          </p>

          {/* WHAT NEVER CHANGES. Visually separated because it is the one claim
              here that is unconditional, and burying it in a paragraph would
              read as boilerplate rather than as the guarantee it is. */}
          <div style={{
            border: '2px solid var(--border)',
            background: 'var(--bg-inset, var(--bg-base))',
            padding: '9px 11px',
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4,
            }}>
              {t('civitai.adult.neverLabel')}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-primary)' }}>
              {t('civitai.adult.never')}
            </div>
          </div>

          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)' }}>
            {t('civitai.adult.keyPolicy')}
          </p>

          {/* The affirmation. A real checkbox with a real label: clicking the
              text toggles it, Space toggles it, and it is announced. */}
          <label
            htmlFor={affirmId}
            style={{
              display: 'flex', gap: 9, alignItems: 'flex-start',
              cursor: 'pointer', fontSize: 12, lineHeight: 1.5,
              color: 'var(--text-primary)',
            }}
          >
            <input
              id={affirmId}
              type="checkbox"
              checked={affirmed}
              onChange={e => setAffirmed(e.target.checked)}
              data-testid="civitai-adult-affirm"
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <span>{t('civitai.adult.affirm')}</span>
          </label>

          {/* No key ⇒ say so instead of offering a button that writes a setting
              which provably does nothing. */}
          {!hasKey && (
            <div
              role="note"
              style={{
                fontSize: 11, lineHeight: 1.5,
                color: 'var(--destructive, var(--danger, #ff5252))',
                border: '2px solid var(--destructive, var(--danger, #ff5252))',
                padding: '8px 10px',
              }}
            >
              {t('civitai.adult.needKey')}
            </div>
          )}

          {failed && (
            <div role="alert" style={{ fontSize: 11, color: 'var(--destructive, var(--danger, #ff5252))' }}>
              {t('civitai.adult.saveFailed')}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 14px 14px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              ...MONO,
              padding: '5px 14px', border: '2px solid var(--border)',
              background: 'transparent', color: 'var(--text-primary)',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', cursor: 'pointer',
            }}
          >
            {t('civitai.adult.cancel')}
          </button>
          <button
            type="button"
            onClick={() => { void confirm() }}
            disabled={!canConfirm}
            data-testid="civitai-adult-confirm"
            style={{
              ...MONO,
              padding: '5px 14px', border: '2px solid var(--accent)',
              background: 'var(--accent)', color: '#ffffff',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: canConfirm ? 'pointer' : 'not-allowed',
              opacity: canConfirm ? 1 : 0.5,
            }}
          >
            {t('civitai.adult.enable')}
          </button>
        </div>
      </div>
    </div>
  )
}
