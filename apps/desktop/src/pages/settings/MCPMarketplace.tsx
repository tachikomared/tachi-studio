// apps/desktop/src/pages/settings/MCPMarketplace.tsx
//
// The one-click MCP marketplace (USER-PAINS T11 — Claude Desktop's dominant
// friction is "hand-edit JSON + restart dance"). Browse a curated catalog,
// fill the two or three inputs a server actually needs, click INSTALL.
//
// Nothing here downloads or launches anything on its own: the catalog is inert
// static data shipped with the app, and a server process only spawns after the
// user clicks INSTALL (with CONNECT NOW) or flips ENABLED on the installed row.
// npx/uvx entries carry a visible caution — first launch fetches and executes
// third-party code from a public registry.

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { McpCatalogEntry, MCPServerInfo } from '../../types/electron'

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const BTN: React.CSSProperties = {
  ...MONO,
  fontSize: 9,
  fontWeight: 700,
  padding: '4px 10px',
  cursor: 'pointer',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
}

const BTN_PRIMARY: React.CSSProperties = {
  ...BTN,
  background: 'var(--accent)',
  color: 'var(--bg-base)',
  border: '2px solid var(--accent)',
}

const INPUT: React.CSSProperties = {
  ...MONO,
  fontSize: 10,
  padding: '5px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  width: '100%',
  boxSizing: 'border-box',
}

const LABEL: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  display: 'block',
  marginBottom: 3,
}

function Chip({
  children,
  active,
  onClick,
  tone,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  tone?: 'network' | 'local'
}) {
  const bg =
    active ? 'var(--accent)' :
    tone === 'network' ? 'var(--bg-inset)' :
    tone === 'local' ? 'var(--bg-inset)' :
    'transparent'
  const fg =
    active ? 'var(--bg-base)' :
    tone === 'network' ? 'var(--warning)' :
    tone === 'local' ? 'var(--success)' :
    'var(--text-muted)'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        ...MONO,
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        border: `var(--border-width) solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: bg,
        color: fg,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

// ─── Install form for one catalog entry ──────────────────────────────────────

function InstallPanel({
  entry,
  takenNames,
  onDone,
  onCancel,
}: {
  entry:      McpCatalogEntry
  takenNames: string[]
  onDone:     () => void
  onCancel:   () => void
}) {
  const { t } = useTranslation('settings')

  // Default install name = the catalog id; suffixed if that name is taken so a
  // second Filesystem server doesn't collide with the first.
  const defaultName = React.useMemo(() => {
    if (!takenNames.includes(entry.id)) return entry.id
    for (let i = 2; ; i++) if (!takenNames.includes(`${entry.id}-${i}`)) return `${entry.id}-${i}`
  }, [entry.id, takenNames])

  const [name, setName]     = React.useState(defaultName)
  const [slots, setSlots]   = React.useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const s of entry.slots ?? []) init[s.token] = s.default ?? ''
    return init
  })
  const [env, setEnv]       = React.useState<Record<string, string>>({})
  const [connect, setConnect] = React.useState(true)
  const [busy, setBusy]     = React.useState(false)
  const [error, setError]   = React.useState<string | null>(null)

  const browse = async (token: string) => {
    try {
      const dir = await window.tachi.agent.pickFolder()
      if (dir) setSlots(s => ({ ...s, [token]: dir }))
    } catch { /* user cancelled / dialog unavailable */ }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.tachi.mcp.install({
        catalogId: entry.id,
        name:      name.trim() || entry.id,
        slots,
        env,
        enable:    connect,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      borderTop: 'var(--border-width) solid var(--border)',
      padding: '10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      background: 'var(--bg-base)',
    }}>
      <div>
        <label style={LABEL}>{t('mcp.market.nameLabel')}</label>
        <input value={name} onChange={e => setName(e.target.value)} style={INPUT} />
      </div>

      {(entry.slots ?? []).map(slot => (
        <div key={slot.token}>
          <label style={LABEL}>
            {slot.label} {slot.required ? '' : `(${t('mcp.market.optional')})`}
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={slots[slot.token] ?? ''}
              onChange={e => setSlots(s => ({ ...s, [slot.token]: e.target.value }))}
              placeholder={slot.token}
              style={INPUT}
            />
            {slot.kind === 'path' && (
              <button type="button" onClick={() => browse(slot.token)} style={{ ...BTN, whiteSpace: 'nowrap' }}>
                {t('mcp.market.browse')}
              </button>
            )}
          </div>
        </div>
      ))}

      {(entry.env ?? []).map(v => (
        <div key={v.key}>
          <label style={LABEL}>
            {v.key} — {v.label} {v.required ? '' : `(${t('mcp.market.optional')})`}
          </label>
          <input
            type={v.secret ? 'password' : 'text'}
            value={env[v.key] ?? ''}
            onChange={e => setEnv(s => ({ ...s, [v.key]: e.target.value }))}
            style={INPUT}
            autoComplete="off"
          />
          {v.secret && (
            <div style={{ ...MONO, fontSize: 8, color: 'var(--text-dim)', marginTop: 2 }}>
              {t('mcp.market.secretNote')}
            </div>
          )}
        </div>
      ))}

      <label style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={connect} onChange={e => setConnect(e.target.checked)} />
        {t('mcp.market.connectNow')}
      </label>

      <div style={{
        ...MONO,
        fontSize: 8,
        color: 'var(--warning)',
        border: 'var(--border-width) solid var(--warning)',
        padding: '5px 7px',
        lineHeight: 1.5,
      }}>
        {t('mcp.market.runnerCaution', { runner: entry.runner, pkg: entry.packageName })}
      </div>

      {error && <div style={{ ...MONO, fontSize: 9, color: 'var(--danger)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy} style={{ ...BTN_PRIMARY, opacity: busy ? 0.5 : 1 }}>
          {busy ? '...' : t('mcp.market.install')}
        </button>
        <button onClick={onCancel} disabled={busy} style={BTN}>
          {t('mcp.market.cancel')}
        </button>
      </div>
    </div>
  )
}

// ─── One catalog card ────────────────────────────────────────────────────────

function CatalogCard({
  entry,
  installed,
  takenNames,
  expanded,
  onToggle,
  onInstalled,
}: {
  entry:       McpCatalogEntry
  installed:   boolean
  takenNames:  string[]
  expanded:    boolean
  onToggle:    () => void
  onInstalled: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-surface)',
    }}>
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...MONO, fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {entry.name}
          </span>
          {installed && <Chip tone="local">{t('mcp.market.installed')}</Chip>}
          <button onClick={onToggle} style={expanded ? BTN : BTN_PRIMARY}>
            {expanded ? t('mcp.market.cancel') : t('mcp.market.install')}
          </button>
        </div>

        <div style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {entry.description}
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip tone={entry.requiresNetwork ? 'network' : 'local'}>
            {entry.requiresNetwork ? t('mcp.market.network') : t('mcp.market.localOnly')}
          </Chip>
          {entry.tags.map(tag => (
            <Chip key={tag}>{t(`mcp.tags.${tag}`, { defaultValue: tag })}</Chip>
          ))}
          <span style={{ flex: 1 }} />
          <a
            href="#"
            onClick={e => { e.preventDefault(); window.tachi.shell.openExternal(entry.homepage) }}
            style={{ ...MONO, fontSize: 8, color: 'var(--accent)', textDecoration: 'none' }}
          >
            {entry.packageName}
          </a>
        </div>
      </div>

      {expanded && (
        <InstallPanel
          entry={entry}
          takenNames={takenNames}
          onDone={() => { onToggle(); onInstalled() }}
          onCancel={onToggle}
        />
      )}
    </div>
  )
}

// ─── Marketplace ─────────────────────────────────────────────────────────────

export function MCPMarketplace({
  servers,
  onInstalled,
}: {
  servers:     MCPServerInfo[]
  onInstalled: () => void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen]       = React.useState(false)
  const [entries, setEntries] = React.useState<McpCatalogEntry[]>([])
  const [tags, setTags]       = React.useState<string[]>([])
  const [query, setQuery]     = React.useState('')
  const [tag, setTag]         = React.useState<string | null>(null)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const [loadErr, setLoadErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open || entries.length > 0) return
    window.tachi.mcp.catalog()
      .then(c => { setEntries(c.entries); setTags(c.tags) })
      .catch(err => setLoadErr(err instanceof Error ? err.message : String(err)))
  }, [open, entries.length])

  const takenNames    = React.useMemo(() => servers.map(s => s.name), [servers])
  const installedIds  = React.useMemo(
    () => new Set(servers.map(s => s.catalogId).filter((v): v is string => !!v)),
    [servers],
  )

  // Same matching rule as searchCatalog() in the main process — kept here so
  // typing filters without an IPC round-trip per keystroke.
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(e => {
      if (tag && !e.tags.includes(tag)) return false
      if (!q) return true
      return (
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.packageName.toLowerCase().includes(q) ||
        e.tags.some(tg => tg.includes(q))
      )
    })
  }, [entries, query, tag])

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...BTN_PRIMARY, fontSize: 10 }}>
        {t('mcp.market.browseButton')}
      </button>
    )
  }

  return (
    // flexBasis:100% — the parent is a wrapping button row; the open panel must
    // claim its own full-width line rather than sit beside "+ Add server".
    <div style={{
      flexBasis: '100%',
      border: '2px solid var(--border)',
      background: 'var(--bg-elevated)',
      padding: 10,
      marginTop: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          ...MONO, fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em', color: 'var(--text-primary)', flex: 1,
        }}>
          {t('mcp.market.heading')}
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 9, color: 'var(--text-muted)' }}>
            {t('mcp.market.count', { n: visible.length })}
          </span>
        </span>
        <button onClick={() => setOpen(false)} style={BTN}>{t('mcp.market.hide')}</button>
      </div>

      <div style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
        {t('mcp.market.description')}
      </div>

      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('mcp.market.searchPlaceholder')}
        style={{ ...INPUT, marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        <Chip active={tag === null} onClick={() => setTag(null)}>{t('mcp.market.allTags')}</Chip>
        {tags.map(tg => (
          <Chip key={tg} active={tag === tg} onClick={() => setTag(tag === tg ? null : tg)}>
            {t(`mcp.tags.${tg}`, { defaultValue: tg })}
          </Chip>
        ))}
      </div>

      {loadErr && (
        <div style={{ ...MONO, fontSize: 9, color: 'var(--danger)', marginBottom: 8 }}>{loadErr}</div>
      )}

      {visible.length === 0 && !loadErr && (
        <div style={{ ...MONO, fontSize: 10, color: 'var(--text-muted)' }}>
          {t('mcp.market.noResults')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map(entry => (
          <CatalogCard
            key={entry.id}
            entry={entry}
            installed={installedIds.has(entry.id)}
            takenNames={takenNames}
            expanded={expandedId === entry.id}
            onToggle={() => setExpandedId(id => (id === entry.id ? null : entry.id))}
            onInstalled={onInstalled}
          />
        ))}
      </div>
    </div>
  )
}
