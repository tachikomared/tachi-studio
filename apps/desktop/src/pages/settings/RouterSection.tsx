import React from 'react'
import { useTranslation } from 'react-i18next'
import type { RouterConfig } from '../../types/electron'

// ─── Shared style helpers ─────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const btnBase: React.CSSProperties = {
  ...mono,
  fontSize: 9, fontWeight: 700,
  padding: '5px 12px',
  border: 'var(--border-width, 2px) solid var(--border)',
  background: 'var(--accent)', color: '#fff',
  boxShadow: 'var(--shadow-hard)',
  cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '0.08em',
}

const btnSecondary: React.CSSProperties = {
  ...btnBase,
  background: 'var(--bg-elevated)', color: 'var(--text-primary)',
}

const btnDanger: React.CSSProperties = {
  ...btnBase,
  background: 'transparent',
  border: 'var(--border-width, 2px) solid var(--danger)',
  color: 'var(--danger)',
  boxShadow: 'none',
}

// ─── Status dot ───────────────────────────────────────────────────────────────

type RunState = 'stopped' | 'starting' | 'running' | 'error'

function StatusDot({ state }: { state: RunState }) {
  const color =
    state === 'running'  ? 'var(--success)' :
    state === 'starting' ? 'var(--warning)' :
    state === 'error'    ? 'var(--danger)'  :
    'var(--text-muted)'

  return (
    <span style={{
      display: 'inline-block',
      width: 8, height: 8,
      borderRadius: 0,
      background: color,
      border: 'var(--border-width, 2px) solid var(--border)',
      flexShrink: 0,
    }} />
  )
}

// ─── RouterSection ────────────────────────────────────────────────────────────

export function RouterSection() {
  const { t } = useTranslation('settings')
  const [installed, setInstalled]   = React.useState<boolean | null>(null)
  const [runState, setRunState]     = React.useState<RunState>('stopped')
  const [config, setConfig]         = React.useState<RouterConfig | null>(null)
  const [configText, setConfigText] = React.useState('')
  const [busy, setBusy]             = React.useState(false)
  const [progress, setProgress]     = React.useState<string | null>(null)
  const [error, setError]           = React.useState<string | null>(null)
  const [saving, setSaving]         = React.useState(false)
  const [seeding, setSeeding]       = React.useState(false)

  // ── Load install status + config on mount ──────────────────────────────────
  React.useEffect(() => {
    window.tachi.claudeCodeRouter.checkInstalled()
      .then(({ installed: i }) => setInstalled(i))
      .catch(() => setInstalled(false))

    window.tachi.claudeCodeRouter.readConfig()
      .then(cfg => {
        if (cfg) {
          setConfig(cfg)
          setConfigText(JSON.stringify(cfg, null, 2))
        }
      })
      .catch(() => {/* no config yet */})

    // Reflect running state from sidecar list
    window.tachi.sidecar.list()
      .then(sidecars => {
        const r = sidecars.find(s => s.id === 'claude-code-router')
        if (r) setRunState(r.state as RunState)
      })
      .catch(() => {/* ignore */})
  }, [])

  // ── Subscribe to install progress ─────────────────────────────────────────
  React.useEffect(() => {
    const off = window.tachi.claudeCodeRouter.onInstallProgress((e) => {
      const evt = e as { step: string; message: string; percent: number }
      setProgress(`${evt.message} (${evt.percent}%)`)
      if (evt.step === 'done') {
        setInstalled(true)
        setProgress(null)
        setBusy(false)
      } else if (evt.step === 'error') {
        setError(evt.message)
        setBusy(false)
        setProgress(null)
      }
    })
    return off
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleInstall = async () => {
    setBusy(true)
    setError(null)
    setProgress(t('router.startingInstall'))
    try {
      await window.tachi.claudeCodeRouter.install()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      setProgress(null)
    }
  }

  const handleStart = async () => {
    setBusy(true)
    setError(null)
    setRunState('starting')
    try {
      await window.tachi.claudeCodeRouter.start()
      setRunState('running')
    } catch (err) {
      setRunState('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.tachi.claudeCodeRouter.stop()
      setRunState('stopped')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveConfig = async () => {
    setSaving(true)
    setError(null)
    try {
      const parsed = JSON.parse(configText) as RouterConfig
      await window.tachi.claudeCodeRouter.writeConfig(parsed)
      setConfig(parsed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSeed = async () => {
    setSeeding(true)
    setError(null)
    try {
      const cfg = await window.tachi.claudeCodeRouter.seedConfig()
      setConfig(cfg)
      setConfigText(JSON.stringify(cfg, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSeeding(false)
    }
  }

  // ── Friendly route builder (pick provider + model from OUR available) ───────
  const providers = config?.Providers ?? []
  const ROUTE_DEFS: { key: string; label: string; hint: string }[] = [
    { key: 'default',     label: t('router.routes.default.label'),     hint: t('router.routes.default.hint') },
    { key: 'background',  label: t('router.routes.background.label'),  hint: t('router.routes.background.hint') },
    { key: 'think',       label: t('router.routes.think.label'),       hint: t('router.routes.think.hint') },
    { key: 'longContext', label: t('router.routes.longContext.label'), hint: t('router.routes.longContext.hint') },
  ]
  const parseRoute = (v: unknown): { name: string; model: string } => {
    if (typeof v !== 'string' || !v) return { name: '', model: '' }
    const i = v.indexOf(',')
    return i < 0 ? { name: v, model: '' } : { name: v.slice(0, i), model: v.slice(i + 1) }
  }
  const applyRoute = (key: string, name: string, model: string) => {
    const next: RouterConfig = {
      ...(config ?? {}),
      Router: { ...(config?.Router ?? {}), [key]: model ? `${name},${model}` : name },
    }
    setConfig(next)
    setConfigText(JSON.stringify(next, null, 2))
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      border: 'var(--border-width, 2px) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      ...mono,
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
      }}>
        <StatusDot state={runState} />
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
          {t('router.heading')}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {runState}
        </span>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
        {t('router.description.before')}{' '}
        <code style={{ fontSize: 9, color: 'var(--accent)' }}>@anthropic-ai/claude-code</code>
        {' '}{t('router.description.after')}{' '}
        <span
          role="button"
          onClick={() => window.tachi.shell.openExternal('https://github.com/musistudio/claude-code-router')}
          style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
        >
          github.com/musistudio/claude-code-router
        </span>
      </div>

      {/* Install / start-stop controls */}
      {installed === null && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{t('router.checking')}</div>
      )}

      {installed === false && (
        <div>
          <button
            onClick={handleInstall}
            disabled={busy}
            style={{ ...btnBase, opacity: busy ? 0.5 : 1 }}
          >
            {busy ? (progress ?? t('router.installing')) : t('router.install')}
          </button>
        </div>
      )}

      {installed === true && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {runState !== 'running' && runState !== 'starting' && (
            <button
              onClick={handleStart}
              disabled={busy}
              style={{ ...btnBase, opacity: busy ? 0.5 : 1 }}
            >
              {busy ? t('router.starting') : t('router.start')}
            </button>
          )}
          {(runState === 'running' || runState === 'starting') && (
            <button
              onClick={handleStop}
              disabled={busy}
              style={{ ...btnDanger, opacity: busy ? 0.5 : 1 }}
            >
              {t('router.stop')}
            </button>
          )}
        </div>
      )}

      {/* Progress indicator */}
      {progress && (
        <div style={{ fontSize: 9, color: 'var(--warning)', marginTop: 6 }}>{progress}</div>
      )}

      {/* Error display */}
      {error && (
        <div style={{ fontSize: 9, color: 'var(--danger)', marginTop: 6 }}>{error}</div>
      )}

      {/* Config editor */}
      {installed === true && (
        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6,
          }}>
            {t('router.configHeading')}
          </div>

          {/* Seed button */}
          <div style={{ marginBottom: 8 }}>
            <button
              onClick={handleSeed}
              disabled={seeding}
              style={{ ...btnSecondary, opacity: seeding ? 0.5 : 1 }}
            >
              {seeding ? t('router.seeding') : t('router.seed')}
            </button>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 8 }}>
              {t('router.seedNote')}
            </span>
          </div>

          {/* Friendly route builder — pick provider + model from OUR available */}
          {providers.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {t('router.routesHeading')}
              </div>
              {ROUTE_DEFS.map(({ key, label, hint }) => {
                const { name, model } = parseRoute(config?.Router?.[key])
                const prov = providers.find(p => p.name === name) ?? providers[0]
                const models = prov?.models ?? []
                const selStyle: React.CSSProperties = {
                  ...mono, fontSize: 9, padding: '3px 4px',
                  border: 'var(--border-width, 2px) solid var(--border)',
                  background: 'var(--bg-base)', color: 'var(--text-primary)', cursor: 'pointer',
                }
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ ...mono, fontSize: 9, width: 96, flexShrink: 0, color: 'var(--text-primary)' }} title={hint}>{label}</span>
                    <select
                      value={name || prov?.name || ''}
                      onChange={e => { const np = providers.find(p => p.name === e.target.value); applyRoute(key, e.target.value, np?.models?.[0] ?? '') }}
                      style={{ ...selStyle, width: 110, flexShrink: 0 }}
                    >
                      {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                    <select
                      value={model}
                      onChange={e => applyRoute(key, name || prov?.name || '', e.target.value)}
                      style={{ ...selStyle, flex: 1, minWidth: 0 }}
                    >
                      <option value="">{t('router.providerDefault')}</option>
                      {models.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )
              })}
              <div style={{ fontSize: 8, color: 'var(--text-muted)', marginTop: 4 }}>
                {t('router.routesHint')}
              </div>
            </div>
          )}

          {/* JSON textarea (advanced) */}
          <textarea
            value={configText || (config ? JSON.stringify(config, null, 2) : '')}
            onChange={e => setConfigText(e.target.value)}
            placeholder={'{\n  "port": 3456,\n  "providers": []\n}'}
            rows={12}
            spellCheck={false}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 10px', fontSize: 9,
              border: 'var(--border-width, 2px) solid var(--border)',
              background: 'var(--bg-base)', color: 'var(--text-primary)',
              resize: 'vertical',
              ...mono,
            }}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              onClick={handleSaveConfig}
              disabled={saving || !configText.trim()}
              style={{ ...btnBase, opacity: (saving || !configText.trim()) ? 0.5 : 1 }}
            >
              {saving ? t('router.saving') : t('router.saveConfig')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
