// apps/desktop/src/pages/studio/StudioPage.tsx
//
// Real-data dashboard for tachi.  6 cards:
//   1. System info — CPU/RAM/disk/OS/Electron versions, app uptime
//   2. Sidecars   — live state of all 4 child processes
//   3. Providers  — what's configured (keys + OAuth)
//   4. Runtimes   — detected harnesses (OpenClaude, Codex, Ollama, etc.)
//   5. Conversations — local chat counts + total messages
//   6. Aeon       — GitHub auth + fork status
//
// All data is live and refreshed every 3s while the page is visible.

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useRuntimeStore } from '../../store/runtime.store'
import { useChatStore } from '../../store/chat.store'
import { useWorkflowStore } from '../../store/workflow.store'
import { PageTopbar } from '../../components/layout/PageTopbar'
import { NetworkAuditCard } from './NetworkAuditCard'
import { showToast } from '../../components/Toaster'
import {
  sortByStatus,
  filterDisplayableRuntimes,
  resolveLaunchUrl,
  resolveInAppRoute,
  actionLabel,
  runtimeNote,
} from './runtime-display'
import type { SystemInfo, SidecarInfo, AeonGhStatus } from '../../types/electron'
import { modelDisplayName } from '../../utils/model-display'
import { useVisibilityGatedInterval } from '../../hooks/useVisibilityGatedInterval'

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtBytes(mb: number | undefined | null): string {
  if (mb == null) return '—'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

function fmtPercent(used: number, total: number): string {
  if (!total) return '—'
  return `${Math.round((used / total) * 100)}%`
}

// ── tokens for status colors ────────────────────────────────────────────────

const STATE_COLOR: Record<string, string> = {
  running:        'var(--success)',
  healthy:        'var(--success)',
  connected:      'var(--success)',
  installed:      'var(--accent)',   // detected & ready to invoke (CLI tools)
  starting:       'var(--warning)',
  stopped:        'var(--text-dim)',
  not_installed:  'var(--text-dim)',
  error:          'var(--danger)',
  unreachable:    'var(--danger)',
}

const STATE_LABEL: Record<string, string> = {
  running:        'RUNNING',
  healthy:        'HEALTHY',
  connected:      'CONNECTED',
  installed:      'READY',
  starting:       'STARTING',
  stopped:        'STOPPED',
  not_installed:  'NOT INSTALLED',
  error:          'ERROR',
  unreachable:    'UNREACHABLE',
}

// ── Reusable card shell ─────────────────────────────────────────────────────

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-surface)',
      boxShadow: 'var(--shadow-hard)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
    }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: 'var(--border-width) solid var(--border)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.1em',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ flex: 1 }}>{title}</span>
        {action}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {children}
      </div>
    </div>
  )
}

function KV({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', gap: 8 }}>
      <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>{k}</span>
      <span style={{
        fontSize: 11,
        color: 'var(--text-primary)',
        fontFamily: mono ? 'JetBrains Mono, monospace' : undefined,
        textAlign: 'right',
        maxWidth: '60%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>{v}</span>
    </div>
  )
}

// ── Bar component for memory/disk usage ────────────────────────────────────

function Bar({ pct, label, color = 'var(--accent)' }: { pct: number; label?: string; color?: string }) {
  const safePct = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ padding: '4px 12px' }}>
      {label && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
          {/* Long labels (e.g. the disk row) ellipsize with a tooltip instead of clipping */}
          <span title={label} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <span style={{ flexShrink: 0 }}>{safePct.toFixed(0)}%</span>
        </div>
      )}
      <div style={{ height: 6, background: 'var(--bg-inset)', border: 'var(--border-width) solid var(--border)' }}>
        <div style={{ height: '100%', width: `${safePct}%`, background: color, transition: 'width 600ms ease-out' }} />
      </div>
    </div>
  )
}

// ── Card 1: System info ─────────────────────────────────────────────────────

function SystemInfoCard({ info }: { info: SystemInfo | null }) {
  const { t } = useTranslation('studio')
  if (!info) {
    return <Card title={t('system.title')}><div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>{t('common.loading')}</div></Card>
  }
  const memUsedPct = (info.totalMemMB - info.freeMemMB) / info.totalMemMB * 100
  const diskUsedPct = info.diskTotalGB && info.diskFreeGB != null
    ? (info.diskTotalGB - info.diskFreeGB) / info.diskTotalGB * 100
    : 0
  return (
    <Card title={t('system.title')} action={<span style={{ color: 'var(--success)', fontSize: 9 }}>{t('system.live')}</span>}>
      <KV k={t('system.os')}        v={`${info.platform} ${info.arch}`} />
      <KV k={t('system.release')}   v={info.osRelease} />
      <KV k={t('system.host')}      v={info.hostname} />
      <KV k={t('system.cpu')}       v={`${info.cpuModel} (${t('system.cores', { count: info.cpuCount })})`} />
      <KV k={t('system.app')}       v={`tachi ${info.appVersion}`} />
      <KV k={t('system.electron')}  v={info.electronVersion} />
      <KV k={t('system.node')}      v={info.nodeVersion} />
      <KV k={t('system.appUptime')} v={fmtUptime(info.appUptimeSec)} />
      <Bar pct={memUsedPct} label={`${t('system.ram')} ${fmtBytes(info.totalMemMB - info.freeMemMB)} / ${fmtBytes(info.totalMemMB)}`} />
      <Bar pct={diskUsedPct} label={`${t('system.disk')} ${info.diskTotalGB != null && info.diskFreeGB != null ? `${(info.diskTotalGB - info.diskFreeGB).toFixed(1)} / ${info.diskTotalGB} GB` : '—'}`} color="var(--accent-alt)" />
      <Bar pct={(info.appMemMB / info.totalMemMB) * 100} label={t('system.tachiProcess', { size: fmtBytes(info.appMemMB) })} color="var(--warning)" />
    </Card>
  )
}

// ── Card 2: Sidecars ────────────────────────────────────────────────────────

function SidecarsCard({ sidecars, onShowLogs }: { sidecars: SidecarInfo[]; onShowLogs: (id: SidecarInfo['id']) => void }) {
  const { t } = useTranslation('studio')
  // Reorder: running ones first so the user sees what's alive without scrolling.
  // SidecarInfo uses `state` instead of `status` — adapt the comparator.
  const ordered = [...sidecars].sort((a, b) => {
    const order = (st: string): number => {
      if (st === 'running') return 0
      if (st === 'starting') return 1
      if (st === 'stopped') return 2
      return 3 // error / unknown last
    }
    return order(a.state) - order(b.state)
  })
  return (
    <Card title={t('sidecars.title')} action={<span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{t('sidecars.upCount', { up: sidecars.filter(s => s.state === 'running').length, total: sidecars.length })}</span>}>
      {sidecars.length === 0 && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>{t('sidecars.none')}</div>
      )}
      {ordered.map(s => {
        const color = STATE_COLOR[s.state] ?? 'var(--text-dim)'
        const isRunning = s.state === 'running'
        return (
          <div key={s.id} style={{
            padding: '6px 12px',
            borderBottom: 'var(--border-width) solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span
              className={s.state === 'starting' ? 'tachi-pulse-dot' : undefined}
              style={{ width: 8, height: 8, background: color, flexShrink: 0 }}
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>{s.id}</span>
              <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                {isRunning
                  ? `pid ${s.pid} · :${s.port} · up ${fmtUptime(Math.round((s.uptimeMs ?? 0) / 1000))}`
                  : (s.error ? s.error.slice(0, 60) : s.state)}
              </span>
            </div>
            <span style={{
              fontSize: 9,
              color,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 700,
            }}>{s.state}</span>
            <button
              onClick={() => onShowLogs(s.id)}
              title={t('sidecars.viewLogTail')}
              style={{
                padding: '2px 6px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9,
                fontWeight: 700,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >{t('sidecars.logs')}</button>
            <button
              onClick={() => {
                const p = isRunning ? window.tachi.sidecar.stop(s.id) : window.tachi.sidecar.start(s.id)
                Promise.resolve(p).catch((e) => showToast({ kind: 'error', text: t(isRunning ? 'sidecars.stopFailed' : 'sidecars.startFailed', { error: e instanceof Error ? e.message : String(e) }) }))
              }}
              style={{
                padding: '2px 8px',
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: isRunning ? 'var(--danger)' : 'var(--accent)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9,
                fontWeight: 700,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >{isRunning ? t('sidecars.stop') : t('sidecars.start')}</button>
          </div>
        )
      })}
    </Card>
  )
}

// ── Sidecar logs modal ──────────────────────────────────────────────────────

function LogsModal({ sidecarId, onClose }: { sidecarId: SidecarInfo['id'] | null; onClose: () => void }) {
  const { t } = useTranslation('studio')
  const [lines, setLines] = useState<string[]>([])
  const [available, setAvailable] = useState<boolean>(true)
  const [path, setPath] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!sidecarId) return
    let cancelled = false
    const tick = () => {
      window.tachi.sidecar.logs(sidecarId, 300)
        .then(res => {
          if (cancelled) return
          setAvailable(res.available)
          setLines(res.lines)
          setPath(res.path)
        })
        .catch(() => {/* swallow */})
    }
    tick()
    const id = window.setInterval(tick, 2_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [sidecarId])

  if (!sidecarId) return null

  return (
    <div
      role="dialog"
      aria-label={t('logs.ariaLabel', { id: sidecarId })}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(900px, 94vw)',
          height: 'min(620px, 80vh)',
          background: 'var(--bg-surface)',
          border: '2px solid var(--border)',
          boxShadow: 'var(--shadow-hard)',
          display: 'flex', flexDirection: 'column',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <div style={{
          padding: '6px 12px',
          borderBottom: '2px solid var(--border)',
          fontSize: 9, color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.12em',
          display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-elevated)',
        }}>
          <span style={{ color: 'var(--accent)' }}>▶</span>
          <span>{t('logs.header', { id: sidecarId })}</span>
          {path && <span style={{ color: 'var(--text-dim)', textTransform: 'none', fontSize: 9, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>}
          <span style={{ color: 'var(--success)', fontSize: 9 }}>{t('logs.live')}</span>
          <button onClick={onClose} style={{
            padding: '2px 8px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10, fontWeight: 700, cursor: 'pointer',
            textTransform: 'uppercase',
          }}>{t('logs.close')}</button>
        </div>
        <div style={{
          flex: 1, overflow: 'auto', background: '#0a0a0a',
          padding: 12, fontSize: 11, color: '#cfe3cf',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {!available && (
            <div style={{ color: 'var(--text-dim)' }}>{t('logs.noFile')}</div>
          )}
          {available && lines.length === 0 && (
            <div style={{ color: 'var(--text-dim)' }}>{t('logs.empty')}</div>
          )}
          {available && lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Card 3: Providers ──────────────────────────────────────────────────────

const PROVIDER_LABEL: Record<string, string> = {
  'opengateway':         'OpenGateway (gitlawb)',
  'anthropic-oauth-access': 'Anthropic Pro (OAuth)',
  'openrouter-oauth':    'OpenRouter (OAuth)',
  'google':              'Google AI',
  'groq':                'Groq',
  'cerebras':            'Cerebras',
  'sambanova':           'SambaNova',
  'mistral':             'Mistral',
  'openrouter':          'OpenRouter',
  'github':              'GitHub Models',
  'cloudflare':          'Cloudflare Workers AI',
  'cohere':              'Cohere',
  'zai':                 'Z.AI',
  'nvidia':              'NVIDIA NIM',
  'brave-search':        'Brave Search',
  'tavily':              'Tavily',
}

// ── Card: Harnesses → effective provider mapping ───────────────────────────

function HarnessesCard({ sidecars, keys }: { sidecars: SidecarInfo[]; keys: string[] }) {
  const { t } = useTranslation('studio')
  const freeRunning      = sidecars.find(s => s.id === 'freellmapi')?.state === 'running'
  const openclaudeRun    = sidecars.find(s => s.id === 'openclaude')?.state === 'running'
  const fccRunning       = sidecars.find(s => s.id === 'freeclaudecode')?.state === 'running'
  const hasOpenGateway   = keys.includes('opengateway')
  const hasAnthropicOAuth = keys.includes('anthropic-oauth-access')

  const rows: Array<{ harness: string; provider: string; model: string; ok: boolean; note?: string }> = [
    {
      harness: 'OpenClaude',
      provider: hasOpenGateway ? 'OpenGateway' : (freeRunning ? t('harnesses.provider.freellmLocal') : '—'),
      model: hasOpenGateway ? 'nemotron-3-ultra :free' : 'auto',
      ok: openclaudeRun && (hasOpenGateway || freeRunning),
      note: openclaudeRun ? undefined : t('harnesses.note.sidecarStopped'),
    },
    {
      harness: 'free-claude-code',
      provider: 'Anthropic Messages API',
      model: 'claude-3-5-sonnet',
      ok: fccRunning,
      note: fccRunning ? undefined : t('harnesses.note.sidecarStopped'),
    },
    {
      harness: t('harnesses.harness.directChat'),
      provider: hasAnthropicOAuth ? t('harnesses.provider.anthropicOAuth') : (hasOpenGateway ? 'OpenGateway' : 'FreeLLM'),
      model: hasAnthropicOAuth ? 'claude-3-5-sonnet' : (hasOpenGateway ? 'nemotron-3-ultra :free' : 'auto'),
      ok: true,
    },
  ]

  return (
    <Card title={t('harnesses.title')}>
      <div style={{
        padding: '4px 12px',
        fontSize: 9,
        color: 'var(--text-dim)',
        background: 'var(--bg-inset)',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        fontWeight: 700,
        borderBottom: 'var(--border-width) solid var(--border)',
      }}>{t('harnesses.activeRouting')}</div>
      {rows.map(r => (
        <div key={r.harness} style={{
          padding: '6px 12px',
          borderBottom: 'var(--border-width) solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 6, height: 6, background: r.ok ? 'var(--success)' : 'var(--text-dim)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>{r.harness}</span>
            <span style={{ fontSize: 9, color: r.ok ? 'var(--success)' : 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
              {r.ok ? t('harnesses.ready') : t('harnesses.idle')}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--text-muted)', paddingLeft: 14 }}>
            <span>→ {r.provider}</span>
            <span style={{ color: 'var(--text-dim)' }}>·</span>
            <span style={{ color: 'var(--accent)' }} title={r.model}>{modelDisplayName(r.model)}</span>
            {r.note && <span style={{ color: 'var(--warning)' }}>· {r.note}</span>}
          </div>
        </div>
      ))}
    </Card>
  )
}

function ProvidersCard({ keys }: { keys: string[] }) {
  const { t } = useTranslation('studio')
  const tiers = [
    {
      label: t('providers.tier.oauthPro'),
      ids:   ['anthropic-oauth-access', 'openrouter-oauth', 'opengateway'].filter(k => keys.includes(k)),
    },
    {
      label: t('providers.tier.free'),
      ids:   ['google', 'groq', 'cerebras', 'sambanova', 'mistral', 'openrouter', 'github', 'cloudflare', 'cohere', 'zai', 'nvidia'].filter(k => keys.includes(k)),
    },
    {
      label: t('providers.tier.tools'),
      ids:   ['brave-search', 'tavily'].filter(k => keys.includes(k)),
    },
  ].filter(tier => tier.ids.length > 0)

  return (
    <Card title={t('providers.title')} action={<span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{t('providers.configured', { count: keys.length })}</span>}>
      {keys.length === 0 && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>
          {t('providers.none')}
        </div>
      )}
      {tiers.map(tier => (
        <div key={tier.label}>
          <div style={{
            padding: '4px 12px',
            fontSize: 8,
            color: 'var(--text-dim)',
            background: 'var(--bg-inset)',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
          }}>{tier.label}</div>
          {tier.ids.map(id => (
            <div key={id} style={{
              padding: '5px 12px',
              borderBottom: 'var(--border-width) solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11,
            }}>
              <span style={{ width: 6, height: 6, background: 'var(--success)', flexShrink: 0 }} />
              <span style={{ flex: 1, color: 'var(--text-primary)' }}>{PROVIDER_LABEL[id] ?? id}</span>
              <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('providers.connected')}</span>
            </div>
          ))}
        </div>
      ))}
      <div style={{ padding: '6px 12px', fontSize: 10, color: 'var(--text-dim)' }}>
        {t('providers.footer')}
      </div>
    </Card>
  )
}

// ── Card 4: Runtimes (detected harnesses) ──────────────────────────────────

function RuntimesCard() {
  const { t } = useTranslation('studio')
  const navigate = useNavigate()
  const rawCards = useRuntimeStore(s => s.cards)
  // Drop what is not on this machine (every 'cloud_gateway' card — this list
  // used to carry bankr-gateway) plus the named exceptions, then sort by status.
  const cards = sortByStatus(filterDisplayableRuntimes(rawCards))

  const onAction = (c: typeof cards[number]) => {
    // Runtimes with embedded dashboards (openclaw) open inside the app;
    // everything else falls back to the system browser via the shell
    // allowlist. Match the Sidebar's runtime-row behaviour.
    const inAppRoute = resolveInAppRoute(c)
    if (inAppRoute) { navigate(inAppRoute); return }
    const url = resolveLaunchUrl(c)
    if (url) window.tachi.shell.openExternal(url).catch(() => {/* swallow */})
  }

  return (
    <Card title={t('runtimes.title')} action={
      <button
        onClick={() => window.tachi.runtime.scanAll().catch(() => {/* swallowed */})}
        style={{
          padding: '2px 8px',
          border: '2px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--accent)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9,
          fontWeight: 700,
          cursor: 'pointer',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >{t('runtimes.rescan')}</button>
    }>
      {cards.length === 0 && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>{t('runtimes.scanning')}</div>
      )}
      {cards.map(c => {
        const color = STATE_COLOR[c.status] ?? 'var(--text-dim)'
        const label = STATE_LABEL[c.status]
          ? t(`runtimes.state.${c.status}`, STATE_LABEL[c.status])
          : c.status.toUpperCase()
        const url   = resolveLaunchUrl(c)
        const btnLabel = actionLabel(c)
        // Only show a clickable action when we actually have a URL to open.
        const showAction = !!url
        // The detector's reason for this status (e.g. a 429/5xx explanation on
        // a Bankr 'unknown' card). Colored the same as the status dot/label —
        // neutral when the status itself has no strong color (STATE_COLOR
        // falls back to text-dim), and it inherits red automatically for a
        // genuine error/unreachable card, with no per-runtime special-casing.
        const note  = runtimeNote(c)
        return (
          <div key={c.runtimeId} style={{
            padding: '5px 12px',
            borderBottom: 'var(--border-width) solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{ width: 6, height: 6, background: color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{
                fontSize: 11,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{c.displayName ?? c.runtimeId}</span>
              {note && (
                // Truncated to one line with the full text on hover (same
                // affordance as the Bar component's label above) rather than a
                // hard character-count cut with no way to read the rest.
                <span title={note} style={{
                  fontSize: 9,
                  color,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{note}</span>
              )}
            </div>
            {c.version && <span style={{ fontSize: 9, color: 'var(--text-dim)', flexShrink: 0 }}>v{c.version}</span>}
            <span style={{ fontSize: 9, color, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{label}</span>
            {showAction && (
              <button
                onClick={() => onAction(c)}
                title={url ?? undefined}
                style={{
                  padding: '2px 6px',
                  border: '2px solid var(--border)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--accent)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9,
                  fontWeight: 700,
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >{btnLabel}</button>
            )}
          </div>
        )
      })}
    </Card>
  )
}

// ── Card 5: Conversations ──────────────────────────────────────────────────

function ConversationsCard() {
  const { t } = useTranslation('studio')
  const conversations = useChatStore(s => s.conversations)
  const total = conversations.reduce((sum, c) => sum + c.messages.length, 0)
  const userMsgs = conversations.reduce((sum, c) => sum + c.messages.filter(m => m.role === 'user').length, 0)
  const aiMsgs   = total - userMsgs
  const tokens = conversations.reduce((sum, c) =>
    sum + c.messages.reduce((s, m) => s + (m.usage?.totalTokens ?? 0), 0),
  0)
  const providerCounts = new Map<string, number>()
  for (const c of conversations) providerCounts.set(c.providerId, (providerCounts.get(c.providerId) ?? 0) + 1)

  return (
    <Card title={t('conversations.title')}>
      <KV k={t('conversations.total')}        v={conversations.length} />
      <KV k={t('conversations.messages')}     v={total} />
      <KV k={t('conversations.youWrote')}     v={userMsgs} />
      <KV k={t('conversations.modelWrote')}   v={aiMsgs} />
      <KV k={t('conversations.tokensUsed')}   v={tokens.toLocaleString()} />
      <div style={{ padding: '4px 12px', borderTop: 'var(--border-width) solid var(--border)', marginTop: 4 }}>
        <div style={{ fontSize: 8, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 4 }}>{t('conversations.byProvider')}</div>
        {[...providerCounts.entries()].map(([prov, n]) => (
          <div key={prov} style={{ display: 'flex', fontSize: 10, padding: '2px 0' }}>
            <span style={{ flex: 1, color: 'var(--text-muted)' }}>{prov}</span>
            <span style={{ color: 'var(--accent)' }}>{n}</span>
          </div>
        ))}
        {providerCounts.size === 0 && (
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('conversations.none')}</div>
        )}
      </div>
    </Card>
  )
}

// ── Card 7: Workflow canvas (node-graph builder) ───────────────────────────

function WorkflowCard() {
  const { t } = useTranslation('studio')
  const navigate = useNavigate()
  const nodes = useWorkflowStore(s => s.nodes)
  const edges = useWorkflowStore(s => s.edges)

  return (
    <Card title={t('workflow.title')} action={
      <button
        onClick={() => navigate('/nodes')}
        style={{
          padding: '2px 8px',
          border: '2px solid var(--accent)',
          background: 'var(--accent-muted)',
          color: 'var(--accent-text)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9,
          fontWeight: 700,
          cursor: 'pointer',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >{t('workflow.open')}</button>
    }>
      <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {t('workflow.description')}
      </div>
      <KV k="Nodes"   v={nodes.length} />
      <KV k={t('workflow.edges')}   v={edges.length} />
      <KV k={t('workflow.inputs')}   v={nodes.filter(n => n.kind === 'input').length} />
      <KV k={t('workflow.providers')} v={nodes.filter(n => n.kind === 'provider').length} />
      <KV k="Agents"  v={nodes.filter(n => n.kind === 'agent').length} />
      <KV k={t('workflow.outputs')} v={nodes.filter(n => n.kind === 'output').length} />
    </Card>
  )
}

// ── Card 6: Aeon (GitHub) ──────────────────────────────────────────────────

function AeonCard() {
  const { t } = useTranslation('studio')
  const [status, setStatus] = useState<AeonGhStatus | null>(null)
  // WORST OFFENDER FOUND BY LANE V, and it was not a local cost: ghStatus() is
  // a live `fetch('https://api.github.com/user')` whenever a token is stored,
  // and this card fired it every 10 SECONDS for as long as the dashboard was
  // open — 360 GitHub API calls an hour, ~7% of the user's 5000/hr REST budget
  // spent on a read-only "signed in as @you" line, plus a network round-trip
  // every ten seconds on a window that may be minimised.
  //
  // A GitHub auth state does not change on a ten-second cadence: it changes when
  // the user signs in or out, on a surface that is not this card. 60s + the
  // visibility gate (which catches up the moment the window is restored) keeps
  // the readout honest at 1/6th the calls and none at all while hidden.
  useVisibilityGatedInterval(() => {
    window.tachi.aeon.ghStatus().then(setStatus).catch(() => setStatus(null))
  }, 60_000)

  return (
    <Card title="Aeon · GitHub">
      {!status && <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>{t('common.loading')}</div>}
      {status && (
        <>
          <KV k={t('aeon.auth')}       v={status.authenticated ? <span style={{ color: 'var(--success)' }}>{t('aeon.signedIn')}</span> : <span style={{ color: 'var(--text-dim)' }}>{t('aeon.notSignedIn')}</span>} />
          {status.username  && <KV k={t('aeon.user')}      v={`@${status.username}`} />}
          {status.ghVersion && <KV k={t('aeon.ghClient')} v={status.ghVersion} />}
          {!status.authenticated && (
            <div style={{ padding: 12, fontSize: 10, color: 'var(--text-dim)' }}>
              {t('aeon.signInPrompt')} <strong>{t('aeon.signInButton')}</strong>.
            </div>
          )}
        </>
      )}
    </Card>
  )
}

// ── Card: Doctor — execute-probe every external binary ──────────────────────
// STEAL 2026-07-07 (Agent-Reach): "installed" flags only prove a file exists;
// the doctor actually RUNS each binary, so mangled paths / missing DLLs /
// dead binaries show up as broken instead of silently green.

type DoctorEntry = { id: string; label: string; status: 'ok' | 'missing' | 'broken' | 'timeout' | 'error'; path?: string; detail: string; ms: number }

const DOCTOR_STATUS_COLOR: Record<DoctorEntry['status'], string> = {
  ok:      'var(--success, #16a34a)',
  missing: 'var(--text-dim)',
  broken:  'var(--destructive)',
  timeout: '#d97706',
  error:   'var(--destructive)',
}

function DoctorCard() {
  const { t } = useTranslation('studio')
  const [entries, setEntries] = useState<DoctorEntry[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState('')

  const run = async () => {
    setRunning(true)
    setError('')
    try {
      const res = await window.tachi.doctor.run()
      if (res.ok && res.entries) setEntries(res.entries as DoctorEntry[])
      else setError(res.error ?? 'doctor failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card
      title={t('doctor.title')}
      action={
        <button
          data-testid="doctor-run"
          onClick={run}
          disabled={running}
          style={{
            fontSize: 9, fontWeight: 700, padding: '3px 10px',
            border: 'var(--border-width) solid var(--border)',
            background: running ? 'transparent' : 'var(--accent)',
            color: running ? 'var(--text-muted)' : '#fff',
            cursor: running ? 'default' : 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.08em',
          }}
        >{running ? t('doctor.running') : t('doctor.run')}</button>
      }
    >
      {!entries && !error && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>{t('doctor.hint')}</div>
      )}
      {error && <div style={{ padding: 12, color: 'var(--destructive)', fontSize: 11 }}>{error}</div>}
      {entries?.map(e => (
        <div
          key={e.id}
          data-testid={`doctor-row-${e.id}`}
          title={e.path ?? ''}
          style={{
            display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 12px',
            borderTop: '1px solid var(--border)', fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          <span style={{ fontWeight: 700, minWidth: 62, textTransform: 'uppercase', color: DOCTOR_STATUS_COLOR[e.status] }}>
            {t(`doctor.status.${e.status}`)}
          </span>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{e.label}</span>
          <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {e.detail}
          </span>
          <span style={{ color: 'var(--text-dim)' }}>{e.ms}ms</span>
        </div>
      ))}
    </Card>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────

export function StudioPage() {
  const { t } = useTranslation('studio')
  const [systemInfo,  setSystemInfo]  = useState<SystemInfo | null>(null)
  const [sidecars,    setSidecars]    = useState<SidecarInfo[]>([])
  const [providerKeys, setProviderKeys] = useState<string[]>([])
  const [logsId, setLogsId] = useState<SidecarInfo['id'] | null>(null)

  // Initial scan + subscriptions
  useEffect(() => {
    const unsub = window.tachi.runtime.onUpdate((card: unknown) => {
      useRuntimeStore.getState().updateCard(card as import('@tachi/core').RuntimeCardUpdate)
    })
    window.tachi.runtime.scanAll().catch((err) => console.warn('[studio] runtime scan failed:', err))
    return unsub
  }, [])

  // Live polling: system info + sidecars + provider keys every 3s.
  //
  // Visibility-gated (lane V): three IPC round-trips every 3s, and `system.info`
  // is not free in main — it runs `statfsSync` on the userData volume plus a
  // networkInterfaces() walk on every call. A minimised dashboard was paying
  // that ~1200 times an hour to update numbers nobody could see. The hook
  // catches up the instant the window is restored, so the readout is fresh
  // before the first frame the user actually looks at.
  useVisibilityGatedInterval(() => {
    window.tachi.system.info().then(setSystemInfo).catch(() => {/* main may be restarting */})
    window.tachi.sidecar.list().then(s => setSidecars(s as SidecarInfo[])).catch(() => {/* swallow */})
    window.tachi.settings.listKeys().then(setProviderKeys).catch(() => {/* swallow */})
  }, 3_000)

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-base)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <PageTopbar section="Dashboard" badge={t('topbar.badge')} />

      <div style={{
        flex: 1,
        padding: 12,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gridAutoRows: 'minmax(280px, auto)',
        gap: 12,
        // Reserve the scrollbar gutter up-front: cards start as short "loading"
        // shells, then grow when the first 3s poll lands — without a stable
        // gutter the scrollbar pops in at that moment and the whole grid
        // reflows sideways (the transient jump seen on mount).
        overflowY: 'auto',
        overflowX: 'hidden',
        scrollbarGutter: 'stable',
        minHeight: 0,
      }}>
        <SystemInfoCard info={systemInfo} />
        <SidecarsCard   sidecars={sidecars} onShowLogs={setLogsId} />
        <DoctorCard />
        <HarnessesCard  sidecars={sidecars} keys={providerKeys} />
        <ProvidersCard  keys={providerKeys} />
        <RuntimesCard />
        <ConversationsCard />
        <AeonCard />
        <NetworkAuditCard />
      </div>
      <LogsModal sidecarId={logsId} onClose={() => setLogsId(null)} />
    </div>
  )
}
