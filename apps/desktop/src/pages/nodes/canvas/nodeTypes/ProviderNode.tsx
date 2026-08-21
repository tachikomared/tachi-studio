// apps/desktop/src/pages/nodes/canvas/nodeTypes/ProviderNode.tsx
//
// Provider node — represents one upstream LLM gateway. Carries the SELECTED
// MODEL on its `data.model`; downstream agent nodes use whatever the upstream
// provider picked instead of having their own model field.
//
// The per-provider fallback catalog is the SHARED one (useProviderModels.ts::
// staticModelIds); each provider's real catalog is fetched live on mount.
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiProviderNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'
import { QuickAddPlus } from '../QuickAddPlus'
import { canonicalProviderId } from '../../providerCompat'
// THE model catalog lives in useProviderModels.ts and is imported, not copied.
// This file used to keep its own byte-for-byte STATIC_MODELS mirror under a
// comment that admitted it; they had already drifted (imgnai was in the hook's
// table and missing here, so an imgnai provider node showed no dropdown at all).
// Model ids go stale monthly — a second copy is a stale copy.
//
// The LIVE fetches below stay here on purpose: unlike the hook, they also WRITE
// node data (Ollama resolves an unusable 'auto' seed, but only off a live list;
// llama.cpp prefers the model that is actually loaded), which is this
// component's business and not a read-only catalog hook's.
import { staticModelIds } from '../../useProviderModels'

// Live model shapes returned by bankr:list-models IPC (matches BankrModelInfo)
interface LiveBankrModel {
  id:      string
  label:   string
  family?: string
  live:    boolean
}

// ── Styles ───────────────────────────────────────────────────────────────────
const nodeStyle: React.CSSProperties = {
  position: 'relative',
  background: 'var(--bg-surface)',
  border: '2px solid var(--accent)',
  fontFamily: 'JetBrains Mono, monospace',
  minWidth: 180,
  boxShadow: '4px 4px 0 var(--accent)',
}

const headerStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: 'var(--bg-base)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', display: 'block', marginBottom: 4 }
const subStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', display: 'block' }

const selectStyle: React.CSSProperties = {
  marginTop: 6,
  width: '100%',
  padding: '3px 4px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  cursor: 'pointer',
}

// ── Component ────────────────────────────────────────────────────────────────
export function ProviderNode({ id, data }: NodeProps<TachiProviderNode>) {
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  // Normalize legacy short ids ('bankr') to canonical registry ids
  // ('bankr-gateway') so old saved flows + new registry-seeded nodes both work.
  const pid = canonicalProviderId(data.providerId)
  const [models, setModels] = useState<string[]>(() => staticModelIds(pid))
  // For Bankr: track live model labels for richer option text
  const [bankrLabels, setBankrLabels] = useState<Record<string, string>>({})
  const [hover, setHover]   = useState(false)

  // For Bankr, hit the live catalog endpoint so the dropdown reflects
  // whatever the gateway actually offers right now. Falls back to the
  // hardcoded list on any error.
  // Uses the same IPC path as BankrModelPicker (window.tachi.bankr.listModels).
  useEffect(() => {
    if (pid !== 'bankr-gateway') return
    let cancelled = false
    ;(window.tachi.bankr?.listModels?.({ force: true }) ?? Promise.resolve(null))
      .then((res: { ok: boolean; models: LiveBankrModel[] } | null) => {
        if (cancelled) return
        if (res?.ok && Array.isArray(res.models) && res.models.length > 0) {
          setModels(res.models.map(m => m.id))
          // Build a label map so <option> text shows human-readable names
          const labelMap: Record<string, string> = {}
          for (const m of res.models) { labelMap[m.id] = m.label || m.id }
          setBankrLabels(labelMap)
        }
      })
      .catch(() => { /* keep static fallback */ })
    return () => { cancelled = true }
  }, [pid])

  // For Surplus, hit the live marketplace catalog (/api/inference/v1/models) so
  // the dropdown reflects its 100+ models. Falls back to the static list on error.
  useEffect(() => {
    if (pid !== 'surplus') return
    let cancelled = false
    ;(window.tachi.surplus?.listModels?.({ force: true }) ?? Promise.resolve(null))
      .then((res: { ok: boolean; models: LiveBankrModel[] } | null) => {
        if (cancelled) return
        if (res?.ok && Array.isArray(res.models) && res.models.length > 0) {
          setModels(res.models.map(m => m.id))
          const labelMap: Record<string, string> = {}
          for (const m of res.models) { labelMap[m.id] = m.label || m.id }
          setBankrLabels(labelMap)
        }
      })
      .catch(() => { /* keep static fallback */ })
    return () => { cancelled = true }
  }, [pid])

  // For freellmapi, pull the live fallback catalog (the models the sidecar can
  // actually route to) — same list Chat uses — so the dropdown isn't a stale
  // hardcoded set. 'auto' stays first as the safe default.
  useEffect(() => {
    if (pid !== 'freellmapi-local') return
    let cancelled = false
    ;(window.tachi.freellmapi?.listFallbackModels?.() ?? Promise.resolve(null))
      .then((res: { ok: boolean; models: Array<{ modelId: string; name: string; platform: string }> } | null) => {
        if (cancelled || !res?.ok || !Array.isArray(res.models) || res.models.length === 0) return
        const ids = res.models.map(m => m.modelId)
        setModels(['auto', ...ids])
        const labelMap: Record<string, string> = { auto: 'auto (best available)' }
        for (const m of res.models) labelMap[m.modelId] = `${m.name} · ${m.platform}`
        setBankrLabels(labelMap)
      })
      .catch(() => { /* keep ['auto'] fallback */ })
    return () => { cancelled = true }
  }, [pid])

  // For Venice, hit the live text catalog (/models?type=text) so the node's
  // dropdown reflects Venice's models — same IPC the chat VeniceModelPicker uses.
  useEffect(() => {
    if (pid !== 'venice') return
    let cancelled = false
    ;(window.tachi.venice?.listModels?.({ force: true }) ?? Promise.resolve(null))
      .then((res: { ok: boolean; models: Array<{ id: string; label: string }> } | null) => {
        if (cancelled || !res?.ok || !Array.isArray(res.models) || res.models.length === 0) return
        setModels(res.models.map(m => m.id))
        const labelMap: Record<string, string> = {}
        for (const m of res.models) labelMap[m.id] = m.label || m.id
        setBankrLabels(labelMap)
      })
      .catch(() => { /* keep static fallback */ })
    return () => { cancelled = true }
  }, [pid])

  // For Ollama, list the models the user has actually PULLED — the same IPC the
  // chat picker and useProviderModels use. Two reasons this is not optional:
  // the static list above is a guess about someone else's machine, and Ollama
  // has no 'auto' (chat resolves it by listing /api/tags before sending, the
  // canvas runner does not — it forwards 'auto' and the run dies on
  // `model 'auto' not found`). So a node still carrying the registry's 'auto'
  // seed is resolved HERE, against real pulled models, and written to node data
  // — never left as a value the select cannot show.
  useEffect(() => {
    if (pid !== 'ollama-local') return
    let cancelled = false
    ;(window.tachi.ollama?.listModels?.() ?? Promise.resolve(null))
      .then((res: { ok: boolean; models: Array<{ name?: string }> } | null) => {
        if (cancelled || !res?.ok || !Array.isArray(res.models)) return
        const names = res.models.map(m => m.name ?? '').filter(Boolean)
        if (names.length === 0) return
        setModels(names)
        // Only ever commit a model the user really has: this branch runs solely
        // on a LIVE list, never on the static fallback.
        if (!data.model || data.model === 'auto' || !names.includes(data.model)) {
          updateNodeData(id, { model: names[0] })
        }
      })
      .catch(() => { /* ollama not running → keep the static fallback */ })
    return () => { cancelled = true }
  }, [pid]) // eslint-disable-line react-hooks/exhaustive-deps

  // For llama.cpp, list the INSTALLED local models (it runs one at a time). The
  // chosen model must be started in Status → llama.cpp for a run to succeed.
  useEffect(() => {
    if (pid !== 'llama-cpp') return
    let cancelled = false
    ;(window.tachi.llamaCpp?.status?.() ?? Promise.resolve(null))
      .then((s: { downloadedModels?: string[]; modelId?: string } | null) => {
        if (cancelled || !s || !Array.isArray(s.downloadedModels) || s.downloadedModels.length === 0) return
        setModels(s.downloadedModels)
        if ((!data.model || data.model === 'auto')) {
          const def = s.modelId && s.downloadedModels.includes(s.modelId) ? s.modelId : s.downloadedModels[0]
          updateNodeData(id, { model: def })
        }
      })
      .catch(() => { /* no local models → empty dropdown */ })
    return () => { cancelled = true }
  }, [pid]) // eslint-disable-line react-hooks/exhaustive-deps

  // WHAT THE SELECT SHOWS IS WHAT THE RUN SENDS — the node's own `data.model`
  // is the only thing the runner reads, and it used to be free to disagree with
  // the screen. `value={data.model ?? models[0]}` displayed the first option
  // whenever data was empty and stored nothing, so a user who never touched the
  // dropdown "had" a model that only existed on screen.
  useEffect(() => {
    if (models.length === 0) return
    if (!data.model) updateNodeData(id, { model: models[0] })
  }, [models, data.model, id, updateNodeData])

  const onModelChange = (next: string) => updateNodeData(id, { model: next })

  // The other half of the same divergence: React selects the FIRST option when
  // a controlled value matches none of them. An Ollama node seeded with the
  // registry's 'auto' therefore displayed `aya-expanse:8b` while node data still
  // said 'auto' — the run took two minutes to fail on a model nobody picked. A
  // value the catalog doesn't offer is now rendered as its own option (the same
  // rule PromptNode and the Configure panel already follow), so the select can
  // no longer show one model and mean another.
  const selected = data.model ?? models[0]
  const unlisted = selected != null && selected !== '' && !models.includes(selected)

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>provider</span>
        {hover && (
          <DeleteButton onClick={() => deleteNode(id)} bg="var(--bg-base)" fg="var(--accent)" />
        )}
      </div>
      <div style={bodyStyle}>
        <span style={labelStyle}>{data.label}</span>
        {pid && <span style={subStyle}>{pid}</span>}
        {data.endpoint && (
          <span style={{ ...subStyle, color: 'var(--accent)', marginTop: 2 }}>
            {data.endpoint}
          </span>
        )}

        {/* Inline model picker — the selected model flows downstream to agents. */}
        {models.length > 0 && (
          <select
            value={selected}
            onChange={(e) => onModelChange(e.target.value)}
            // nodrag prevents ReactFlow from intercepting the select interaction.
            className="nodrag"
            style={selectStyle}
          >
            {unlisted && <option value={selected}>{bankrLabels[selected] ?? selected}</option>}
            {models.map(m => (
              <option key={m} value={m}>
                {bankrLabels[m] ?? m}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* A4: 8 invisible source handles — providers only push downstream. */}
      <EightHandles role="source" color="var(--accent)" />
      {/* Twenty-style hover "+" — add + auto-connect a node below this one. */}
      <QuickAddPlus sourceId={id} color="var(--accent)" />
    </div>
  )
}

// ── DeleteButton — shared visual; small × icon on hover ──────────────────────
function DeleteButton({ onClick, bg, fg }: { onClick: () => void; bg: string; fg: string }) {
  const { t } = useTranslation('nodes')
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="nodrag"
      title={t('node.delete')}
      aria-label={t('node.delete')}
      style={{
        width: 16,
        height: 16,
        padding: 0,
        border: `var(--border-width) solid ${fg}`,
        background: bg,
        color: fg,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        fontWeight: 800,
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >×</button>
  )
}
