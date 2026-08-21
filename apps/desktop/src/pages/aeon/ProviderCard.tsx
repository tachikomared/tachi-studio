// apps/desktop/src/pages/aeon/ProviderCard.tsx
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showToast } from '../../components/Toaster'

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
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
}

const rowStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  outline: 'none',
  boxSizing: 'border-box',
}

const saveBtnStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: 'var(--border-width) solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: '0.04em',
  alignSelf: 'flex-start',
}

interface ProviderRowProps {
  label: string
  description: string
  placeholder: string
  owner: string
  baseUrl: string
  onSave: (key: string) => Promise<void>
  secretExists: boolean
}

function ProviderRow({ label, description, placeholder, onSave, secretExists }: ProviderRowProps) {
  const { t } = useTranslation('aeon')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!key.trim()) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await onSave(key.trim())
      setSaved(true)
      setKey('')
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{label}</span>
        {(secretExists || saved) && (
          <span style={{
            fontSize: 9,
            color: 'var(--success)',
            fontFamily: 'JetBrains Mono, monospace',
            border: 'var(--border-width) solid var(--success)',
            padding: '1px 5px',
            letterSpacing: '0.06em',
          }}>
            {t('provider.set')}
          </span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>{description}</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="password"
          style={inputStyle}
          placeholder={placeholder}
          value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        />
        <button
          style={{ ...saveBtnStyle, opacity: saving || !key.trim() ? 0.6 : 1 }}
          disabled={saving || !key.trim()}
          onClick={handleSave}
        >
          {saving ? '…' : t('provider.save')}
        </button>
      </div>
      {error && (
        <span style={{ fontSize: 10, color: 'var(--destructive)', fontFamily: 'JetBrains Mono, monospace' }}>{error}</span>
      )}
    </div>
  )
}

interface ProviderCardProps {
  owner: string
}

type GatewayMode = 'direct' | 'bankr' | 'opengateway'

interface RowConfig {
  label:        string
  provider:     'opengateway' | 'bankr-gateway' | 'anthropic-oauth' | 'anthropic'
  description:  string
  placeholder:  string
  /** GitHub secret name the upstream Aeon workflow actually reads. */
  secretName:   string
  /** Optional warning shown below the description (yellow text). */
  warning?:     string
  /**
   * Which aeon.yml `gateway.provider` value activates this provider's path.
   * The renderer shows an "Activate" button mapping this row to that mode.
   */
  activates:    GatewayMode
}

const ROWS: RowConfig[] = [
  {
    label: 'Anthropic OAuth',
    provider: 'anthropic-oauth',
    description: 'Anthropic OAuth refresh token from /chat (Anthropic Pro login). The Aeon workflow uses this via Claude Code OAuth mode — recommended path.',
    placeholder: 'sk-ant-oat-…',
    secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
    activates: 'direct',
  },
  {
    label: 'Anthropic API key',
    provider: 'anthropic',
    description: 'Direct Anthropic API key (sk-ant-api03-…). Read by the workflow as ANTHROPIC_API_KEY when not in gateway mode.',
    placeholder: 'sk-ant-api03-…',
    secretName: 'ANTHROPIC_API_KEY',
    activates: 'direct',
  },
  {
    label: 'Bankr Gateway',
    provider: 'bankr-gateway',
    description: 'Bankr LLM key (bk_…). Aeon natively supports Bankr — click "Activate" to set gateway.provider=bankr in aeon.yml.',
    placeholder: 'bk_…',
    secretName: 'BANKR_LLM_KEY',
    activates: 'bankr',
  },
  {
    label: 'OpenGateway',
    provider: 'opengateway',
    description: 'OpenGateway key (ogw_live_…). Pushes two secrets: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. Needs the workflow-patch below — Aeon doesn\'t natively route through OpenGateway.',
    placeholder: 'ogw_live_…',
    secretName: 'ANTHROPIC_BASE_URL + AUTH_TOKEN',
    activates: 'opengateway',
  },
]

export function ProviderCard({ owner }: ProviderCardProps) {
  const { t } = useTranslation('aeon')
  // Local keys configured in Settings (the chat-tab keychain).
  const [localKeys, setLocalKeys] = useState<string[]>([])
  // Tracks which provider has been pushed to GitHub during this session.
  const [pushedThisSession, setPushedThisSession] = useState<Record<string, boolean>>({})
  const [pushing, setPushing] = useState<string | null>(null)
  const [explicit, setExplicit] = useState<Record<string, boolean>>({})
  // Whether the fork's aeon.yml has the OpenGateway env-injection patch applied.
  const [patched, setPatched] = useState<boolean | null>(null)
  const [patching, setPatching] = useState(false)
  // Current `gateway.provider` value from the fork's top-level aeon.yml.
  // Drives the ACTIVE ✓ badge and the per-row Activate button.
  const [gateway, setGateway] = useState<GatewayMode | null>(null)
  const [activating, setActivating] = useState<GatewayMode | null>(null)

  useEffect(() => {
    window.tachi.settings.listKeys()
      .then(setLocalKeys)
      .catch(() => setLocalKeys([]))
  }, [pushedThisSession])

  // Poll the workflow patch status whenever the OpenGateway push state changes
  // so the badge stays in sync after an apply/revert.
  useEffect(() => {
    window.tachi.aeon.workflowPatchStatus(owner)
      .then(setPatched)
      .catch(() => setPatched(null))
  }, [owner, pushedThisSession.opengateway, patching])

  // Refresh the active aeon.yml gateway whenever we may have changed it
  // (initial mount, after activating, or right after pushing a secret in
  // case the user wants visual confirmation that activation is still needed).
  useEffect(() => {
    window.tachi.aeon.getGateway(owner)
      .then(setGateway)
      .catch(() => setGateway(null))
  }, [owner, activating])

  async function activateGateway(mode: GatewayMode, label: string) {
    setActivating(mode)
    try {
      const res = await window.tachi.aeon.setGateway(owner, mode)
      setGateway(mode)
      showToast({
        kind: 'success',
        text: res.changed
          ? t('provider.toast.gatewayUpdated', { label })
          : t('provider.toast.gatewayAlready', { label }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ kind: 'error', text: t('provider.toast.activateFailed', { error: msg }) })
    } finally {
      setActivating(null)
    }
  }

  async function applyWorkflowPatch() {
    setPatching(true)
    try {
      const res = await window.tachi.aeon.patchWorkflowForOpenGateway(owner)
      if (res.alreadyPatched) {
        showToast({ kind: 'info', text: t('provider.toast.patchAlready') })
      } else {
        showToast({ kind: 'success', text: t('provider.toast.patched') })
      }
      setPatched(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ kind: 'error', text: t('provider.toast.patchFailed', { error: msg }) })
    } finally {
      setPatching(false)
    }
  }

  async function revertWorkflowPatch() {
    setPatching(true)
    try {
      await window.tachi.aeon.unpatchWorkflowForOpenGateway(owner)
      showToast({ kind: 'success', text: t('provider.toast.reverted') })
      setPatched(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ kind: 'error', text: t('provider.toast.revertFailed', { error: msg }) })
    } finally {
      setPatching(false)
    }
  }

  async function pushFromLocal(row: RowConfig) {
    setPushing(row.provider)
    try {
      await window.tachi.aeon.pushLocalProviderSecret(owner, row.provider)
      setPushedThisSession(s => ({ ...s, [row.provider]: true }))
      showToast({ kind: 'success', text: t('provider.toast.pushedLocal', { label: t(`provider.rows.${row.provider}.label`), owner }) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ kind: 'error', text: t('provider.toast.pushFailed', { error: msg }) })
    } finally {
      setPushing(null)
    }
  }

  async function saveExplicit(row: RowConfig, key: string) {
    await window.tachi.aeon.setSecret(owner, row.secretName, key)
    setPushedThisSession(s => ({ ...s, [row.provider]: true }))
    showToast({ kind: 'success', text: t('provider.toast.savedExplicit', { label: t(`provider.rows.${row.provider}.label`), secretName: row.secretName, owner }) })
  }

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>{t('provider.header')}</div>

      <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)', borderBottom: 'var(--border-width) solid var(--border)', lineHeight: 1.5 }}>
        {t('provider.intro.before')} <strong style={{ color: 'var(--text-primary)' }}>{owner}/aeon</strong> {t('provider.intro.after')}
      </div>

      {/* OpenGateway workflow-patch banner */}
      <div style={{
        padding: '8px 12px',
        borderBottom: 'var(--border-width) solid var(--border)',
        background: 'var(--bg-inset)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
          }}>{t('provider.patch.title')}</span>
          {patched === true && (
            <span style={{
              fontSize: 9,
              color: 'var(--success)',
              fontFamily: 'JetBrains Mono, monospace',
              border: 'var(--border-width) solid var(--success)',
              padding: '1px 5px',
              letterSpacing: '0.06em',
            }}>{t('provider.patch.applied')}</span>
          )}
          {patched === false && (
            <span style={{
              fontSize: 9,
              color: 'var(--warning, #f59e0b)',
              fontFamily: 'JetBrains Mono, monospace',
              border: 'var(--border-width) solid var(--warning, #f59e0b)',
              padding: '1px 5px',
              letterSpacing: '0.06em',
            }}>{t('provider.patch.notApplied')}</span>
          )}
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>
          {t('provider.patch.body.part1')} <code style={{ fontFamily: 'inherit' }}>ANTHROPIC_BASE_URL</code> {t('provider.patch.body.part2')} <code style={{ fontFamily: 'inherit' }}>ANTHROPIC_AUTH_TOKEN</code>{t('provider.patch.body.part3')} <code style={{ fontFamily: 'inherit' }}>env:</code> {t('provider.patch.body.part4')}
        </p>
        <div style={{ display: 'flex', gap: 6 }}>
          {patched !== true && (
            <button
              onClick={applyWorkflowPatch}
              disabled={patching || patched === null}
              style={{ ...saveBtnStyle, opacity: patching ? 0.6 : 1 }}
            >
              {patching ? t('provider.patch.applying') : t('provider.patch.applyButton')}
            </button>
          )}
          {patched === true && (
            <button
              onClick={revertWorkflowPatch}
              disabled={patching}
              style={{
                padding: '6px 10px',
                border: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                fontWeight: 700,
                cursor: patching ? 'default' : 'pointer',
                letterSpacing: '0.04em',
                opacity: patching ? 0.6 : 1,
              }}
            >{patching ? t('provider.patch.reverting') : t('provider.patch.revertButton')}</button>
          )}
        </div>
      </div>

      {ROWS.map(row => {
        const hasLocal     = localKeys.includes(row.provider)
        const showExplicit = explicit[row.provider] || (!hasLocal && !pushedThisSession[row.provider])
        const isPushing    = pushing === row.provider
        const isActive     = gateway === row.activates
        const isActivating = activating === row.activates

        return (
          <div key={row.provider} style={rowStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={labelStyle}>{t(`provider.rows.${row.provider}.label`)}</span>
              {hasLocal && (
                <span style={{
                  fontSize: 9,
                  color: 'var(--accent)',
                  fontFamily: 'JetBrains Mono, monospace',
                  border: 'var(--border-width) solid var(--accent)',
                  padding: '1px 5px',
                  letterSpacing: '0.06em',
                }}>{t('provider.localBadge')}</span>
              )}
              {pushedThisSession[row.provider] && (
                <span style={{
                  fontSize: 9,
                  color: 'var(--success)',
                  fontFamily: 'JetBrains Mono, monospace',
                  border: 'var(--border-width) solid var(--success)',
                  padding: '1px 5px',
                  letterSpacing: '0.06em',
                }}>{t('provider.pushedBadge')}</span>
              )}
              {isActive && (
                <span
                  title={t('provider.activeGatewayTitle', { mode: row.activates })}
                  style={{
                    fontSize: 9,
                    color: 'var(--success)',
                    fontFamily: 'JetBrains Mono, monospace',
                    border: 'var(--border-width) solid var(--success)',
                    background: 'var(--bg-inset)',
                    padding: '1px 5px',
                    letterSpacing: '0.06em',
                  }}>{t('provider.activeGatewayBadge')}</span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>{t(`provider.rows.${row.provider}.description`)}</p>
            <div style={{
              fontSize: 9,
              color: 'var(--text-dim)',
              letterSpacing: '0.04em',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              {t('provider.ghSecret')} <code style={{ fontFamily: 'inherit', color: 'var(--text-primary)' }}>{row.secretName}</code>
            </div>
            {row.warning && (
              <div style={{
                padding: '4px 6px',
                border: 'var(--border-width) solid var(--warning, #f59e0b)',
                background: 'var(--bg-inset)',
                fontSize: 10,
                color: 'var(--warning, #f59e0b)',
                lineHeight: 1.4,
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                ⚠ {row.warning}
              </div>
            )}

            {!showExplicit && hasLocal && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => pushFromLocal(row)}
                  disabled={isPushing}
                  style={{ ...saveBtnStyle, opacity: isPushing ? 0.6 : 1 }}
                >
                  {isPushing ? t('provider.pushing') : t('provider.pushLocalButton', { label: t(`provider.rows.${row.provider}.label`) })}
                </button>
                <button
                  onClick={() => setExplicit(s => ({ ...s, [row.provider]: true }))}
                  style={{
                    padding: '6px 10px',
                    border: 'var(--border-width) solid var(--border)',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-muted)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                    letterSpacing: '0.04em',
                  }}
                >{t('provider.useDifferentKey')}</button>
              </div>
            )}

            {showExplicit && (
              <ExplicitInput row={row} onSave={(k) => saveExplicit(row, k)} />
            )}

            {/* Activate-in-aeon.yml button. Only shown when this row is NOT
                already the active gateway — clicking sets gateway.provider so
                the workflow routes through this provider on the next dispatch. */}
            {!isActive && (
              <button
                onClick={() => activateGateway(row.activates, t(`provider.rows.${row.provider}.label`))}
                disabled={isActivating || gateway === null}
                title={t('provider.activateTitle', { mode: row.activates })}
                style={{
                  alignSelf: 'flex-start',
                  padding: '5px 9px',
                  border: 'var(--border-width) solid var(--border)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: isActivating || gateway === null ? 'default' : 'pointer',
                  letterSpacing: '0.04em',
                  opacity: isActivating || gateway === null ? 0.6 : 1,
                }}
              >
                {isActivating
                  ? t('provider.activating')
                  : t('provider.activateButton', { label: t(`provider.rows.${row.provider}.label`), mode: row.activates })}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ExplicitInput({ row, onSave }: { row: RowConfig; onSave: (key: string) => Promise<void> }) {
  const { t } = useTranslation('aeon')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!key.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave(key.trim())
      setKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="password"
          style={inputStyle}
          placeholder={row.placeholder}
          value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        />
        <button
          style={{ ...saveBtnStyle, opacity: saving || !key.trim() ? 0.6 : 1 }}
          disabled={saving || !key.trim()}
          onClick={handleSave}
        >
          {saving ? '…' : t('provider.push')}
        </button>
      </div>
      {error && (
        <span style={{ fontSize: 10, color: 'var(--danger)', fontFamily: 'JetBrains Mono, monospace' }}>{error}</span>
      )}
    </>
  )
}
