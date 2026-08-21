// apps/desktop/src/pages/settings/CustomEndpointsCard.tsx
//
// Settings → Connections → Providers: "Add custom endpoint" (USER-PAINS T17).
// Reach an LM Studio / Ollama / llama.cpp / vLLM server that the user runs on
// their own machine or another box on the LAN, by adding an OpenAI-compatible
// endpoint (name + base URL + optional key). Multiple endpoints are allowed.
//
// Persistence reuses the EXISTING ProviderSettings shape (kind 'custom-openai')
// in AppSettings.providers; the optional API key goes to the OS keychain under
// `custom:<id>` (never plaintext settings). The TEST button probes GET
// <baseUrl>/models in the main process (5s timeout) and shows the model count
// or the error. Brutalist idiom, copied from the neighbouring provider cards.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../../components/ConfirmProvider'
import {
  normalizeBaseUrl, customEndpointKeychainId, customProviderId, endpointLocality,
} from '@tachi/core/src/providers/custom-endpoint'
import type { ProviderSettings } from '@tachi/core'

type TestState = { ok: true; count: number } | { ok: false; error: string } | null

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-elevated)',
  boxShadow: 'var(--shadow-hard)',
  padding: 12,
  marginTop: 12,
  fontFamily: 'JetBrains Mono, monospace',
}
const inputStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 10,
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-base)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', outline: 'none',
}
const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  fontSize: 9, fontWeight: 700, padding: '5px 12px',
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow-hard)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
  fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.08em',
})
const ghostBtn: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, padding: '5px 10px',
  border: 'var(--border-width) solid var(--border)',
  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
  fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.06em',
}

function LocalityTag({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation('settings')
  const local = endpointLocality(baseUrl) === 'lan-local'
  const color = local ? 'var(--success)' : 'var(--warning)'
  return (
    <span style={{
      padding: '0px 4px', border: `2px solid ${color}`, color, background: 'transparent',
      fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      {local
        ? t('customEndpoint.lanBadge', { defaultValue: 'LAN-LOCAL' })
        : t('customEndpoint.cloudBadge', { defaultValue: 'CLOUD' })}
    </span>
  )
}

export function CustomEndpointsCard() {
  const { t } = useTranslation('settings')
  const confirm = useConfirm()

  const [endpoints, setEndpoints] = React.useState<ProviderSettings[]>([])
  const [keyIds, setKeyIds]       = React.useState<string[]>([])

  // Add-form state
  const [name, setName]       = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [apiKey, setApiKey]   = React.useState('')
  const [testing, setTesting] = React.useState(false)
  const [test, setTest]       = React.useState<TestState>(null)
  const [saving, setSaving]   = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  // Per-row TEST result keyed by endpoint id.
  const [rowTest, setRowTest] = React.useState<Record<string, TestState>>({})
  const [rowBusy, setRowBusy] = React.useState<Record<string, boolean>>({})

  const reload = React.useCallback(() => {
    window.tachi.settings.load()
      .then(s => setEndpoints((s.providers ?? []).filter(p => p.kind === 'custom-openai')))
      .catch(() => setEndpoints([]))
    window.tachi.settings.listKeys().then(setKeyIds).catch(() => setKeyIds([]))
  }, [])

  React.useEffect(() => { reload() }, [reload])

  const runTest = async () => {
    const norm = normalizeBaseUrl(baseUrl)
    if (!norm.ok || !norm.url) { setTest({ ok: false, error: norm.error ?? 'Invalid URL' }); return }
    setTesting(true); setTest(null)
    try {
      const res = await window.tachi.provider.testCustomEndpoint(norm.url, apiKey.trim() || undefined)
      setTest(res.ok ? { ok: true, count: res.models.length } : { ok: false, error: res.error ?? 'Failed' })
    } catch (e) {
      setTest({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0 && !saving

  const save = async () => {
    setFormError(null)
    const norm = normalizeBaseUrl(baseUrl)
    if (!norm.ok || !norm.url) { setFormError(norm.error ?? t('customEndpoint.invalidUrl', { defaultValue: 'Enter a valid http(s) base URL.' })); return }
    if (!name.trim()) { setFormError(t('customEndpoint.nameRequired', { defaultValue: 'Enter a name.' })); return }
    setSaving(true)
    try {
      const id = globalThis.crypto.randomUUID()
      const entry: ProviderSettings = {
        id, kind: 'custom-openai', displayName: name.trim(), baseUrl: norm.url, enabled: true,
      }
      const current = (await window.tachi.settings.load()).providers ?? []
      await window.tachi.settings.save({ providers: [...current, entry] })
      if (apiKey.trim()) await window.tachi.settings.saveKey(customEndpointKeychainId(id), apiKey.trim())
      setName(''); setBaseUrl(''); setApiKey(''); setTest(null)
      reload()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (ep: ProviderSettings) => {
    const ok = await confirm({ message: t('customEndpoint.deleteConfirm', { defaultValue: 'Remove this endpoint?', name: ep.displayName }) })
    if (!ok) return
    const current = (await window.tachi.settings.load()).providers ?? []
    await window.tachi.settings.save({ providers: current.filter(p => p.id !== ep.id) })
    await window.tachi.settings.deleteKey(customEndpointKeychainId(ep.id)).catch(() => {})
    reload()
  }

  const toggleEnabled = async (ep: ProviderSettings) => {
    const current = (await window.tachi.settings.load()).providers ?? []
    await window.tachi.settings.save({ providers: current.map(p => p.id === ep.id ? { ...p, enabled: !p.enabled } : p) })
    reload()
  }

  const removeKey = async (ep: ProviderSettings) => {
    await window.tachi.settings.deleteKey(customEndpointKeychainId(ep.id))
    reload()
  }

  const testRow = async (ep: ProviderSettings) => {
    setRowBusy(b => ({ ...b, [ep.id]: true }))
    setRowTest(r => ({ ...r, [ep.id]: null }))
    try {
      // Uses the STORED key via the main-process resolver (renderer never sees it).
      const res = await window.tachi.provider.listCustomModels(customProviderId(ep.id), true)
      setRowTest(r => ({ ...r, [ep.id]: res.ok ? { ok: true, count: res.models.length } : { ok: false, error: res.error ?? 'Failed' } }))
    } catch (e) {
      setRowTest(r => ({ ...r, [ep.id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setRowBusy(b => ({ ...b, [ep.id]: false }))
    }
  }

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, color: 'var(--text-primary)' }}>
        {t('customEndpoint.title', { defaultValue: 'Custom endpoint (OpenAI-compatible)' })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        {t('customEndpoint.description', { defaultValue: 'Reach an LM Studio / Ollama / llama.cpp / vLLM server on this machine or another box on your LAN. Include the /v1 path in the base URL.' })}
      </div>

      {/* Existing endpoints */}
      {endpoints.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {endpoints.map(ep => {
            const hasKey = keyIds.includes(customEndpointKeychainId(ep.id))
            const rt = rowTest[ep.id]
            return (
              <div key={ep.id} style={{
                border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
                padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
                opacity: ep.enabled ? 1 : 0.6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{ep.displayName}</span>
                  <LocalityTag baseUrl={ep.baseUrl} />
                  {hasKey && <span style={{ fontSize: 8, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.05em' }}>{t('customEndpoint.keyOn', { defaultValue: 'KEY' })}</span>}
                  {!ep.enabled && <span style={{ fontSize: 8, color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.05em' }}>{t('customEndpoint.disabled', { defaultValue: 'DISABLED' })}</span>}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{ep.baseUrl}</div>
                {rt && (
                  <div style={{ fontSize: 9, color: rt.ok ? 'var(--success)' : 'var(--warning)', lineHeight: 1.4 }}>
                    {rt.ok
                      ? t('customEndpoint.testOk', { defaultValue: '✓ Reachable — {{count}} model(s)', count: rt.count })
                      : t('customEndpoint.testFail', { defaultValue: '✗ {{error}}', error: rt.error })}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => testRow(ep)} disabled={rowBusy[ep.id]} style={{ ...ghostBtn, opacity: rowBusy[ep.id] ? 0.5 : 1 }}>
                    {rowBusy[ep.id] ? t('customEndpoint.testing', { defaultValue: 'Testing…' }) : t('customEndpoint.test', { defaultValue: 'Test' })}
                  </button>
                  <button onClick={() => toggleEnabled(ep)} style={ghostBtn}>
                    {ep.enabled ? t('customEndpoint.disable', { defaultValue: 'Disable' }) : t('customEndpoint.enable', { defaultValue: 'Enable' })}
                  </button>
                  {hasKey && (
                    <button onClick={() => removeKey(ep)} style={ghostBtn}>{t('customEndpoint.removeKey', { defaultValue: 'Remove key' })}</button>
                  )}
                  <button onClick={() => remove(ep)} style={{
                    ...ghostBtn, border: 'var(--border-width) solid var(--destructive)', color: 'var(--destructive)',
                  }}>{t('customEndpoint.remove', { defaultValue: 'Remove' })}</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add form */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: 'var(--border-width) solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
          {t('customEndpoint.addTitle', { defaultValue: 'Add custom endpoint' })}
        </div>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('customEndpoint.namePlaceholder', { defaultValue: 'name (e.g. LM Studio · office PC)' })}
          style={inputStyle}
        />
        <input
          value={baseUrl}
          onChange={e => { setBaseUrl(e.target.value); setTest(null) }}
          placeholder={t('customEndpoint.urlPlaceholder', { defaultValue: 'http://192.168.1.50:1234/v1' })}
          style={inputStyle}
        />
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={t('customEndpoint.keyPlaceholder', { defaultValue: 'API key (optional)' })}
          style={inputStyle}
        />
        {test && (
          <div style={{ fontSize: 9, color: test.ok ? 'var(--success)' : 'var(--warning)', lineHeight: 1.4 }}>
            {test.ok
              ? t('customEndpoint.testOk', { defaultValue: '✓ Reachable — {{count}} model(s)', count: test.count })
              : t('customEndpoint.testFail', { defaultValue: '✗ {{error}}', error: test.error })}
          </div>
        )}
        {formError && (
          <div style={{ fontSize: 9, color: 'var(--destructive)', lineHeight: 1.4 }}>{formError}</div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={runTest} disabled={testing || !baseUrl.trim()} style={{ ...ghostBtn, opacity: (testing || !baseUrl.trim()) ? 0.5 : 1 }}>
            {testing ? t('customEndpoint.testing', { defaultValue: 'Testing…' }) : t('customEndpoint.test', { defaultValue: 'Test' })}
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={save} disabled={!canSave} style={primaryBtn(canSave)}>
            {t('customEndpoint.add', { defaultValue: 'Add endpoint' })}
          </button>
        </div>
      </div>
    </div>
  )
}

export default CustomEndpointsCard
