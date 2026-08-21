// apps/desktop/src/pages/nodes/canvas/ReferenceField.tsx
//
// A textarea that authors a TEMPLATE which may embed `{{node:<id>}}` reference
// tokens (the EXACT compiler token format — see src/lib/nodeRefs.ts). Used by
// the canvas Media node (prompt) and Agent node (system prompt) to let a field
// pull in upstream node outputs.
//
// Behaviour (n8n / flowith-inspired):
//   - Typing '@' (or '{{') opens a small dropdown listing the `upstream` nodes.
//     Selecting one inserts serializeToken(id) at the cursor (replacing the '@'
//     or '{{' trigger). Arrow keys + Enter navigate; Esc closes.
//   - The textarea stores tokens verbatim ({{node:id}}) in `value`.
//   - BELOW the textarea a muted "Resolves to:" LIVE PREVIEW renders the value
//     with tokens substituted by each upstream node's last-output preview
//     (resolveTokens — same resolver the compiler uses), so the author sees the
//     real text. Token-free values render no preview block.
//
// Brutalist; `nodrag` className on interactive elements so React Flow doesn't
// hijack drag/selection inside the node. Self-contained — the PARENT supplies
// `upstream` (id + label + preview); no store/IPC coupling here.
import React, { useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveTokens, serializeToken, previewMap, type UpstreamRef } from '../../../lib/nodeRefs'

interface ReferenceFieldProps {
  value:        string
  onChange:     (v: string) => void
  upstream:     UpstreamRef[]
  placeholder?: string
  rows?:        number
}

// ── styles ──────────────────────────────────────────────────────────────────────
const textareaStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12, outline: 'none', resize: 'vertical',
}
const dropdownStyle: React.CSSProperties = {
  position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%',
  maxHeight: 180, overflowY: 'auto',
  border: '2px solid var(--accent)', background: 'var(--bg-elevated)',
  boxShadow: '3px 3px 0 rgba(0,0,0,0.35)',
}
const previewBoxStyle: React.CSSProperties = {
  marginTop: 6, padding: '5px 7px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
  color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  maxHeight: 120, overflow: 'auto',
}
const previewLabelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginBottom: 3,
}

// The two trigger sequences that open the dropdown. We track which one fired so
// selection replaces exactly that many chars.
type Trigger = { kind: '@' | '{{'; at: number }

export function ReferenceField({ value, onChange, upstream, placeholder, rows = 3 }: ReferenceFieldProps) {
  const { t } = useTranslation('nodes')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [active, setActive]   = useState(0)

  // Live preview: resolve tokens against each upstream node's last-output preview.
  const map = useMemo(() => previewMap(upstream), [upstream])
  const resolved = useMemo(() => resolveTokens(value, map), [value, map])
  const showPreview = value.includes('{{')

  const open = trigger !== null && upstream.length > 0

  const closeMenu = useCallback(() => { setTrigger(null); setActive(0) }, [])

  // Detect a trigger right before the caret after each change.
  const handleChange = useCallback((next: string, caret: number) => {
    onChange(next)
    const before = next.slice(0, caret)
    if (before.endsWith('{{')) { setTrigger({ kind: '{{', at: caret - 2 }); setActive(0); return }
    if (before.endsWith('@'))  { setTrigger({ kind: '@',  at: caret - 1 }); setActive(0); return }
    if (trigger) closeMenu()
  }, [onChange, trigger, closeMenu])

  // Insert the token for `ref`, replacing the trigger chars, and refocus.
  const choose = useCallback((ref: UpstreamRef) => {
    if (!trigger) return
    const el = taRef.current
    const caret = el ? el.selectionStart : value.length
    const token = serializeToken(ref.id)
    const next = value.slice(0, trigger.at) + token + value.slice(caret)
    onChange(next)
    closeMenu()
    // Restore caret after the inserted token on the next tick.
    requestAnimationFrame(() => {
      if (!el) return
      const pos = trigger.at + token.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }, [trigger, value, onChange, closeMenu])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) {
      if (e.key === 'Escape' && trigger) { closeMenu() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(upstream.length - 1, a + 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(0, a - 1)); return }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const r = upstream[active]; if (r) choose(r); return }
    if (e.key === 'Escape')    { e.preventDefault(); closeMenu(); return }
  }, [open, trigger, upstream, active, choose, closeMenu])

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={taRef}
        className="nodrag nowheel"
        value={value}
        rows={rows}
        placeholder={placeholder ?? t('referenceField.placeholder')}
        onChange={e => handleChange(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => { /* let click on a menu item fire first */ setTimeout(closeMenu, 120) }}
        style={textareaStyle}
      />

      {open && (
        <div className="nowheel" style={dropdownStyle}>
          {upstream.map((ref, i) => {
            const isActive = i === active
            return (
              <button
                key={ref.id}
                type="button"
                className="nodrag"
                onMouseDown={e => { e.preventDefault(); choose(ref) }}
                onMouseEnter={() => setActive(i)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px', border: 'none', cursor: 'pointer',
                  borderBottom: 'var(--border-width) solid var(--border)',
                  background: isActive ? 'var(--accent-muted)' : 'transparent',
                  color: isActive ? 'var(--accent-text)' : 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700 }}>{ref.label}</span>
                {ref.preview && (
                  <span style={{
                    display: 'block', fontSize: 9,
                    color: isActive ? 'var(--accent-text)' : 'var(--text-dim)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {ref.preview}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {showPreview && (
        <div style={previewBoxStyle}>
          <span style={previewLabelStyle}>{t('referenceField.resolvesTo')}</span>
          {resolved || <span style={{ color: 'var(--text-dim)' }}>{t('referenceField.empty')}</span>}
        </div>
      )}
    </div>
  )
}
