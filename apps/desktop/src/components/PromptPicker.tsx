// apps/desktop/src/components/PromptPicker.tsx
//
// Prompt-library picker panel — shared by the chat InputBar and the Nodes
// Prompt node. Lists templates (search + tag), fills {{variables}} inline,
// then hands the rendered text to `onInsert`. Optionally saves the caller's
// current text as a new template.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { extractUserVariables, renderTemplate, buildAutoVariableValues, type PromptTemplate } from '@tachi/core/src/prompts/template'
import { usePromptsStore } from '../store/prompts.store'

export function PromptPicker(props: {
  onInsert: (text: string) => void
  onClose: () => void
  /** When set, the panel offers “save this as a template”. */
  currentText?: string
  /** Active model id — fills the {{model}} auto-variable on insert. */
  activeModel?: string
  /**
   * The caller can fill {{blanks}} in place (the chat composer paints them as
   * chips and tabs between them), so hand the body over WITH its braces intact
   * instead of asking for every value in this 380px popup first.
   *
   * Off by default, and that default is load-bearing: the Nodes Prompt node has
   * no such affordance, so leaving the flag unset keeps its inline form exactly
   * as it was.
   */
  supportsBlanks?: boolean
}) {
  const { t } = useTranslation('common')
  const templates = usePromptsStore(s => s.templates)
  const ensureSeeded = usePromptsStore(s => s.ensureSeeded)
  const add = usePromptsStore(s => s.add)
  const remove = usePromptsStore(s => s.remove)

  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveTitle, setSaveTitle] = useState('')

  useEffect(() => { ensureSeeded() }, [ensureSeeded])

  // The panel floats over canvases/threads with no backdrop — it MUST close on
  // Escape and on any click outside (it was un-dismissable on the Nodes canvas,
  // where the toggle chip is easy to lose).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose() }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) props.onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return templates
    return templates.filter(tpl =>
      tpl.title.toLowerCase().includes(q) || tpl.body.toLowerCase().includes(q) || (tpl.tag ?? '').toLowerCase().includes(q))
  }, [templates, query])

  // Auto-vars ({{date}}/{{time}}/{{os}}/{{model}}) resolve at insert time and are
  // NOT prompted for. Recomputed per insert so {{time}} is fresh.
  const autoValues = () => buildAutoVariableValues({
    now: Date.now(),
    os: (navigator as { platform?: string }).platform,
    model: props.activeModel,
    locale: navigator.language,
  })

  const pick = (tpl: PromptTemplate) => {
    const vars = extractUserVariables(tpl.body)
    // Either there is nothing to ask for, or the caller would rather be asked
    // in its own composer — both cases insert straight away. Auto-vars are
    // still resolved here; only the USER blanks travel as literal braces.
    if (vars.length === 0 || props.supportsBlanks) {
      props.onInsert(renderTemplate(tpl.body, autoValues())); props.onClose(); return
    }
    setOpenId(tpl.id)
    setValues({})
  }

  const insertWithValues = (tpl: PromptTemplate) => {
    // User values win over auto-vars if a name collides.
    props.onInsert(renderTemplate(tpl.body, { ...autoValues(), ...values }))
    props.onClose()
  }

  const box: React.CSSProperties = {
    position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, width: 380, maxHeight: 340,
    display: 'flex', flexDirection: 'column', zIndex: 60,
    background: 'var(--bg-elevated)', border: '2px solid var(--border-strong)',
    boxShadow: 'var(--shadow-hard)', fontFamily: 'JetBrains Mono, monospace',
  }
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
    borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
    background: 'transparent', border: 'none', width: '100%',
  }

  return (
    <div ref={rootRef} style={box} data-testid="prompt-picker">
      <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '2px solid var(--border)' }}>
        <input
          autoFocus value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') props.onClose() }}
          placeholder={t('prompts.search')}
          style={{ flex: 1, background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, padding: '5px 8px', outline: 'none' }}
        />
        {typeof props.currentText === 'string' && props.currentText.trim().length > 0 && (
          <button onClick={() => { setSaving(v => !v); setSaveTitle('') }}
            style={{ padding: '4px 10px', border: '2px solid var(--border)', background: saving ? 'var(--accent-muted)' : 'transparent', color: 'var(--accent-text)', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>
            {t('prompts.saveCurrent')}
          </button>
        )}
        <button onClick={props.onClose} aria-label={t('prompts.close', { defaultValue: 'Close' })}
          style={{ padding: '4px 8px', border: '2px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>
          ✕
        </button>
      </div>
      {saving && (
        <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '2px solid var(--border)' }}>
          <input value={saveTitle} onChange={e => setSaveTitle(e.target.value)} placeholder={t('prompts.titlePlaceholder')}
            onKeyDown={e => { if (e.key === 'Enter' && saveTitle.trim()) { add({ title: saveTitle, body: props.currentText ?? '' }); setSaving(false) } }}
            style={{ flex: 1, background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, padding: '5px 8px', outline: 'none' }} />
          <button onClick={() => { if (saveTitle.trim()) { add({ title: saveTitle, body: props.currentText ?? '' }); setSaving(false) } }}
            style={{ padding: '4px 10px', border: '2px solid var(--border-strong)', background: 'var(--accent)', color: '#fff', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>
            {t('prompts.save')}
          </button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-dim)' }}>{t('prompts.empty')}</div>
        )}
        {filtered.map(tpl => {
          const vars = extractUserVariables(tpl.body)
          const open = openId === tpl.id
          return (
            <div key={tpl.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button style={{ ...row, flex: 1, borderBottom: 'none' }} onClick={() => pick(tpl)} title={tpl.body.slice(0, 400)}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.title}</span>
                  {tpl.tag && <span style={{ fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--border)', padding: '1px 5px' }}>{tpl.tag}</span>}
                  {vars.length > 0 && <span style={{ fontSize: 9, color: 'var(--accent-text)' }}>{`{{${vars.length}}}`}</span>}
                </button>
                <button onClick={() => remove(tpl.id)} title={t('prompts.delete')}
                  style={{ border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, padding: '0 10px' }}>×</button>
              </div>
              {open && vars.length > 0 && (
                <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {vars.map(v => (
                    <input key={v} value={values[v] ?? ''} onChange={e => setValues(prev => ({ ...prev, [v]: e.target.value }))}
                      placeholder={v}
                      onKeyDown={e => { if (e.key === 'Enter') insertWithValues(tpl) }}
                      style={{ background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, padding: '5px 8px', outline: 'none' }} />
                  ))}
                  <button onClick={() => insertWithValues(tpl)}
                    style={{ alignSelf: 'flex-start', padding: '4px 12px', border: '2px solid var(--border-strong)', background: 'var(--accent)', color: '#fff', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>
                    {t('prompts.insert')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
