// apps/desktop/src/pages/nodes/NodeConfigPanel.tsx
//
// Slide-in config panel (right side, over the canvas). Shows the editable
// fields for whichever node is currently selected on the canvas. Selection is
// read from the nodes.store (ReactFlow writes `node.selected` through
// applyNodeChanges); edits go back via updateNodeData. ESC closes (deselects),
// and clicking the canvas pane clears selection too (ReactFlow default).
//
// Brutalist: 2px left border, --bg-surface, JetBrains Mono. The slide is
// transform/opacity driven and guarded by prefers-reduced-motion (the
// .tachi-config-panel keyframes live in globals.css — see wiring[]).

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useNodesStore } from './store/nodes.store'
import { GRAPH_PROVIDER_IDS } from './providerCompat'
import { useProviderModels, modelOptionLabel, type ProviderModelOption } from './useProviderModels'
import { useMediaModels, mediaProvidersFor, normalizeMediaProvider } from './useMediaModels'
import { formatCostChip, asRunCostBasis } from './run-cost'
import { isRunnableType } from './run-eligibility'
import { clampRetries, clampDelay, MAX_RETRIES, DEFAULT_RETRY_DELAY_MS } from './retryPolicy'
import type { MediaNodeModality } from './types'
import type { TachiNode } from './types'

// ── Shared field styles (mirror the brutalist toolbar / RunFlowPanel) ─────────

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  width: 360,
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '2px solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  borderBottom: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  flexShrink: 0,
}

const headerTitleStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
}

const closeBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-dim)',
  marginBottom: 4,
  marginTop: 12,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  outline: 'none',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
}

const checkRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 14,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-primary)',
  cursor: 'pointer',
}

// Option catalogs reused from the palette / node components so the panel's
// dropdowns stay in sync with what the canvas actually supports.
// Provider dropdown options — from the shared registry (graph-capable subset),
// canonical ids. SelectField keeps any unknown current value (old short ids).
const PROVIDER_IDS = GRAPH_PROVIDER_IDS
const HARNESS_IDS  = ['openclaude', 'codex'] as const
const PERMISSION_TIERS = ['read-only', 'edit', 'full', 'web-search'] as const
const MEDIA_MODALITIES = ['image', 'video', 'music', 'tts', 'stt'] as const

// ── Small typed field helpers ─────────────────────────────────────────────────

function TextField(props: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{props.label}</label>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        style={inputStyle}
      />
    </div>
  )
}

function TextAreaField(props: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{props.label}</label>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        rows={props.rows ?? 4}
        style={textareaStyle}
      />
    </div>
  )
}

function SelectField(props: {
  label: string
  value: string
  options: readonly string[]
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{props.label}</label>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={selectStyle}
      >
        {/* If the current value isn't in the catalog (old save / custom), keep it. */}
        {!props.options.includes(props.value) && props.value !== '' && (
          <option value={props.value}>{props.value}</option>
        )}
        {props.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  )
}

/** Model picker — a real dropdown of the provider's available models (live +
 *  static fallback), with capability tags. Falls back to a free-text input only
 *  when the provider exposes no catalog. Keeps a custom/old value selectable. */
function ModelField(props: {
  value: string
  models: ProviderModelOption[]
  onChange: (v: string) => void
}) {
  const { t } = useTranslation('nodes')
  if (props.models.length === 0) {
    return <TextField label={t('config.fields.model')} value={props.value} onChange={props.onChange} placeholder={t('config.placeholders.modelId')} />
  }
  const has = props.models.some(m => m.id === props.value)
  return (
    <div>
      <label style={fieldLabelStyle}>{t('config.fields.model')}</label>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} style={selectStyle}>
        {!has && props.value !== '' && <option value={props.value}>{props.value}</option>}
        {props.models.map(m => (
          <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>
        ))}
      </select>
    </div>
  )
}

function CheckboxField(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label style={checkRowStyle}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        style={{ width: 14, height: 14, accentColor: 'var(--accent)', cursor: 'pointer' }}
      />
      {props.label}
    </label>
  )
}

// ── Type-specific field blocks ────────────────────────────────────────────────

function NodeFields({ node }: { node: TachiNode }) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore((s) => s.updateNodeData)
  const id = node.id
  const data = node.data as Record<string, unknown>
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '')
  const set = (partial: Record<string, unknown>) => updateNodeData(id, partial)

  // Available models for THIS node's provider (live + static fallback). Drives a
  // real dropdown for provider/prompt nodes — no hand-typing. Hook is called
  // unconditionally (empty for node types without a providerId).
  const { models: providerModels } = useProviderModels(str('providerId'))

  // Same for MEDIA nodes: (provider, modality) → catalog dropdown. Called
  // unconditionally (rules of hooks); provider=null disables loading for
  // non-media node types.
  const mediaModality = (str('modality') || 'image') as MediaNodeModality
  const mediaProvider = normalizeMediaProvider(data.provider, mediaModality)
  const { models: mediaModels } = useMediaModels(node.type === 'media' ? mediaProvider : null, mediaModality)

  // Label is shared by every node type.
  const labelField = (
    <TextField
      label={t('config.fields.label')}
      value={str('label')}
      onChange={(v) => set({ label: v })}
      placeholder={t('config.placeholders.nodeLabel')}
    />
  )

  switch (node.type) {
    case 'provider':
      return (
        <>
          {labelField}
          <SelectField label={t('config.fields.provider')} value={str('providerId')} options={PROVIDER_IDS} onChange={(v) => set({ providerId: v })} />
          <TextField label={t('config.fields.endpoint')} value={str('endpoint')} onChange={(v) => set({ endpoint: v })} placeholder="host/v1" />
          <ModelField value={str('model')} models={providerModels} onChange={(v) => set({ model: v })} />
        </>
      )

    case 'agent': {
      const isCodex = str('harnessId') === 'codex'
      return (
        <>
          {labelField}
          <SelectField label={t('config.fields.harness')} value={str('harnessId')} options={HARNESS_IDS} onChange={(v) => set({ harnessId: v })} />
          <TextAreaField
            label={t('config.fields.systemPrompt')}
            value={str('systemPrompt')}
            onChange={(v) => set({ systemPrompt: v })}
            placeholder={t('config.placeholders.systemPrompt')}
            rows={6}
          />
          <CheckboxField
            label={t('config.fields.final')}
            checked={data.final === true}
            onChange={(v) => set({ final: v })}
          />
          {/* CODEX WRITE-MODE — danger-styled opt-in (default OFF). Enables the
              codex `workspace-write` sandbox, scoped to the wired Folder only.
              Only meaningful for the Codex harness. */}
          {isCodex && (
            <>
              <label style={{ ...checkRowStyle, color: 'var(--danger)', fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={data.codexAllowWrite === true}
                  onChange={(e) => set({ codexAllowWrite: e.target.checked })}
                  style={{ width: 14, height: 14, accentColor: 'var(--danger)', cursor: 'pointer' }}
                />
                {t('config.fields.codexAllowWrite', { defaultValue: 'Allow write (workspace-write sandbox)' })}
              </label>
              <p style={{ ...hintStyle, color: 'var(--danger)' }}>
                {t('config.hints.codexAllowWrite', { defaultValue: 'Codex may create, modify, or delete files inside the wired folder only. Off = read-only analysis.' })}
              </p>
              <p style={hintStyle}>
                {t('config.hints.codexWriteNeedsFolder', { defaultValue: 'Wire a Folder node to enable write mode — it targets that folder, never the whole app storage.' })}
              </p>
            </>
          )}
          <p style={hintStyle}>{t('config.hints.modelFromProvider')}</p>
        </>
      )
    }

    case 'prompt':
      return (
        <>
          {labelField}
          <SelectField label={t('config.fields.provider')} value={str('providerId')} options={PROVIDER_IDS} onChange={(v) => set({ providerId: v })} />
          <TextField label={t('config.fields.endpoint')} value={str('endpoint')} onChange={(v) => set({ endpoint: v })} placeholder="host/v1" />
          <ModelField value={str('model')} models={providerModels} onChange={(v) => set({ model: v })} />
          <TextAreaField
            label={t('config.fields.instruction')}
            value={str('instruction')}
            onChange={(v) => set({ instruction: v })}
            placeholder={t('config.placeholders.instruction')}
            rows={5}
          />
          <CheckboxField
            label={t('config.fields.final')}
            checked={data.final === true}
            onChange={(v) => set({ final: v })}
          />
        </>
      )

    case 'skill':
      // SkillNode renders permission tiers; role saves carry roleId instead.
      return (
        <>
          {labelField}
          {typeof data.roleId === 'string' ? (
            <>
              <TextField label={t('config.fields.roleId')} value={str('roleId')} onChange={(v) => set({ roleId: v })} />
              <TextAreaField label={t('config.fields.description')} value={str('description')} onChange={(v) => set({ description: v })} rows={3} />
            </>
          ) : (
            <>
              <SelectField label={t('config.fields.permissionTier')} value={str('skillId') || 'read-only'} options={PERMISSION_TIERS} onChange={(v) => set({ skillId: v })} />
              <TextAreaField label={t('config.fields.description')} value={str('description')} onChange={(v) => set({ description: v })} rows={3} />
            </>
          )}
        </>
      )

    case 'folder':
      return (
        <>
          {labelField}
          <TextField label={t('config.fields.workspacePath')} value={str('path')} onChange={(v) => set({ path: v })} placeholder="C:\\path\\to\\folder" />
        </>
      )

    case 'internet':
      return (
        <>
          {labelField}
          <p style={hintStyle}>{t('config.hints.internet')}</p>
        </>
      )

    case 'mcp':
      return (
        <>
          {labelField}
          <TextField label={t('config.fields.serverUrl')} value={str('url')} onChange={(v) => set({ url: v })} placeholder={t('config.placeholders.serverUrl')} />
        </>
      )

    case 'media': {
      const params = (data.params && typeof data.params === 'object' ? data.params : {}) as Record<string, unknown>
      const pstr = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '')
      const setParam = (k: string, v: string) => set({ params: { ...params, [k]: v } })
      const modality = str('modality') || 'image'
      return (
        <>
          {labelField}
          <SelectField label={t('config.fields.modality')} value={modality} options={MEDIA_MODALITIES} onChange={(v) => set({ modality: v, model: undefined })} />
          <SelectField label={t('config.fields.provider')} value={mediaProvider} options={mediaProvidersFor(mediaModality)} onChange={(v) => set({ provider: v, model: undefined })} />
          <ModelField
            value={str('model')}
            models={mediaModels.map(m => ({ id: m.id, label: m.label || m.id }))}
            onChange={(v) => set({ model: v })}
          />
          <TextAreaField
            label={t('config.fields.promptTemplate')}
            value={str('prompt')}
            onChange={(v) => set({ prompt: v })}
            // Literal {{node:<id>}} token syntax collides with i18next's {{ }}
            // interpolation delimiters, so this placeholder stays un-wrapped.
            placeholder="Used when no prompt plug is wired. May embed {{node:<id>}} tokens."
            rows={4}
          />
          {modality === 'image' && (
            <>
              <TextField label={t('config.fields.size')} value={pstr('size')} onChange={(v) => setParam('size', v)} placeholder="1024x1024" />
              <TextField label={t('config.fields.count')} value={pstr('n')} onChange={(v) => setParam('n', v)} placeholder="1" />
            </>
          )}
          {modality === 'tts' && (
            <>
              <TextField label={t('config.fields.voice')} value={pstr('voice')} onChange={(v) => setParam('voice', v)} />
              <TextField label={t('config.fields.format')} value={pstr('format')} onChange={(v) => setParam('format', v)} placeholder="mp3" />
            </>
          )}
          {(modality === 'video' || modality === 'music') && (
            <>
              <TextField label={t('config.fields.duration')} value={pstr('duration')} onChange={(v) => setParam('duration', v)} />
              <TextField label={t('config.fields.resolution')} value={pstr('resolution')} onChange={(v) => setParam('resolution', v)} />
            </>
          )}
          {modality === 'stt' && (
            <TextField label={t('config.fields.audioPath')} value={pstr('audioPath')} onChange={(v) => setParam('audioPath', v)} placeholder="C:\\path\\to\\audio.mp3" />
          )}
          <TextField label={t('config.fields.autoSaveDir')} value={str('autoSaveDir')} onChange={(v) => set({ autoSaveDir: v })} placeholder={t('config.placeholders.autoSaveDir')} />
        </>
      )
    }

    default:
      return labelField
  }
}

const hintStyle: React.CSSProperties = {
  marginTop: 12,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  color: 'var(--text-dim)',
  lineHeight: 1.5,
}

// ── RETRY-ON-FAIL fields (runnable nodes only) ────────────────────────────────
//
// A RETRIES stepper (0-3) + a delay input, appended to the PARAMS block for
// agent / prompt / media nodes. Writes data.retries / data.retryDelayMs, which
// the run seams read via retryPolicy(). The delay row only shows once retries > 0.

const stepBtnStyle: React.CSSProperties = {
  width: 30,
  padding: '4px 0',
  border: 'none',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 15,
  fontWeight: 800,
  lineHeight: 1,
  cursor: 'pointer',
}

const stepValueStyle: React.CSSProperties = {
  minWidth: 36,
  padding: '4px 0',
  textAlign: 'center',
  alignSelf: 'stretch',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--text-primary)',
  borderLeft: '2px solid var(--border)',
  borderRight: '2px solid var(--border)',
}

function RetryFields({ node }: { node: TachiNode }) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore((s) => s.updateNodeData)
  const data = node.data as { retries?: unknown; retryDelayMs?: unknown }
  const retries = clampRetries(data.retries)
  const delayRaw = typeof data.retryDelayMs === 'number' ? data.retryDelayMs : undefined
  const setRetries = (v: number) => updateNodeData(node.id, { retries: clampRetries(v) })

  return (
    <>
      <label style={fieldLabelStyle}>{t('config.fields.retries', { defaultValue: 'Retries on fail' })}</label>
      <div style={{ display: 'flex', alignItems: 'stretch', width: 'fit-content', border: '2px solid var(--border)' }}>
        <button
          type="button"
          onClick={() => setRetries(retries - 1)}
          disabled={retries <= 0}
          title={t('config.retries.decrease', { defaultValue: 'Fewer retries' })}
          aria-label={t('config.retries.decrease', { defaultValue: 'Fewer retries' })}
          style={{ ...stepBtnStyle, opacity: retries <= 0 ? 0.4 : 1, cursor: retries <= 0 ? 'not-allowed' : 'pointer' }}
        >−</button>
        <span style={stepValueStyle} aria-live="polite">{retries}</span>
        <button
          type="button"
          onClick={() => setRetries(retries + 1)}
          disabled={retries >= MAX_RETRIES}
          title={t('config.retries.increase', { defaultValue: 'More retries' })}
          aria-label={t('config.retries.increase', { defaultValue: 'More retries' })}
          style={{ ...stepBtnStyle, opacity: retries >= MAX_RETRIES ? 0.4 : 1, cursor: retries >= MAX_RETRIES ? 'not-allowed' : 'pointer' }}
        >+</button>
      </div>
      <p style={hintStyle}>
        {t('config.hints.retries', { defaultValue: 'Re-run this node up to 3 times if it fails. 0 = off. Only the final failure records the error or feeds an error branch.' })}
      </p>
      {retries > 0 && (
        <>
          <label style={fieldLabelStyle}>{t('config.fields.retryDelay', { defaultValue: 'Retry delay (ms)' })}</label>
          <input
            type="number"
            min={0}
            step={100}
            value={delayRaw != null ? String(delayRaw) : ''}
            placeholder={String(DEFAULT_RETRY_DELAY_MS)}
            onChange={(e) => {
              const raw = e.target.value.trim()
              if (raw === '') { updateNodeData(node.id, { retryDelayMs: undefined }); return }
              const n = Number(raw)
              updateNodeData(node.id, { retryDelayMs: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined })
            }}
            onBlur={(e) => {
              const raw = e.target.value.trim()
              if (raw !== '') updateNodeData(node.id, { retryDelayMs: clampDelay(raw) })
            }}
            style={inputStyle}
          />
          <p style={hintStyle}>
            {t('config.hints.retryDelay', { defaultValue: 'Wait this long between attempts.' })}
          </p>
        </>
      )}
    </>
  )
}

// ── Triptych sections: INPUT | PARAMS | OUTPUT (NODES-RESEARCH #10) ────────────
//
// Read-only surfaces that bracket the existing params, so a node's config panel
// reads like an n8n-style triptych: what flows IN (wired upstream outputs), the
// PARAMS (unchanged), and what came OUT (this node's last run). Pure display —
// none of this mutates node data.

/** How many chars of a preview to show before the "show more" toggle appears. */
const PREVIEW_COLLAPSED_CHARS = 200

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 18,
  marginBottom: 6,
  paddingBottom: 5,
  borderBottom: '2px solid var(--border-strong)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
}

const sectionCountStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.06em',
  padding: '0 5px',
  border: '1px solid var(--border)',
  color: 'var(--text-dim)',
}

const previewPreStyle: React.CSSProperties = {
  margin: '4px 0 0',
  padding: 6,
  border: '2px solid var(--border)',
  background: 'var(--bg-inset)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  lineHeight: 1.45,
  color: 'var(--text-primary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflow: 'auto',
}

const moreBtnStyle: React.CSSProperties = {
  marginTop: 4,
  padding: '2px 6px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

const ioLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--text-primary)',
}

const typeBadgeStyle: React.CSSProperties = {
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '1px 5px',
  border: '1px solid var(--border)',
  color: 'var(--text-dim)',
}

const emptyIoStyle: React.CSSProperties = {
  marginTop: 6,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  color: 'var(--text-dim)',
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div style={sectionHeaderStyle}>
      <span>{label}</span>
      {count != null && count > 0 && <span style={sectionCountStyle}>{count}</span>}
    </div>
  )
}

/** A monospace preview of some text, collapsed to ~200 chars with an expand toggle. */
function CollapsiblePreview({ text }: { text: string }) {
  const { t } = useTranslation('nodes')
  const [expanded, setExpanded] = useState(false)
  const long = text.length > PREVIEW_COLLAPSED_CHARS
  const shown = expanded || !long ? text : `${text.slice(0, PREVIEW_COLLAPSED_CHARS)}…`
  return (
    <div>
      <pre style={previewPreStyle}>{shown}</pre>
      {long && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={moreBtnStyle}
        >
          {expanded
            ? t('config.io.showLess', { defaultValue: 'Show less' })
            : t('config.io.showMore', { defaultValue: 'Show more' })}
        </button>
      )}
    </div>
  )
}

/** One wired-upstream input: label + type badge + its last-output preview. */
interface InputRef { id: string; label: string; type: string; lastOutput: string }

function InputRow({ input: r }: { input: InputRef }) {
  const { t } = useTranslation('nodes')
  return (
    <div style={{ marginTop: 10 }}>
      <div style={ioLabelStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
        <span style={typeBadgeStyle}>{r.type}</span>
      </div>
      {r.lastOutput
        ? <CollapsiblePreview text={r.lastOutput} />
        : <div style={emptyIoStyle}>{t('config.io.inputEmpty', { defaultValue: '— no output yet' })}</div>}
    </div>
  )
}

/** INPUT section — the nodes wired INTO this node (direct predecessors), each
 *  with a collapsed preview of its cached lastOutput. Reactive to the store but
 *  cheap: the derived list only changes when a wired node's label/type/output
 *  changes (position-drag ticks are ignored by the equality fn). */
function InputSection({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation('nodes')
  const inputs = useStoreWithEqualityFn(
    useNodesStore,
    (s): InputRef[] => {
      const srcIds = new Set<string>()
      for (const e of s.edges) if (e.target === nodeId && e.source) srcIds.add(e.source)
      const out: InputRef[] = []
      for (const n of s.nodes) {
        if (!srcIds.has(n.id)) continue
        const d = (n.data ?? {}) as { label?: unknown; lastOutput?: unknown }
        // Every TachiNode carries a non-empty string `type`; fall back to it
        // when the node has no human label.
        const label = (typeof d.label === 'string' && d.label.trim()) || n.type
        out.push({
          id: n.id,
          label,
          type: n.type,
          lastOutput: typeof d.lastOutput === 'string' ? d.lastOutput : '',
        })
      }
      out.sort((a, b) => (a.label === b.label ? (a.id < b.id ? -1 : 1) : a.label < b.label ? -1 : 1))
      return out
    },
    (a, b) =>
      a.length === b.length &&
      a.every((x, i) => x.id === b[i].id && x.label === b[i].label && x.type === b[i].type && x.lastOutput === b[i].lastOutput),
  )

  return (
    <>
      <SectionHeader label={t('config.sections.input', { defaultValue: 'Input' })} count={inputs.length} />
      {inputs.length === 0
        ? <div style={emptyIoStyle}>{t('config.io.noInputs', { defaultValue: 'No inputs wired' })}</div>
        : inputs.map((r) => <InputRow key={r.id} input={r} />)}
    </>
  )
}

/** OUTPUT section — this node's last run: cost chip + status, then the cached
 *  output text (or the error from the last failed run). Reads the passed node
 *  (the panel re-selects on data changes), so it refreshes after a run. */
function OutputSection({ node }: { node: TachiNode }) {
  const { t } = useTranslation('nodes')
  const data = node.data as { lastOutput?: unknown; lastError?: unknown; lastCostUsd?: unknown; lastCostBasis?: unknown }
  const lastOutput = typeof data.lastOutput === 'string' ? data.lastOutput : ''
  const lastError = typeof data.lastError === 'string' ? data.lastError : ''
  const costChip = formatCostChip(
    typeof data.lastCostUsd === 'number' ? data.lastCostUsd : null,
    asRunCostBasis(data.lastCostBasis),
    (k, fallback) => t(k, { defaultValue: fallback }),
  )

  const status: 'error' | 'ok' | 'idle' = lastError ? 'error' : lastOutput ? 'ok' : 'idle'
  const statusMeta = {
    error: { label: t('config.io.statusError', { defaultValue: 'Failed' }), color: 'var(--danger)' },
    ok:    { label: t('config.io.statusOk',    { defaultValue: 'OK' }),     color: 'var(--accent)' },
    idle:  { label: t('config.io.statusIdle',  { defaultValue: 'Not run' }), color: 'var(--text-dim)' },
  }[status]

  return (
    <>
      <SectionHeader label={t('config.sections.output', { defaultValue: 'Output' })} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <span style={{ ...typeBadgeStyle, color: statusMeta.color, borderColor: statusMeta.color }}>{statusMeta.label}</span>
        {costChip && (
          <span
            title={t('config.io.costTitle', { defaultValue: 'Estimated cost of this node’s last run (chars/4 token math on the wired model’s rates)' })}
            style={typeBadgeStyle}
          >{costChip}</span>
        )}
      </div>
      {lastError ? (
        <div style={{ marginTop: 8 }}>
          <label style={fieldLabelStyle}>{t('config.io.errorLabel', { defaultValue: 'Error' })}</label>
          <pre style={{ ...previewPreStyle, border: '2px solid var(--danger)', color: 'var(--danger)' }}>{lastError}</pre>
        </div>
      ) : lastOutput ? (
        <CollapsiblePreview text={lastOutput} />
      ) : (
        <div style={emptyIoStyle}>{t('config.io.noOutput', { defaultValue: 'Not run yet' })}</div>
      )}
    </>
  )
}

// ── Panel ──────────────────────────────────────────────────────────────────────

export function NodeConfigPanel(props: { node: TachiNode; onClose: () => void }) {
  const { t } = useTranslation('nodes')
  const { node, onClose } = props
  const deleteNode     = useNodesStore((s) => s.deleteNode)
  const duplicateNodes = useNodesStore((s) => s.duplicateNodes)

  // ESC closes the panel (clears selection upstream via onClose).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      style={panelStyle}
      className="tachi-config-panel"
      role="dialog"
      aria-label={t('config.aria')}
      // Stop canvas pan/zoom + delete-key handlers from firing while typing.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div style={headerStyle}>
        <span style={headerTitleStyle}>{t('config.header', { type: node.type })}</span>
        <button onClick={onClose} title={t('config.closeEsc')} style={closeBtnStyle}>{t('config.close')}</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px 16px' }}>
        {/* NODES-RESEARCH #10 — Input | Params | Output triptych. INPUT and
            OUTPUT are read-only surfaces bracketing the unchanged PARAMS block. */}
        <InputSection nodeId={node.id} />
        <SectionHeader label={t('config.sections.params', { defaultValue: 'Params' })} />
        {/* key on node.id so the field block remounts when selection changes */}
        <NodeFields key={node.id} node={node} />
        {/* RETRY-ON-FAIL — runnable nodes (agent/prompt/media) only. */}
        {isRunnableType(node.type) && <RetryFields key={`retry-${node.id}`} node={node} />}
        <OutputSection node={node} />
      </div>

      <div style={{ padding: 12, borderTop: '2px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => duplicateNodes([node.id])}
          title={t('config.duplicateTitle')}
          style={{
            ...closeBtnStyle,
            width: '100%',
            border: '2px solid var(--accent)',
            color: 'var(--accent)',
            background: 'var(--bg-elevated)',
          }}
        >
          {t('config.duplicateNode')}
        </button>
        <button
          onClick={() => { deleteNode(node.id); onClose() }}
          title={t('config.deleteTitle')}
          style={{
            ...closeBtnStyle,
            width: '100%',
            border: '2px solid var(--danger)',
            color: 'var(--danger)',
            background: 'var(--bg-elevated)',
          }}
        >
          {t('config.deleteNode')}
        </button>
      </div>
    </div>
  )
}
