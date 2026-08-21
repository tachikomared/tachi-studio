// apps/desktop/src/pages/settings/LocalEngineSection.tsx
//
// Settings → Advanced → LOCAL ENGINE: KV-cache precision for llama.cpp.
//
// The plumbing for `--cache-type-k` shipped on 2026-08-03 and had NO control,
// which made it inert — a flag nothing could ever set. This is that control.
//
// Why it is worth a setting at all: the KV cache is the second-largest thing in
// VRAM after the weights, and past a few thousand tokens of context it can be
// the larger of the two. Halving the key half of it is often the difference
// between a model that fits on the card and one that spills into system RAM,
// where it runs an order of magnitude slower.
//
// Three things this UI must NOT do, each learned the expensive way:
//   · claim a speed-up. Quantised KV buys MEMORY. What that memory buys back
//     depends on whether the model was spilling, which we cannot know here.
//   · claim f16 is llama.cpp's default. f16 means WE PASS NOTHING and the
//     installed build decides — a different statement, and the true one.
//   · pretend the change is live. llama-server's argv is fixed at spawn, so a
//     running model keeps the precision it started with. The row says so, and
//     only when something is actually running.
//
// Styling follows ContextRecallSection so the Advanced tab reads as one surface.

import React from 'react'
import { useTranslation } from 'react-i18next'

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

/** Mirrors the zod enum in electron/services/settings-schema.ts. */
type KvCache = 'f16' | 'q8_0' | 'q4_0'
const CHOICES: KvCache[] = ['f16', 'q8_0', 'q4_0']
const FALLBACK: KvCache = 'f16'

function isKvCache(v: unknown): v is KvCache {
  return v === 'f16' || v === 'q8_0' || v === 'q4_0'
}

export function LocalEngineSection() {
  const { t } = useTranslation('settings')
  const [value, setValue] = React.useState<KvCache>(FALLBACK)
  const [runningModel, setRunningModel] = React.useState<string | null>(null)

  React.useEffect(() => {
    window.tachi.settings.load()
      .then(s => { if (isKvCache(s.llamaKvCache)) setValue(s.llamaKvCache) })
      .catch(() => { /* unreadable settings → keep the default on screen */ })
    // Only to decide whether the "takes effect on next load" line is TRUE right
    // now. A failed probe shows no line rather than a wrong one.
    window.tachi.llamaCpp.status()
      .then(s => { setRunningModel(s.state === 'running' ? (s.modelId ?? null) : null) })
      .catch(() => { /* no status → say nothing about restarts */ })
  }, [])

  const choose = async (next: KvCache) => {
    if (next === value) return
    const prev = value
    setValue(next)
    try { await window.tachi.settings.save({ llamaKvCache: next }) } catch { setValue(prev) }
  }

  return (
    <div style={{
      border: '2px solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      marginBottom: 24,
      ...MONO,
    }}>
      <div style={{
        padding: '10px 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
            {t('localEngine.kvTitle')}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
            {t('localEngine.kvDescription')}
          </div>
        </div>

        <div role="radiogroup" aria-label={t('localEngine.kvTitle')} style={{ display: 'flex', flexShrink: 0 }}>
          {CHOICES.map((c, i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={value === c}
              onClick={() => { void choose(c) }}
              style={{
                ...MONO,
                padding: '5px 10px', fontSize: 10, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                cursor: 'pointer',
                border: '2px solid var(--border)',
                borderLeftWidth: i === 0 ? 2 : 0,
                background: value === c ? 'var(--accent)' : 'var(--bg-base)',
                color: value === c ? 'var(--accent-fg, var(--bg-base))' : 'var(--text-primary)',
                // A RADIOGROUP SWAPS INSTANTLY, and that is a stricter rule than
                // the app-wide one.
                //
                // globals.css now eases `color` alongside `background-color`, so
                // the label can no longer end up the same colour as its own
                // background (it used to: measured on the installed build as
                // white-on-white). That fixes READABILITY everywhere.
                //
                // It does not fix AMBIGUITY here. For 120ms the button you left
                // is still partly lit while the one you picked is only partly
                // lit, and a radiogroup is the one control whose whole promise
                // is that exactly one option is chosen. Two half-lit buttons
                // break that promise in a way a hover state never does — so
                // this control opts out of the background/colour easing and
                // keeps only the press feel.
                transition: 'transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 120ms cubic-bezier(0.2, 0.8, 0.2, 1)',
              }}
            >
              {t(`localEngine.kv_${c}`)}
            </button>
          ))}
        </div>
      </div>

      <div style={{
        padding: '10px 14px',
        borderTop: '2px solid var(--border)',
        fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5,
      }}>
        {/* What the CURRENT choice actually does — not a table of all three,
            because the user picked one and wants to know about that one. */}
        <div>{t(`localEngine.kvEffect_${value}`)}</div>
        {runningModel && (
          <div style={{ marginTop: 6, color: 'var(--text-primary)' }}>
            {t('localEngine.kvRestartHint', { model: runningModel })}
          </div>
        )}
      </div>
    </div>
  )
}
