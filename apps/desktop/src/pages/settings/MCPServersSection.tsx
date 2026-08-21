import React from 'react'
import { useTranslation } from 'react-i18next'
import type { MCPServerInfo, MCPServerConfig, MCPTool } from '../../types/electron'
import { MCPMarketplace } from './MCPMarketplace'

// ─── Style constants ──────────────────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const CARD: React.CSSProperties = {
  ...MONO,
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  boxShadow: 'var(--shadow-hard)',
  padding: 12,
}

const BTN_BASE: React.CSSProperties = {
  ...MONO,
  fontSize: 9,
  fontWeight: 700,
  padding: '4px 10px',
  cursor: 'pointer',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
}

const BTN_PRIMARY: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--accent)',
  color: '#fff',
  border: '2px solid var(--accent)',
  boxShadow: 'var(--shadow-hard)',
}

const BTN_DANGER: React.CSSProperties = {
  ...BTN_BASE,
  color: 'var(--danger)',
  border: '2px solid var(--danger)',
}

const INPUT: React.CSSProperties = {
  ...MONO,
  fontSize: 10,
  padding: '5px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  width: '100%',
  boxSizing: 'border-box' as const,
}

const LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.06em',
  display: 'block',
  marginBottom: 4,
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: MCPServerInfo['status'] }) {
  const color =
    status === 'running'  ? 'var(--success)' :
    status === 'starting' ? 'var(--warning)' :
    status === 'error'    ? 'var(--danger)'  :
    'var(--text-muted)'

  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
    }} />
  )
}

// ─── Tool list row ────────────────────────────────────────────────────────────

function ToolList({ tools }: { tools: MCPTool[] }) {
  const { t } = useTranslation('settings')
  if (tools.length === 0) {
    return (
      <div style={{ fontSize: 9, color: 'var(--text-muted)', paddingLeft: 12, marginTop: 6 }}>
        {t('mcp.noTools')}
      </div>
    )
  }
  return (
    <div style={{ marginTop: 6, paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {tools.map(t => (
        <div key={t.name} style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{t.name}</span>
          {t.description ? ` — ${t.description}` : ''}
        </div>
      ))}
    </div>
  )
}

// ─── Single server row ────────────────────────────────────────────────────────

function ServerRow({
  server,
  onStart,
  onStop,
  onRemove,
  onSetEnabled,
}: {
  server:   MCPServerInfo
  onStart:  (name: string) => void
  onStop:   (name: string) => void
  onRemove: (name: string) => void
  onSetEnabled: (name: string, enabled: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const [expanded, setExpanded] = React.useState(false)
  const [tools, setTools]       = React.useState<MCPTool[] | null>(null)
  const [loadingTools, setLoadingTools] = React.useState(false)

  const toggleExpand = async () => {
    if (!expanded && server.status === 'running' && tools === null) {
      setLoadingTools(true)
      try {
        const result = await window.tachi.mcp.listTools(server.name)
        setTools(result)
      } catch {
        setTools([])
      } finally {
        setLoadingTools(false)
      }
    }
    setExpanded(e => !e)
  }

  React.useEffect(() => {
    if (server.status !== 'running') {
      setTools(null)
      setExpanded(false)
    }
  }, [server.status])

  const busy = server.status === 'starting'

  return (
    <div style={{
      border: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      marginBottom: 6,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
      }}>
        <StatusDot status={server.status} />

        <span style={{ ...MONO, fontSize: 11, fontWeight: 700, flex: 1, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
          {server.name}
        </span>

        {/* Egress class — a network server is refused while PRIVATE MODE is on. */}
        <span
          title={server.requiresNetwork ? t('mcp.market.networkTitle') : t('mcp.market.localOnlyTitle')}
          style={{
            ...MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', padding: '2px 5px',
            border: 'var(--border-width) solid var(--border)',
            background: 'var(--bg-inset)',
            color: server.requiresNetwork ? 'var(--warning)' : 'var(--success)',
            whiteSpace: 'nowrap',
          }}
        >
          {server.requiresNetwork ? t('mcp.market.network') : t('mcp.market.localOnly')}
        </span>

        {server.status === 'running' && (
          <span style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)' }}>
            {t('mcp.toolCount', { count: server.toolCount })}
          </span>
        )}

        {/* ENABLED = reconnect automatically (also at TACHI session start). */}
        <button
          onClick={() => onSetEnabled(server.name, !server.enabled)}
          disabled={busy}
          title={t('mcp.enabledTitle')}
          style={{
            ...BTN_BASE,
            background: server.enabled ? 'var(--accent)' : 'transparent',
            color:      server.enabled ? 'var(--bg-base)' : 'var(--text-muted)',
            border:     `2px solid ${server.enabled ? 'var(--accent)' : 'var(--border)'}`,
            opacity: busy ? 0.5 : 1,
          }}
        >
          {server.enabled ? t('mcp.enabled') : t('mcp.disabled')}
        </button>

        {server.status === 'running' && (
          <button onClick={toggleExpand} style={{ ...BTN_BASE, fontSize: 9 }}>
            {expanded ? t('mcp.hideTools') : t('mcp.tools')}
          </button>
        )}

        {(server.status === 'stopped' || server.status === 'error') && (
          <button
            onClick={() => onStart(server.name)}
            disabled={busy}
            style={{ ...BTN_PRIMARY, opacity: busy ? 0.5 : 1 }}
          >
            {t('mcp.start')}
          </button>
        )}

        {(server.status === 'running' || server.status === 'starting') && (
          <button
            onClick={() => onStop(server.name)}
            disabled={busy}
            style={{ ...BTN_BASE, opacity: busy ? 0.5 : 1 }}
          >
            {busy ? '...' : t('mcp.stop')}
          </button>
        )}

        <button
          onClick={() => onRemove(server.name)}
          disabled={busy}
          style={{ ...BTN_DANGER, opacity: busy ? 0.5 : 1 }}
        >
          {t('mcp.remove')}
        </button>
      </div>

      {server.lastError && (
        <div style={{
          ...MONO,
          fontSize: 9,
          color: 'var(--danger)',
          padding: '0 10px 8px 10px',
          wordBreak: 'break-word',
        }}>
          {server.lastError}
        </div>
      )}

      {expanded && (
        <div style={{ borderTop: 'var(--border-width) solid var(--border)', padding: '6px 10px 8px' }}>
          {loadingTools
            ? <span style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)' }}>{t('mcp.loadingTools')}</span>
            : <ToolList tools={tools ?? []} />
          }
        </div>
      )}
    </div>
  )
}

// ─── Add-server form ──────────────────────────────────────────────────────────

function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation('settings')
  const [name, setName]       = React.useState('')
  const [command, setCommand] = React.useState('')
  const [argsRaw, setArgsRaw] = React.useState('')
  const [envRaw, setEnvRaw]   = React.useState('')
  const [secretRaw, setSecretRaw] = React.useState('')
  const [error, setError]     = React.useState<string | null>(null)
  const [busy, setBusy]       = React.useState(false)
  const [open, setOpen]       = React.useState(false)

  const reset = () => {
    setName(''); setCommand(''); setArgsRaw(''); setEnvRaw(''); setSecretRaw(''); setError(null)
  }

  /** KEY=VALUE lines → object. Throws a translated message on a malformed line. */
  const parseEnvLines = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
      const eq = line.indexOf('=')
      if (eq < 1) throw new Error(t('mcp.form.errorEnvLine', { line }))
      out[line.slice(0, eq)] = line.slice(eq + 1)
    }
    return out
  }

  const submit = async () => {
    if (!name.trim() || !command.trim()) {
      setError(t('mcp.form.errorRequired'))
      return
    }

    const args = argsRaw
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)

    let env: Record<string, string> | undefined
    let secrets: Record<string, string> | undefined
    try {
      if (envRaw.trim())    env     = parseEnvLines(envRaw)
      if (secretRaw.trim()) secrets = parseEnvLines(secretRaw)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }

    const config: MCPServerConfig = { name: name.trim(), command: command.trim(), args, env, secrets }

    setBusy(true)
    setError(null)
    try {
      await window.tachi.mcp.add(config)
      reset()
      setOpen(false)
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...BTN_PRIMARY, fontSize: 10 }}>
        {t('mcp.form.addServerButton')}
      </button>
    )
  }

  return (
    // flexBasis:100% — the parent is a wrapping button row; the open form takes
    // its own full-width line instead of squeezing beside the marketplace button.
    <div style={{ ...CARD, marginTop: 6, flexBasis: '100%' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12, color: 'var(--text-primary)' }}>
        {t('mcp.form.title')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label style={LABEL}>{t('mcp.form.nameLabel')}</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="filesystem"
            style={INPUT}
          />
        </div>

        <div>
          <label style={LABEL}>{t('mcp.form.commandLabel')}</label>
          <input
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder="npx"
            style={INPUT}
          />
        </div>

        <div>
          <label style={LABEL}>{t('mcp.form.argsLabel')}</label>
          <textarea
            value={argsRaw}
            onChange={e => setArgsRaw(e.target.value)}
            placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
            rows={4}
            style={{ ...INPUT, resize: 'vertical' as const }}
          />
        </div>

        <div>
          <label style={LABEL}>{t('mcp.form.envLabel')}</label>
          <textarea
            value={envRaw}
            onChange={e => setEnvRaw(e.target.value)}
            placeholder="GITLAB_API_URL=https://gitlab.example.com/api/v4"
            rows={2}
            style={{ ...INPUT, resize: 'vertical' as const }}
          />
        </div>

        <div>
          <label style={LABEL}>{t('mcp.form.secretEnvLabel')}</label>
          <textarea
            value={secretRaw}
            onChange={e => setSecretRaw(e.target.value)}
            placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..."
            rows={2}
            style={{ ...INPUT, resize: 'vertical' as const }}
          />
          <div style={{ ...MONO, fontSize: 8, color: 'var(--text-dim)', marginTop: 3 }}>
            {t('mcp.form.secretEnvNote')}
          </div>
        </div>

        {/* Hand-added servers are treated as network-needing (we can't know), so
            they are refused while PRIVATE MODE is on — say so up front. */}
        <div style={{ ...MONO, fontSize: 8, color: 'var(--warning)', lineHeight: 1.5 }}>
          {t('mcp.form.customEgressNote')}
        </div>

        {error && (
          <div style={{ ...MONO, fontSize: 9, color: 'var(--danger)' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={busy} style={{ ...BTN_PRIMARY, opacity: busy ? 0.5 : 1 }}>
            {busy ? '...' : t('mcp.form.add')}
          </button>
          <button onClick={() => { reset(); setOpen(false) }} style={BTN_BASE}>
            {t('mcp.form.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── In-process server permission mode (Claude-style scopes) ──────────────────
//
// Gates the tools OUR in-app MCP endpoint exposes to connected agents.
// Enforced in mcp-server.ts's CallTool dispatch via isMcpToolAllowed(); the
// value is read per call, so changes here apply immediately (no restart).

type McpMode = 'locked' | 'read_only' | 'read_write' | 'full'
const MCP_MODES: McpMode[] = ['locked', 'read_only', 'read_write', 'full']

function McpModeSection() {
  const { t } = useTranslation('settings')
  const [mode, setMode] = React.useState<McpMode | null>(null)
  const [srv, setSrv]   = React.useState<{ running: boolean; enabled: boolean; url: string | null } | null>(null)

  React.useEffect(() => {
    window.tachi.settings.load()
      .then(s => setMode((s.mcpMode as McpMode | undefined) ?? 'full'))
      .catch(() => setMode('full'))
    window.tachi.mcp.status().then(setSrv).catch(() => { /* leave null */ })
  }, [])

  const pick = (m: McpMode) => {
    setMode(m)
    void window.tachi.settings.save({ mcpMode: m }).catch(() => { /* non-fatal */ })
  }

  const toggleServer = async () => {
    if (!srv) return
    try { setSrv(await window.tachi.mcp.setEnabled(!srv.enabled)) } catch { /* keep prior */ }
  }

  return (
    <div style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'var(--text-primary)', marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ flex: 1 }}>{t('mcp.mode.heading')}</span>
        {srv && (
          <button
            onClick={toggleServer}
            title={t('mcp.mode.serverTitle')}
            style={{
              height: 22, padding: '0 8px', border: '2px solid var(--border)',
              background: srv.enabled ? 'var(--accent)' : 'var(--bg-inset)',
              color: srv.enabled ? 'var(--bg-base)' : 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'none',
            }}
          >{srv.enabled ? t('mcp.mode.serverOn') : t('mcp.mode.serverOff')}</button>
        )}
        {srv?.running && srv.url && (
          <span style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400, textTransform: 'none' }}>{srv.url}</span>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('mcp.mode.description')}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {MCP_MODES.map(m => (
          <button
            key={m}
            onClick={() => pick(m)}
            title={t(`mcp.mode.${m}Desc`)}
            style={{
              height: 24, padding: '0 8px', border: '2px solid var(--border)',
              background: mode === m ? 'var(--accent)' : 'var(--bg-inset)',
              color: mode === m ? 'var(--bg-base)' : 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >{t(`mcp.mode.${m}`)}</button>
        ))}
      </div>
      {mode && (
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 6 }}>
          {t(`mcp.mode.${mode}Desc`)}
        </div>
      )}
    </div>
  )
}

// ─── Main section component ───────────────────────────────────────────────────

export function MCPServersSection() {
  const { t } = useTranslation('settings')
  const [servers, setServers]   = React.useState<MCPServerInfo[]>([])
  const [busy, setBusy]         = React.useState<Record<string, boolean>>({})
  const [globalErr, setGlobalErr] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    try {
      const list = await window.tachi.mcp.list()
      setServers(list)
    } catch (err) {
      setGlobalErr(err instanceof Error ? err.message : String(err))
    }
  }, [])

  React.useEffect(() => { reload() }, [reload])

  const withBusy = async (name: string, fn: () => Promise<void>) => {
    setBusy(b => ({ ...b, [name]: true }))
    setGlobalErr(null)
    try { await fn() } catch (err) {
      setGlobalErr(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(b => ({ ...b, [name]: false }))
      await reload()
    }
  }

  const handleStart  = (name: string) => withBusy(name, () => window.tachi.mcp.start(name).then(() => {}))
  const handleStop   = (name: string) => withBusy(name, () => window.tachi.mcp.stop(name).then(() => {}))
  const handleRemove = (name: string) => withBusy(name, () => window.tachi.mcp.remove(name).then(() => {}))
  const handleSetEnabled = (name: string, enabled: boolean) =>
    withBusy(name, () => window.tachi.mcp.setServerEnabled(name, enabled).then(() => {}))

  const runningCount = servers.filter(s => s.status === 'running').length

  return (
    <div style={{ ...CARD, marginTop: 24 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-primary)',
        }}>
          {t('mcp.heading')}
          <span style={{
            marginLeft: 8,
            fontSize: 10,
            color: runningCount > 0 ? 'var(--success)' : 'var(--text-muted)',
            fontWeight: 400,
          }}>
            {t('mcp.running', { running: runningCount })}
          </span>
        </div>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 12 }}>
        {t('mcp.description')}{' '}
        <a
          href="#"
          onClick={e => { e.preventDefault(); window.tachi.shell.openExternal('https://modelcontextprotocol.io') }}
          style={{ color: 'var(--accent)' }}
        >
          modelcontextprotocol.io
        </a>
      </div>

      <McpModeSection />

      {globalErr && (
        <div style={{ ...MONO, fontSize: 9, color: 'var(--danger)', marginBottom: 8 }}>
          {globalErr}
        </div>
      )}

      {servers.length === 0 && (
        <div style={{ ...MONO, fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
          {t('mcp.empty')}
        </div>
      )}

      {servers.map(server => (
        <ServerRow
          key={server.name}
          server={{ ...server, ...(busy[server.name] ? { status: 'starting' as const } : {}) }}
          onStart={handleStart}
          onStop={handleStop}
          onRemove={handleRemove}
          onSetEnabled={handleSetEnabled}
        />
      ))}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <MCPMarketplace servers={servers} onInstalled={reload} />
        <AddServerForm onAdded={reload} />
      </div>
    </div>
  )
}
