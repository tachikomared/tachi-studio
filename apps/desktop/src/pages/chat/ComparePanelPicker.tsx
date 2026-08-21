// apps/desktop/src/pages/chat/ComparePanelPicker.tsx
//
// UX #6 — pick the exact models that answer in the Fusion / COMPARE panel,
// including LOCAL ones. Mounts next to the FUSION chips when Fusion is on.
// Three sections: the active gateway's cloud catalog, installed Ollama models
// and downloaded llama.cpp GGUFs (reusing the same data surfaces the dedicated
// pickers already use: window.tachi.{bankr|venice|surplus}.listModels,
// window.tachi.ollama.listModels, window.tachi.llamaCpp.status/catalog).
//
// Selection is stored as namespaced ids the main process routes on:
//   cloud catalog id     → gateway backend (unchanged)
//   ollama:<model>       → local Ollama daemon
//   llamacpp:<modelId>   → running llama-server (one model at a time — picking
//                          a non-running GGUF starts it, same call the
//                          LlamaCppModelPicker makes)
// Empty selection = AUTO (the provider preset picks the panel).
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { modelDisplayName } from '../../utils/model-display'

const MAX_PANEL = 6 // chat.ipc zod cap on fusionPanel

interface Props {
  providerId: string        // 'bankr-gateway' | 'venice' | 'surplus'
  value: string[]           // current custom panel ([] = AUTO preset)
  onChange: (models: string[]) => void
  disabled?: boolean
}

interface CloudModel { id: string; label: string }
interface LlamaModel { id: string; label: string; running: boolean }

const chipStyle = (active: boolean): React.CSSProperties => ({
  height: 26, padding: '0 8px', border: '2px solid var(--border)',
  background: active ? 'var(--accent-muted)' : 'var(--bg-inset)',
  color: active ? 'var(--accent-text)' : 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
})

const sectionHeadStyle: React.CSSProperties = {
  padding: '5px 10px', background: 'var(--bg-inset)',
  borderTop: '2px solid var(--border)', borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 9, fontWeight: 700, color: 'var(--text-dim)',
  textTransform: 'uppercase', letterSpacing: '0.12em',
}

const emptyRowStyle: React.CSSProperties = {
  padding: '6px 10px', fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4,
}

export function ComparePanelPicker({ providerId, value, onChange, disabled }: Props) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [cloudModels, setCloudModels]   = useState<CloudModel[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [llamaModels, setLlamaModels]   = useState<LlamaModel[]>([])
  const [loading, setLoading]           = useState(false)
  const [llamaBusy, setLlamaBusy]       = useState<string | null>(null)
  const [llamaError, setLlamaError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    // Every section fails soft — a dead engine just renders as its empty state.
    const cloudP: Promise<CloudModel[]> = (async () => {
      try {
        const r = providerId === 'venice'
          ? await window.tachi.venice.listModels({})
          : providerId === 'surplus'
            ? await window.tachi.surplus.listModels({})
            : await window.tachi.bankr.listModels({})
        return r.ok ? r.models.map(m => ({ id: m.id, label: m.label })) : []
      } catch { return [] }
    })()
    const ollamaP = window.tachi.ollama.listModels()
      .then(r => (r.ok ? r.models.map(m => m.name) : []))
      .catch(() => [] as string[])
    const llamaP = Promise.all([window.tachi.llamaCpp.status(), window.tachi.llamaCpp.catalog()])
      .then(([st, cat]) => {
        const labels = new Map((cat?.models ?? []).map(m => [m.id, m.label] as const))
        const runningId = (st.state === 'running' || st.state === 'loading') ? st.modelId : undefined
        return (st.downloadedModels ?? []).map(id => ({
          id, label: labels.get(id) ?? modelDisplayName(id), running: id === runningId,
        }))
      })
      .catch(() => [] as LlamaModel[])
    const [cloud, ollama, llama] = await Promise.all([cloudP, ollamaP, llamaP])
    setCloudModels(cloud)
    setOllamaModels(ollama)
    setLlamaModels(llama)
    setLoading(false)
  }, [providerId])

  useEffect(() => { if (open) void load() }, [open, load])

  const selected = new Set(value)
  const atCap = value.length >= MAX_PANEL

  const toggle = (id: string) => {
    if (selected.has(id)) onChange(value.filter(v => v !== id))
    else if (!atCap) onChange([...value, id])
  }

  // llama-server loads ONE model at a time → a llamacpp pick replaces any other
  // llamacpp member; picking a non-running GGUF loads it (same llamaCpp.start
  // call the dedicated picker makes) so the leg is actually answerable.
  const toggleLlama = async (m: LlamaModel) => {
    const id = `llamacpp:${m.id}`
    if (selected.has(id)) { onChange(value.filter(v => v !== id)); return }
    const withoutLlama = value.filter(v => !v.startsWith('llamacpp:'))
    if (withoutLlama.length >= MAX_PANEL) return
    setLlamaError(null)
    if (!m.running) {
      setLlamaBusy(m.id)
      try {
        const res = await window.tachi.llamaCpp.start({ modelId: m.id })
        if (res.ok === false) {
          setLlamaError(res.error ?? t('panelPicker.startFailedGeneric'))
          return
        }
      } catch (err) {
        setLlamaError(err instanceof Error ? err.message : String(err))
        return
      } finally {
        setLlamaBusy(null)
        void load()
      }
    }
    onChange([...withoutLlama, id])
  }

  const rowStyle = (isSelected: boolean, dim = false): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '6px 10px', border: 'none',
    borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
    background: isSelected ? 'var(--accent-muted)' : 'transparent',
    color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11, cursor: dim ? 'not-allowed' : 'pointer', opacity: dim ? 0.45 : 1,
  })

  const mark = (isSelected: boolean) => (
    <span style={{ width: 12, flexShrink: 0, color: isSelected ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 700 }}>
      {isSelected ? '■' : '□'}
    </span>
  )

  const localTag = (
    <span style={{
      padding: '0 4px', border: 'var(--border-width) solid var(--accent)',
      color: 'var(--accent)', fontSize: 8, fontWeight: 700, letterSpacing: 0.5,
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{t('panelPicker.localTag')}</span>
  )

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        data-testid="compare-panel-chip"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={value.length > 0
          ? t('panelPicker.chipCustomTitle', { models: value.join(', ') })
          : t('panelPicker.chipAutoTitle')}
        style={chipStyle(value.length > 0)}
      >{value.length > 0 ? t('panelPicker.chipCount', { count: value.length }) : t('panelPicker.chipAuto')}</button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 199, background: 'transparent' }} />
          <div
            data-testid="compare-panel-popover"
            style={{
              position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 200,
              width: 320, maxHeight: 380, overflowY: 'auto',
              border: '2px solid var(--border-strong)', background: 'var(--bg-surface)',
              boxShadow: '4px 4px 0 var(--border)', fontFamily: 'JetBrains Mono, monospace',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{
              padding: '6px 10px', borderBottom: '2px solid var(--border)',
              fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase',
              letterSpacing: '0.12em', background: 'var(--bg-inset)',
              display: 'flex', justifyContent: 'space-between', gap: 8,
            }}>
              <span>{t('panelPicker.title')}</span>
              <span>{value.length}/{MAX_PANEL}</span>
            </div>

            {/* AUTO (preset) reset row */}
            <button
              onClick={() => onChange([])}
              style={rowStyle(value.length === 0)}
            >
              {mark(value.length === 0)}
              <span style={{ fontWeight: 700 }}>{t('panelPicker.autoRow')}</span>
              <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('panelPicker.autoRowHint')}</span>
            </button>

            {/* CLOUD — active gateway catalog */}
            <div style={sectionHeadStyle}>{t('panelPicker.cloudSection', { provider: providerId })}</div>
            {loading && cloudModels.length === 0 && <div style={emptyRowStyle}>{t('panelPicker.loading')}</div>}
            {!loading && cloudModels.length === 0 && <div style={emptyRowStyle}>{t('panelPicker.cloudEmpty')}</div>}
            {cloudModels.map(m => {
              const isSel = selected.has(m.id)
              return (
                <button key={m.id} onClick={() => toggle(m.id)} style={rowStyle(isSel, !isSel && atCap)} title={m.id}>
                  {mark(isSel)}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                </button>
              )
            })}

            {/* OLLAMA — installed local models */}
            <div style={sectionHeadStyle}>{t('panelPicker.ollamaSection')}</div>
            {loading && ollamaModels.length === 0 && <div style={emptyRowStyle}>{t('panelPicker.loading')}</div>}
            {!loading && ollamaModels.length === 0 && <div style={emptyRowStyle}>{t('panelPicker.ollamaEmpty')}</div>}
            {ollamaModels.map(name => {
              const id = `ollama:${name}`
              const isSel = selected.has(id)
              return (
                <button key={id} onClick={() => toggle(id)} style={rowStyle(isSel, !isSel && atCap)} title={id}>
                  {mark(isSel)}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{name}</span>
                  {localTag}
                </button>
              )
            })}

            {/* LLAMA.CPP — downloaded GGUFs (one loads at a time) */}
            <div style={sectionHeadStyle}>{t('panelPicker.llamacppSection')}</div>
            {llamaError && (
              <div style={{ ...emptyRowStyle, color: 'var(--warning, #f59e0b)' }}>{llamaError}</div>
            )}
            {loading && llamaModels.length === 0 && <div style={emptyRowStyle}>{t('panelPicker.loading')}</div>}
            {!loading && llamaModels.length === 0 && <div style={emptyRowStyle}>{t('panelPicker.llamacppEmpty')}</div>}
            {llamaModels.map(m => {
              const id = `llamacpp:${m.id}`
              const isSel = selected.has(id)
              const busy = llamaBusy === m.id
              return (
                <button key={id} onClick={() => !busy && void toggleLlama(m)} style={rowStyle(isSel)} title={id}>
                  {mark(isSel)}
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, overflow: 'hidden' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                    <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                      {busy ? t('panelPicker.starting') : m.running ? t('panelPicker.running') : t('panelPicker.willStart')}
                    </span>
                  </span>
                  {localTag}
                </button>
              )
            })}

            <div style={{
              padding: '6px 10px', borderTop: '2px solid var(--border)',
              fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5,
            }}>{t('panelPicker.hint')}</div>
          </div>
        </>
      )}
    </span>
  )
}
