import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOnboardingStore } from '../../../store/onboarding.store'
import { usePrivacyStore } from '../../../store/privacy.store'
import { ProviderIcon } from '../../../components/ProviderIcon'
// Locality is a FACT from the registry, never a literal typed here: this step
// used to hardcode badge 'LOCAL' on Ollama and a LOCAL_PROVIDER_IDS set beside
// it, so the first screen a user ever sees made a privacy claim that nothing
// checked. Both now derive from `egress` (see providerLocality's doc).
import { providerLocality, type ProviderId } from '@tachi/core/src/providers/registry'

// Copy lives in i18n: descriptions render via t(`provider.list.${id}`) and the
// key label via t('provider.bankrKey') — no English literals here.
interface ProviderDef {
  /** Onboarding's own id — also the i18n key and the ProviderIcon key. */
  id: string
  /** Canonical registry id. The ONLY input to the locality claim below. */
  canonical: ProviderId
  label: string
  /** Non-locality badge (price / auth kind). A locality badge is derived. */
  badge?: string
  needsKey?: boolean
  keyPlaceholder?: string
}

const PROVIDERS: ProviderDef[] = [
  { id: 'freellmapi',      canonical: 'freellmapi-local',  label: 'FreeLLMAPI', badge: 'FREE' },
  { id: 'bankr-gateway',   canonical: 'bankr-gateway',     label: 'Bankr', needsKey: true, keyPlaceholder: 'bk_...' },
  { id: 'anthropic-oauth', canonical: 'anthropic-oauth',   label: 'Anthropic',  badge: 'OAUTH' },
  { id: 'ollama',          canonical: 'ollama-local',      label: 'Ollama' },
  { id: 'openrouter',      canonical: 'openrouter-oauth',  label: 'OpenRouter', badge: 'OAUTH' },
]

/**
 * This step's own id → the CANONICAL registry id every other surface speaks.
 *
 * Derived from PROVIDERS rather than typed out again: the two id spaces differ
 * ('freellmapi' vs 'freellmapi-local', 'ollama' vs 'ollama-local'), and a second
 * hand-written copy is how the first-run pick would silently stop matching.
 * Exported so the wizard can hand the choice to the chat default — before this,
 * `selectedProvider` was written, persisted, and read by nothing but the
 * highlight on this very screen.
 */
export function canonicalProviderId(onboardingId: string | undefined): ProviderId | undefined {
  return PROVIDERS.find(p => p.id === onboardingId)?.canonical
}

/**
 * The LOCAL pill, and only for a provider whose prompt really never leaves the
 * machine. A relay (localhost sidecar → cloud) gets nothing here: it already
 * carries FREE, and this step has room for one honest word, not two.
 */
function localityBadge(p: ProviderDef): string | null {
  return providerLocality(p.canonical) === 'local' ? 'LOCAL' : null
}

/** PRIVATE MODE keeps only truly-local providers selectable — same fact, same source. */
function isPrivateModeSafe(p: ProviderDef): boolean {
  return providerLocality(p.canonical) === 'local'
}

interface ProviderStepProps {
  onContinue: () => void
  onBack: () => void
  onSkip: () => void
}

export function ProviderStep({ onContinue, onBack, onSkip }: ProviderStepProps) {
  const { selectedProvider, setSelectedProvider } = useOnboardingStore()
  const { t } = useTranslation('onboarding')
  const privateMode = usePrivacyStore(s => s.mode === 'private')
  const [keyValues, setKeyValues] = useState<Record<string, string>>({})
  // A2: extended status enum surfaces real probe outcomes. `auth` = key
  // rejected (401/403); `unreachable` = network/dns/timeout; `degraded` =
  // upstream returned a non-fatal error (rate-limit, 5xx).
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'auth' | 'unreachable' | 'degraded'>>({})
  const [testHint, setTestHint] = useState<Record<string, string>>({})
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // GPU-truth at first run (STEAL 2026-07-08): tell the beginner they have a
  // GPU and can run models fully locally — the "invisible GPU fallback" the
  // research flags as a top bounce cause. Best-effort; silent if none.
  const [gpu, setGpu] = useState<{ name: string; vramMB: number; backend: string } | null>(null)
  useEffect(() => {
    let alive = true
    window.tachi.llamaCpp?.gpu?.()
      .then(g => { if (alive && g && g.backend !== 'cpu' && g.vendor !== 'unknown') setGpu({ name: g.name, vramMB: g.vramMB, backend: g.backend }) })
      .catch(() => { /* no GPU probe — banner just doesn't show */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onSkip()
      if (e.key === 'Enter' && selectedProvider) {
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT') onContinue()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onContinue, onSkip, selectedProvider])

  function selectProvider(id: string) {
    setSelectedProvider(id)
    const def = PROVIDERS.find(p => p.id === id)
    if (def?.needsKey) {
      setTimeout(() => inputRefs.current[id]?.focus(), 60)
    }
  }

  async function handleTest(providerId: string) {
    const key = keyValues[providerId]?.trim() ?? ''
    setTestStatus(s => ({ ...s, [providerId]: 'testing' }))
    setTestHint(h => ({ ...h, [providerId]: '' }))
    try {
      // A2 — real connectivity probe via /v1/models in main.
      const result = await window.tachi.provider.testKey(providerId, key)
      if (result.status === 'healthy') {
        setTestStatus(s => ({ ...s, [providerId]: 'ok' }))
        setTestHint(h => ({ ...h, [providerId]: t('provider.hints.connected') }))
      } else if (result.status === 'reachable_auth_invalid') {
        setTestStatus(s => ({ ...s, [providerId]: 'auth' }))
        setTestHint(h => ({ ...h, [providerId]: t('provider.hints.authInvalid') }))
      } else if (result.status === 'degraded') {
        setTestStatus(s => ({ ...s, [providerId]: 'degraded' }))
        setTestHint(h => ({ ...h, [providerId]: result.message ?? t('provider.hints.degraded') }))
      } else {
        setTestStatus(s => ({ ...s, [providerId]: 'unreachable' }))
        setTestHint(h => ({ ...h, [providerId]: t('provider.hints.unreachable') }))
      }
    } catch (err) {
      setTestStatus(s => ({ ...s, [providerId]: 'unreachable' }))
      const detail = err instanceof Error ? err.message : String(err)
      setTestHint(h => ({ ...h, [providerId]: `${t('provider.hints.unreachable')} (${detail})` }))
    }
  }

  const canContinue = selectedProvider !== undefined

  return (
    <div style={container}>
      <div style={inner}>
        <h2 style={heading}>{t('provider.heading')}</h2>
        <p style={subtext}>{t('provider.subtext')}</p>

        {gpu && !privateMode && (
          <div data-testid="gpu-onboarding-banner" style={{
            border: '2px solid var(--accent)', padding: '8px 10px', marginBottom: 16,
            fontFamily: 'JetBrains Mono, monospace', background: 'var(--accent-muted)',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>
              ⚡ {t('provider.gpuBanner.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
              {t('provider.gpuBanner.body', { gpu: gpu.name, vram: gpu.vramMB > 0 ? `${Math.round(gpu.vramMB / 1024)}GB` : '' })}
            </div>
          </div>
        )}

        {privateMode && (
          <div style={{
            border: '2px solid var(--danger)', padding: '8px 10px', marginBottom: 16,
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--danger)' }}>
              {t('provider.privateBanner.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
              {t('provider.privateBanner.body')}
            </div>
          </div>
        )}

        <div style={cardList}>
          {PROVIDERS.map(p => {
            const isSelected = selectedProvider === p.id
            const keyVal = keyValues[p.id] ?? ''
            const status = testStatus[p.id] ?? 'idle'
            const locked = privateMode && !isPrivateModeSafe(p)
            const localPill = localityBadge(p)

            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-disabled={locked}
                title={locked ? t('provider.lockedTitle') : undefined}
                onClick={() => { if (locked) return; selectProvider(p.id) }}
                onKeyDown={e => { if (locked) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProvider(p.id) } }}
                style={{
                  ...card,
                  border: isSelected
                    ? '2px solid var(--accent)'
                    : '2px solid var(--border)',
                  background: isSelected ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                  cursor: locked ? 'not-allowed' : 'pointer',
                  opacity: locked ? 0.45 : 1,
                  boxShadow: isSelected ? 'var(--shadow-hard)' : 'none',
                }}
              >
                <div style={cardHeader}>
                  <ProviderIcon providerId={p.id} size={16} style={{ marginRight: 6 }} />
                  <span style={cardLabel}>{p.label}</span>
                  <div style={badgeRow}>
                    {p.badge && (
                      <span style={{
                        ...badgePill,
                        color: isSelected ? 'var(--accent-text)' : 'var(--text-muted)',
                        borderColor: isSelected ? 'var(--accent-text)' : 'var(--border-strong)',
                      }}>
                        {p.badge}
                      </span>
                    )}
                    {localPill && (
                      <span style={{ ...badgePill, color: 'var(--success)', borderColor: 'var(--success)' }}>
                        {localPill}
                      </span>
                    )}
                    {isSelected && (
                      <span style={selectedIndicator}>{t('provider.selected')}</span>
                    )}
                    {locked && (
                      <span style={{ ...selectedIndicator, color: 'var(--danger)', borderColor: 'var(--danger)' }}>{t('provider.locked')}</span>
                    )}
                  </div>
                </div>
                <p style={cardDesc}>{t(`provider.list.${p.id}`)}</p>

                {isSelected && p.needsKey && (
                  <div
                    style={keyRow}
                    onClick={e => e.stopPropagation()}
                  >
                    <span style={keyLabelStyle}>{t('provider.bankrKey')}</span>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <input
                        ref={el => { inputRefs.current[p.id] = el }}
                        type="password"
                        placeholder={p.keyPlaceholder}
                        value={keyVal}
                        onChange={e => setKeyValues(kv => ({ ...kv, [p.id]: e.target.value }))}
                        style={keyInput}
                      />
                      <button
                        onClick={() => handleTest(p.id)}
                        disabled={!keyVal.trim() || status === 'testing'}
                        style={{
                          ...testBtn,
                          opacity: (!keyVal.trim() || status === 'testing') ? 0.5 : 1,
                          background: testBg(status),
                          borderColor: testBorder(status),
                          color: testColor(status),
                        }}
                      >
                        {status === 'testing' ? '...'
                          : status === 'ok'          ? t('provider.testStates.ok')
                          : status === 'auth'        ? t('provider.testStates.auth')
                          : status === 'unreachable' ? t('provider.testStates.noNet')
                          : status === 'degraded'    ? t('provider.testStates.warn')
                          : t('provider.test')}
                      </button>
                    </div>
                    {testHint[p.id] && (
                      <div style={{
                        ...keyLabelStyle,
                        marginTop: 6,
                        textTransform: 'none',
                        letterSpacing: '0.02em',
                        color: status === 'ok' ? 'var(--success)'
                             : status === 'auth' || status === 'unreachable' ? 'var(--danger)'
                             : status === 'degraded' ? 'var(--warning)'
                             : 'var(--text-muted)',
                      }}>
                        {testHint[p.id]}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div style={navRow}>
          <button onClick={onBack} style={secondaryBtn}>{t('nav.back')}</button>
          <button
            onClick={onContinue}
            disabled={!canContinue}
            style={{ ...primaryBtn, opacity: canContinue ? 1 : 0.4, cursor: canContinue ? 'pointer' : 'default' }}
          >
            {t('nav.continue')}
          </button>
          <button onClick={onSkip} style={skipLink}>{t('provider.skipStep')}</button>
        </div>
      </div>
    </div>
  )
}

const container: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  width: '100%',
}

const inner: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 580,
  width: '100%',
  padding: '0 24px',
}

const heading: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 26,
  fontWeight: 800,
  color: 'var(--text-primary)',
  marginBottom: 6,
  letterSpacing: '-0.5px',
}

const subtext: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  marginBottom: 24,
  letterSpacing: '0.04em',
}

const cardList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginBottom: 28,
}

const card: React.CSSProperties = {
  padding: '12px 14px',
  outline: 'none',
}

const cardHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 4,
}

const cardLabel: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--text-primary)',
  letterSpacing: '0.02em',
}

const badgeRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
}

const badgePill: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  border: 'var(--border-width) solid',
  padding: '1px 6px',
}

const selectedIndicator: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--accent)',
  border: 'var(--border-width) solid var(--accent)',
  padding: '1px 6px',
}

const cardDesc: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  lineHeight: 1.5,
  margin: 0,
}

const keyRow: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: 'var(--border-width) solid var(--border)',
}

const keyLabelStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
}

const keyInput: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  outline: 'none',
}

const testBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  padding: '6px 12px',
  border: '2px solid',
  cursor: 'pointer',
  flexShrink: 0,
}

// Color helpers for the test-button states — pulled out so the JSX stays scannable.
function testBg(s: string): string {
  if (s === 'ok')                          return 'var(--success)'
  if (s === 'auth' || s === 'unreachable') return 'var(--danger)'
  if (s === 'degraded')                    return 'var(--warning)'
  return 'var(--bg-surface)'
}
function testBorder(s: string): string {
  if (s === 'ok')                          return 'var(--success)'
  if (s === 'auth' || s === 'unreachable') return 'var(--danger)'
  if (s === 'degraded')                    return 'var(--warning)'
  return 'var(--border)'
}
function testColor(s: string): string {
  if (s === 'ok' || s === 'auth' || s === 'unreachable' || s === 'degraded') return '#ffffff'
  return 'var(--text-primary)'
}

const navRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const primaryBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '10px 28px',
  border: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  cursor: 'pointer',
  boxShadow: 'var(--shadow-hard)',
}

const secondaryBtn: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '10px 28px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
}

const skipLink: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  color: 'var(--text-muted)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
  marginLeft: 'auto',
}
