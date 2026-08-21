// apps/desktop/src/pages/aeon/AeonTaskComposer.tsx
//
// Dynamic "give Aeon a task" composer.
//
// When a workflow is selected, fetches its `workflow_dispatch.inputs` schema
// from the YAML source and renders the appropriate form fields (text for
// strings, select for choice, checkbox for boolean, etc). This means the
// composer always sends exactly the right keys for whatever skill the user
// picks — no more 422 "Required input X not provided" errors.
//
// Special-case: when an input is literally named `skill` and a `skills/`
// directory exists in the fork, render it as a select populated from that
// directory (Aeon's convention — each subdir is a callable sub-skill).
//
// Internal inputs (`chain_context_file` etc) are hidden by default; users
// can still set them via "Show advanced".
//
// Model dropdown: Aeon's workflow YAMLs expose a `model` choice input.
// Five models are only valid when the gateway is Bankr (they are routed
// through Bankr's LLM proxy and are not available via direct/opengateway).
// We inject them into the options list conditionally after fetching the
// gateway.provider from the fork's aeon.yml.

import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { AeonWorkflowSummary, AeonWorkflowInputSpec } from '../../types/electron'
import { showToast } from '../../components/Toaster'

// Models that are only valid when gateway.provider === 'bankr'.
const BANKR_ONLY_MODELS = [
  'gemini-3-pro',
  'gemini-3-flash',
  'gpt-5.2',
  'kimi-k2.5',
  'qwen3-coder',
] as const

interface AeonTaskComposerProps {
  owner: string
  onDispatched?: () => void
}

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  display: 'flex',
  flexDirection: 'column',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontFamily: 'JetBrains Mono, monospace',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
  fontFamily: 'JetBrains Mono, monospace',
}

const baseInputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  outline: 'none',
  boxSizing: 'border-box',
}

const selectStyle: React.CSSProperties = {
  ...baseInputStyle,
  width: '100%',
  appearance: 'none',
  cursor: 'pointer',
}

const ghostBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: 'var(--border-width) solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  cursor: 'pointer',
  textTransform: 'uppercase',
}

// GitHub's hard cap on workflow_dispatch inputs
const MAX_INPUT_KEYS = 25

// Inputs we hide by default — internal-only fields that shouldn't be set by
// hand (set by chain runners, schedulers, etc).
const HIDDEN_INPUTS = new Set(['chain_context_file'])

export function AeonTaskComposer({ owner, onDispatched }: AeonTaskComposerProps) {
  const { t } = useTranslation('aeon')
  const [workflows, setWorkflows]     = useState<AeonWorkflowSummary[]>([])
  const [loadingWf, setLoadingWf]     = useState(false)
  const [selectedPath, setSelected]   = useState<string>('')
  const [inputs, setInputs]           = useState<AeonWorkflowInputSpec[]>([])
  const [loadingInputs, setLoadingIn] = useState(false)
  const [values, setValues]           = useState<Record<string, string>>({})
  const [skillDirs, setSkillDirs]     = useState<string[]>([])
  const [showAdvanced, setShowAdv]    = useState(false)
  const [dispatching, setDispatch]    = useState(false)
  const [error, setError]             = useState<string | null>(null)
  // Gateway provider from the fork's aeon.yml — used to conditionally show
  // Bankr-only model options in the `model` choice input.
  const [gateway, setGateway]         = useState<'direct' | 'bankr' | 'opengateway' | null>(null)

  // ── Load workflows ────────────────────────────────────────────────────────
  const loadWorkflows = useCallback(async () => {
    if (!owner) return
    setLoadingWf(true)
    setError(null)
    try {
      const list = await window.tachi.aeon.listWorkflows(owner)
      setWorkflows(list)
      if (list.length > 0 && !selectedPath) {
        const firstActive = list.find(w => w.state === 'active') ?? list[0]
        setSelected(firstActive.path)
      }
    } catch (err: unknown) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setLoadingWf(false)
    }
  // selectedPath intentionally omitted — seed default once only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner])

  useEffect(() => { loadWorkflows() }, [loadWorkflows])

  // ── Fetch gateway.provider from aeon.yml so we can gate Bankr-only models ─
  useEffect(() => {
    if (!owner) return
    window.tachi.aeon.getGateway(owner)
      .then(setGateway)
      .catch(() => setGateway('direct'))
  }, [owner])

  // ── Load the skills/* directory once per owner (used by `skill` field) ───
  useEffect(() => {
    if (!owner) return
    window.tachi.aeon.listSkillDirs(owner)
      .then(setSkillDirs)
      .catch(() => setSkillDirs([]))
  }, [owner])

  // ── Load inputs schema when workflow changes ──────────────────────────────
  useEffect(() => {
    if (!owner || !selectedPath) {
      setInputs([])
      setValues({})
      return
    }
    setLoadingIn(true)
    setError(null)
    window.tachi.aeon.workflowInputs(owner, selectedPath)
      .then(schema => {
        setInputs(schema)
        // Seed defaults so dispatching without touching a field still sends
        // the workflow's declared default (matters for `choice` types).
        const seed: Record<string, string> = {}
        for (const inp of schema) {
          if (inp.default != null) seed[inp.name] = inp.default
          else if (inp.type === 'boolean') seed[inp.name] = 'false'
        }
        setValues(seed)
      })
      .catch(err => {
        setInputs([])
        setError(t('composer.errors.readInputs', { path: selectedPath, error: err?.message ?? err }))
      })
      .finally(() => setLoadingIn(false))
  }, [owner, selectedPath])

  function setValue(name: string, v: string) {
    setValues(s => ({ ...s, [name]: v }))
  }

  async function handleDispatch() {
    if (!selectedPath) {
      setError(t('composer.errors.pickSkill'))
      return
    }

    // Build inputs map: only include fields the user actually set, plus
    // required fields with their seeded defaults.
    const payload: Record<string, string> = {}
    for (const inp of effectiveInputs) {
      const v = values[inp.name]
      if (v == null || v === '') {
        if (inp.required) {
          setError(t('composer.errors.requiredEmpty', { name: inp.name }))
          return
        }
        continue
      }
      payload[inp.name] = v
    }

    if (Object.keys(payload).length > MAX_INPUT_KEYS) {
      setError(t('composer.errors.tooManyInputs', { count: Object.keys(payload).length, max: MAX_INPUT_KEYS }))
      return
    }

    setDispatch(true)
    setError(null)
    try {
      await window.tachi.aeon.trigger(owner, selectedPath, undefined, payload)
      showToast({ kind: 'success', text: t('composer.toast.dispatched') })
      // Reset only the free-text values; keep defaults like model choice.
      const reset: Record<string, string> = {}
      for (const inp of effectiveInputs) {
        if (inp.default != null) reset[inp.name] = inp.default
        else if (inp.type === 'boolean') reset[inp.name] = 'false'
      }
      setValues(reset)
      onDispatched?.()
    } catch (err: unknown) {
      const msg = String((err as Error)?.message ?? err)
      setError(msg)
      showToast({ kind: 'error', text: t('composer.toast.dispatchFailed', { error: msg }) })
    } finally {
      setDispatch(false)
    }
  }

  const activeWorkflows = workflows.filter(w => w.state === 'active')

  // Build the effective input list, applying Bankr-only model gating.
  // For any `choice` input named `model`, we:
  //   - append the 5 Bankr-only model IDs when gateway === 'bankr'
  //   - strip them out otherwise (in case the workflow YAML already lists them)
  const effectiveInputs: AeonWorkflowInputSpec[] = inputs.map(inp => {
    if (inp.name !== 'model' || inp.type !== 'choice' || !inp.options) return inp
    const baseOptions = inp.options.filter(
      o => !(BANKR_ONLY_MODELS as readonly string[]).includes(o),
    )
    const modelOptions =
      gateway === 'bankr'
        ? [...baseOptions, ...BANKR_ONLY_MODELS]
        : baseOptions
    return { ...inp, options: modelOptions }
  })

  const visibleInputs = effectiveInputs.filter(i => showAdvanced || !HIDDEN_INPUTS.has(i.name))
  const hasHidden = effectiveInputs.some(i => HIDDEN_INPUTS.has(i.name))

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <span>{t('composer.header')}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={loadWorkflows}
          style={ghostBtnStyle}
          title={t('composer.reloadTitle')}
          disabled={loadingWf}
        >
          ⟳ {loadingWf ? '…' : t('composer.reload')}
        </button>
      </div>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Workflow picker */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={fieldLabelStyle}>{t('composer.workflowLabel')}</label>
          {workflows.length === 0 && !loadingWf ? (
            <div style={{
              padding: '6px 8px',
              border: 'var(--border-width) solid var(--border)',
              background: 'var(--bg-inset)',
              fontSize: 11,
              color: 'var(--text-dim)',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              {t('composer.noWorkflows')}
            </div>
          ) : (
            <select
              value={selectedPath}
              onChange={e => setSelected(e.target.value)}
              style={selectStyle}
              disabled={loadingWf || workflows.length === 0}
            >
              {loadingWf && <option>{t('composer.loadingOption')}</option>}
              {!loadingWf && activeWorkflows.map(w => (
                <option key={w.id} value={w.path}>{w.name} · {w.path}</option>
              ))}
              {!loadingWf && workflows.filter(w => w.state !== 'active').map(w => (
                <option key={w.id} value={w.path} disabled>
                  {t('composer.disabledOption', { name: w.name })}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Dynamic input fields */}
        {selectedPath && (
          <>
            {loadingInputs && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                {t('composer.loadingInputs')}
              </div>
            )}
            {!loadingInputs && inputs.length === 0 && (
              <div style={{
                padding: '6px 8px',
                border: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-inset)',
                fontSize: 11,
                color: 'var(--text-dim)',
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                {t('composer.noInputs.before')} <code style={{ fontFamily: 'inherit' }}>workflow_dispatch</code> {t('composer.noInputs.after')}
              </div>
            )}
            {!loadingInputs && visibleInputs.map(inp => (
              <DynamicInputField
                key={inp.name}
                spec={inp}
                value={values[inp.name] ?? ''}
                onChange={v => setValue(inp.name, v)}
                skillDirs={skillDirs}
              />
            ))}
            {!loadingInputs && hasHidden && (
              <button
                onClick={() => setShowAdv(s => !s)}
                style={{
                  ...ghostBtnStyle,
                  alignSelf: 'flex-start',
                  textTransform: 'none',
                  letterSpacing: 0,
                  color: 'var(--text-dim)',
                  background: 'transparent',
                  border: 'none',
                  padding: '2px 0',
                  cursor: 'pointer',
                  fontSize: 10,
                }}
              >
                {showAdvanced ? t('composer.hideAdvanced') : t('composer.showAdvanced')}
              </button>
            )}
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }} />
          <button
            onClick={handleDispatch}
            disabled={dispatching || !selectedPath || loadingInputs}
            style={{
              padding: '8px 16px',
              border: 'var(--border-width) solid var(--accent)',
              background: 'var(--accent)',
              color: '#ffffff',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              cursor: dispatching || !selectedPath ? 'not-allowed' : 'pointer',
              boxShadow: 'var(--shadow-hard)',
              textTransform: 'uppercase',
              opacity: dispatching || !selectedPath || loadingInputs ? 0.6 : 1,
            }}
          >
            {dispatching ? t('composer.dispatching') : t('composer.dispatch')}
          </button>
        </div>

        {error && (
          <div style={{
            padding: '6px 8px',
            border: 'var(--border-width) solid var(--danger, var(--border))',
            background: 'var(--bg-inset)',
            color: 'var(--danger, #d43f00)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Dynamic field renderer ────────────────────────────────────────────────────
interface DynamicInputFieldProps {
  spec:      AeonWorkflowInputSpec
  value:     string
  onChange:  (v: string) => void
  skillDirs: string[]
}

function DynamicInputField({ spec, value, onChange, skillDirs }: DynamicInputFieldProps) {
  const { t } = useTranslation('aeon')
  const isSkillInput = spec.name === 'skill' && skillDirs.length > 0
  const baseLabel = (
    <label style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span>{spec.name}</span>
      {spec.required && <span style={{ color: 'var(--danger, #d43f00)' }}>*</span>}
      <span style={{
        color: 'var(--text-dim)',
        textTransform: 'none',
        letterSpacing: 0,
        fontSize: 9,
        fontWeight: 400,
      }}>
        {spec.type}
      </span>
    </label>
  )
  const description = spec.description && (
    <p style={{
      margin: 0,
      fontSize: 10,
      color: 'var(--text-dim)',
      fontFamily: 'JetBrains Mono, monospace',
      lineHeight: 1.4,
    }}>
      {spec.description}
    </p>
  )

  // CHOICE input → <select> with declared options
  if (spec.type === 'choice' && spec.options && spec.options.length > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {baseLabel}
        {description}
        <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}>
          {spec.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      </div>
    )
  }

  // BOOLEAN input → checkbox toggle
  if (spec.type === 'boolean') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {baseLabel}
        {description}
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: 'var(--text-primary)',
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={e => onChange(e.target.checked ? 'true' : 'false')}
          />
          <span>{value === 'true' ? 'true' : 'false'}</span>
        </label>
      </div>
    )
  }

  // NUMBER input → numeric text
  if (spec.type === 'number') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {baseLabel}
        {description}
        <input
          type="number"
          value={value}
          onChange={e => onChange(e.target.value)}
          style={baseInputStyle}
        />
      </div>
    )
  }

  // STRING `skill` field with discovered skills/ dirs → combobox via datalist
  if (isSkillInput) {
    const listId = `skill-dirs-${spec.name}`
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {baseLabel}
        {description ?? (
          <p style={{
            margin: 0, fontSize: 10, color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.4,
          }}>
            {t('composer.skillField.before')} <code style={{ fontFamily: 'inherit' }}>skills/</code> {t('composer.skillField.after', { count: skillDirs.length })}
          </p>
        )}
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          list={listId}
          placeholder={skillDirs[0] ? t('composer.skillField.examplePlaceholder', { name: skillDirs[0] }) : t('composer.skillField.defaultPlaceholder')}
          style={baseInputStyle}
        />
        <datalist id={listId}>
          {skillDirs.map(d => <option key={d} value={d} />)}
        </datalist>
      </div>
    )
  }

  // Default: STRING input. Use a textarea if it looks like a long-form
  // description (the `var` convention).
  const isLongForm = spec.name === 'var' || spec.description?.toLowerCase().includes('description')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {baseLabel}
      {description}
      {isLongForm ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={3}
          placeholder={spec.default ?? ''}
          style={{ ...baseInputStyle, width: '100%', resize: 'vertical', lineHeight: 1.5 }}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={spec.default ?? ''}
          style={baseInputStyle}
        />
      )}
    </div>
  )
}
