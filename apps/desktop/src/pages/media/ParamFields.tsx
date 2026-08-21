// apps/desktop/src/pages/media/ParamFields.tsx
//
// Generic SCHEMA-DRIVEN control renderer. Given a ParamSpec[] (from
// window.tachi.surplusMedia.modelParams) it renders one brutalist control per
// spec, keyed by `kind`, and reports edits up via onChange(name, value). Adding
// a param becomes a DATA change in the engine's curated schema — no UI code.
//
// Consumed by BOTH the Media studio tab and the canvas Media node. Pure +
// CONTROLLED: it holds no state of its own except the Advanced-section
// expand/collapse toggle; the parent owns `values` and applies every onChange.
// NO IPC here.
//
// kind → control:
//   string  → single-line <input type=text>
//   text    → <textarea> (multiline)
//   int     → range slider (step 1) WITH a numeric readout
//   number  → range slider (min/max/step) WITH a numeric readout
//   enum    → <select> from spec.enum
//   boolean → brutalist on/off toggle button
//   image   → image file picker → stores a data: URL in values[name]
//   audio   → audio file picker → stores the file name (path is filled by the
//             caller / engine; a data URL would be too large for audio)
//
// `advanced: true` specs are grouped under a collapsible "Advanced" section.
// `required: true` specs get a marker. `description` renders as a small hint.
import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParamSpec } from '../../types/electron'
import {
  retargetT2vOnlyHint, WAN_I2V_ROW_NAME,
  retargetPromptPlugHint, resolveParamLabel, resolveParamDescription,
} from './mediaHelpers'

// ── Shared brutalist styles (mirrors MediaPage's labelStyle / inputStyle) ──────
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4,
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12, outline: 'none',
}
const hintStyle: React.CSSProperties = {
  fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4, marginTop: 3,
}
const requiredStyle: React.CSSProperties = {
  color: 'var(--warning)', marginLeft: 4, fontWeight: 700,
}
const btnStyle: React.CSSProperties = {
  padding: '4px 10px', border: '2px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}

const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm'

interface ParamFieldsProps {
  schema:   ParamSpec[]
  values:   Record<string, unknown>
  onChange: (name: string, value: unknown) => void
}

export function ParamFields({ schema, values, onChange }: ParamFieldsProps) {
  const { t } = useTranslation('media')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // ── Two hints main cannot write for itself, then the general i18n pass ─────
  //
  // Schema descriptions arrive from main in English. That is fine for facts
  // ("this checkpoint renders 832x480") — but two of them are worded stale or
  // canvas-specific rather than merely untranslated, and are retargeted (not
  // just translated) before the generic per-name pass below runs:
  //  1. the text→video sentence appended to a non-i2v row's RESOLUTION hint
  //     still claims no i2v checkpoint is shipped — one HAS been since 0fab056.
  //  2. the image prompt's hint says "wire ... into the prompt plug", canvas
  //     wiring language that doesn't fit this same schema rendered on the
  //     plain Media composer (no plugs there).
  // Retargeting here (rather than in MediaPage) means the canvas media node —
  // the other surface that renders this exact schema — gets the corrected copy
  // too, which is precisely the split that caused audit D3.
  //
  // Then every label (by param name) and every description that never varies
  // by row (see resolveParamDescription's doc comment for the excluded,
  // row-specific set) is translated the same way: `t()` with the current
  // (possibly-retargeted) English text as the defaultValue, so a missing
  // resource key always falls back to exactly what main/the hooks produced.
  const localized = useMemo(
    () => schema.map(spec => {
      let description = retargetT2vOnlyHint(
        spec.description,
        t('params.videoI2vAvailable', { model: WAN_I2V_ROW_NAME }),
      )
      description = retargetPromptPlugHint(
        description,
        t('params.promptAutoFill', {
          defaultValue: 'This can be filled in automatically by connecting a text-generation step ahead of it.',
        }),
      )
      description = resolveParamDescription(spec.name, description, t)
      const label = resolveParamLabel(spec.name, spec.label, t)
      if (description === spec.description && label === spec.label) return spec
      return { ...spec, description, label }
    }),
    [schema, t],
  )

  const { basic, advanced } = useMemo(() => {
    const basic: ParamSpec[] = []
    const advanced: ParamSpec[] = []
    for (const spec of localized) (spec.advanced ? advanced : basic).push(spec)
    return { basic, advanced }
  }, [localized])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {basic.map(spec => (
        <Field key={spec.name} spec={spec} value={values[spec.name]} onChange={onChange} />
      ))}

      {advanced.length > 0 && (
        <div>
          <button
            type="button"
            className="nodrag"
            onClick={() => setShowAdvanced(v => !v)}
            style={{ ...btnStyle, width: '100%', textAlign: 'left' }}
          >
            {showAdvanced ? '▾' : '▸'} {t('params.advanced', { count: advanced.length })}
          </button>
          {showAdvanced && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 12,
              marginTop: 10, paddingLeft: 8, borderLeft: '2px solid var(--border)',
            }}>
              {advanced.map(spec => (
                <Field key={spec.name} spec={spec} value={values[spec.name]} onChange={onChange} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── One control, dispatched by kind ────────────────────────────────────────────

function Field({
  spec, value, onChange,
}: { spec: ParamSpec; value: unknown; onChange: (name: string, value: unknown) => void }) {
  const set = (v: unknown) => onChange(spec.name, v)

  return (
    <div>
      <Label spec={spec} />
      <Control spec={spec} value={value} set={set} />
      {spec.description && <div style={hintStyle}>{spec.description}</div>}
    </div>
  )
}

function Label({ spec }: { spec: ParamSpec }) {
  // boolean renders its own inline label inside the toggle row; skip the block label.
  if (spec.kind === 'boolean') return null
  return (
    <span style={labelStyle}>
      {spec.label}
      {spec.required && <span style={requiredStyle}>*</span>}
    </span>
  )
}

function Control({
  spec, value, set,
}: { spec: ParamSpec; value: unknown; set: (v: unknown) => void }) {
  switch (spec.kind) {
    case 'text':
      return (
        <textarea
          className="nodrag"
          value={asString(value, spec.default)}
          rows={4}
          onChange={e => set(e.target.value)}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      )

    case 'string':
      return (
        <input
          type="text"
          className="nodrag"
          value={asString(value, spec.default)}
          onChange={e => set(e.target.value)}
          style={inputStyle}
        />
      )

    case 'int':
    case 'number':
      return <SliderControl spec={spec} value={value} set={set} />

    case 'enum':
      return (
        <select
          className="nodrag"
          value={asString(value, spec.default)}
          onChange={e => set(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          {/* If the current value isn't in the enum, surface it so it isn't silently dropped. */}
          {!(spec.enum ?? []).includes(asString(value, spec.default)) && asString(value, spec.default) !== '' && (
            <option value={asString(value, spec.default)}>{asString(value, spec.default)}</option>
          )}
          {(spec.enum ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      )

    case 'boolean':
      return <ToggleControl spec={spec} value={value} set={set} />

    case 'image':
      return <ImageControl spec={spec} value={value} set={set} />

    case 'audio':
      return <AudioControl spec={spec} value={value} set={set} />

    default:
      return null
  }
}

// ── int / number → slider + numeric readout ────────────────────────────────────

function SliderControl({
  spec, value, set,
}: { spec: ParamSpec; value: unknown; set: (v: unknown) => void }) {
  const step = spec.step ?? (spec.kind === 'int' ? 1 : 0.01)
  const min  = spec.min ?? 0
  const max  = spec.max ?? (spec.kind === 'int' ? 100 : 1)
  const fallback = typeof spec.default === 'number' ? spec.default : min
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamp = (n: number) => Math.max(min, Math.min(max, n))
  const round = (n: number) => (spec.kind === 'int' ? Math.round(n) : n)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="range"
        className="nodrag"
        min={min} max={max} step={step}
        value={num}
        onChange={e => set(round(clamp(Number(e.target.value))))}
        style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }}
      />
      <input
        type="number"
        className="nodrag"
        min={min} max={max} step={step}
        value={num}
        onChange={e => {
          const raw = e.target.value
          if (raw === '') { set(fallback); return }
          const n = Number(raw)
          if (Number.isFinite(n)) set(round(clamp(n)))
        }}
        style={{ ...inputStyle, width: 72, padding: '4px 6px', textAlign: 'right' }}
      />
    </div>
  )
}

// ── boolean → brutalist toggle ──────────────────────────────────────────────────

function ToggleControl({
  spec, value, set,
}: { spec: ParamSpec; value: unknown; set: (v: unknown) => void }) {
  const { t } = useTranslation('media')
  const on = typeof value === 'boolean' ? value : Boolean(spec.default)
  return (
    <button
      type="button"
      className="nodrag"
      onClick={() => set(!on)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '5px 8px', cursor: 'pointer',
        border: `2px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
        background: on ? 'var(--accent-muted)' : 'var(--bg-inset)',
        color: on ? 'var(--accent-text)' : 'var(--text-muted)',
        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}
      aria-pressed={on}
    >
      <span style={{
        width: 12, height: 12, flexShrink: 0,
        border: `2px solid ${on ? 'var(--accent-text)' : 'var(--text-dim)'}`,
        background: on ? 'var(--accent-text)' : 'transparent',
      }} />
      {spec.label}
      {spec.required && <span style={requiredStyle}>*</span>}
      <span style={{ marginLeft: 'auto', fontSize: 10 }}>{on ? t('params.on') : t('params.off')}</span>
    </button>
  )
}

// ── image → file picker storing a data: URL ────────────────────────────────────

function ImageControl({
  spec, value, set,
}: { spec: ParamSpec; value: unknown; set: (v: unknown) => void }) {
  const { t } = useTranslation('media')
  const ref = useRef<HTMLInputElement>(null)
  const current = asString(value, spec.default)
  const isData = current.startsWith('data:')

  const pick = async (file: File | null) => {
    if (!file) { set(undefined); return }
    const dataUrl = await fileToDataUrl(file)
    set(dataUrl)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => { pick(e.target.files?.[0] ?? null); e.target.value = '' }}
      />
      {isData && (
        <img
          src={current}
          alt={t('params.image.referenceAlt')}
          style={{ width: '100%', maxHeight: 220, objectFit: 'contain', border: '2px solid var(--border)', background: 'var(--bg-base)', display: 'block' }}
        />
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="nodrag" onClick={() => ref.current?.click()} style={btnStyle}>
          {current ? t('params.image.change') : t('params.image.choose')}
        </button>
        {current && (
          <button type="button" className="nodrag" onClick={() => set(undefined)} style={{ ...btnStyle, color: 'var(--text-dim)' }}>
            {t('actions.clear')}
          </button>
        )}
      </div>
      {current && !isData && (
        <div style={{ ...hintStyle, wordBreak: 'break-all' }}>{current}</div>
      )}
    </div>
  )
}

// ── audio → file picker storing the file NAME (path filled by caller/engine) ───

function AudioControl({
  spec, value, set,
}: { spec: ParamSpec; value: unknown; set: (v: unknown) => void }) {
  const { t } = useTranslation('media')
  const ref = useRef<HTMLInputElement>(null)
  const current = asString(value, spec.default)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        ref={ref}
        type="file"
        accept={AUDIO_ACCEPT}
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; set(f ? f.name : undefined); e.target.value = '' }}
      />
      {/* Editable too — STT often needs an absolute disk path the picker can't yield. */}
      <input
        type="text"
        className="nodrag"
        value={current}
        placeholder={t('params.audio.placeholder')}
        onChange={e => set(e.target.value || undefined)}
        style={inputStyle}
      />
      <button type="button" className="nodrag" onClick={() => ref.current?.click()} style={btnStyle}>
        {current ? t('params.audio.change') : t('params.audio.choose')}
      </button>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Coerce a possibly-undefined controlled value to a string for inputs. */
function asString(value: unknown, fallback: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) {
    if (typeof fallback === 'string') return fallback
    if (typeof fallback === 'number' || typeof fallback === 'boolean') return String(fallback)
    return ''
  }
  return ''
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload  = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}
