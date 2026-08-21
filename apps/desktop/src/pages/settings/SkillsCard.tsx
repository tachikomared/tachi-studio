import React from 'react'
import { useTranslation } from 'react-i18next'

// SkillsCard — Settings → Connections → AGENTS.
//
// Read-mostly surface over the skills IPC: the installed SKILL.md list (all
// layers), suggestions detected for the current workspace, and the hash-pinned
// registry with a per-entry INSTALL button. The heavy lifting (discovery, the
// detection table, sha256-verified install) lives in main; this card only
// renders the three lists and refreshes after an install.

type SkillRow = { name: string; description: string; layer: 'bundled' | 'workspace' | 'project'; dir: string }
type SuggestionRow = { skillId: string; title: string; reason: string; layer: 'suggested'; installed: boolean }
type RegistryRow = { id: string; title: string; description: string; url: string; sha256: string; installed: boolean }

const LAYER_LABEL: Record<SkillRow['layer'], string> = {
  bundled: 'bundled',
  workspace: 'user',
  project: 'project',
}

export function SkillsCard() {
  const { t } = useTranslation('settings')
  const [skills, setSkills]           = React.useState<SkillRow[]>([])
  const [wsRoot, setWsRoot]           = React.useState<string | null>(null)
  const [suggestions, setSuggestions] = React.useState<SuggestionRow[]>([])
  const [registry, setRegistry]       = React.useState<RegistryRow[]>([])
  const [installing, setInstalling]   = React.useState<string | null>(null)
  const [error, setError]             = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    window.tachi.skills.list().then(r => { setSkills(r.skills); setWsRoot(r.workspaceRoot) }).catch(() => setSkills([]))
    window.tachi.skills.suggest().then(r => setSuggestions(r.suggestions)).catch(() => setSuggestions([]))
    window.tachi.skills.registry().then(setRegistry).catch(() => setRegistry([]))
  }, [])
  React.useEffect(() => { refresh() }, [refresh])

  const doInstall = async (id: string) => {
    setInstalling(id); setError(null)
    try {
      const res = await window.tachi.skills.install(id)
      if (!res.ok) setError(res.error ?? 'install failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
      refresh()
    }
  }

  const heading: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
    color: 'var(--text-muted)', margin: '10px 0 4px',
  }
  const chip: React.CSSProperties = {
    fontSize: 8, fontWeight: 700, padding: '1px 6px',
    border: 'var(--border-width) solid var(--border)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    color: 'var(--text-muted)', flexShrink: 0,
  }
  const row: React.CSSProperties = {
    display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 10, lineHeight: 1.5,
  }

  return (
    <div data-testid="skills-card" style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      padding: 12,
      marginTop: 12,
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: 'var(--text-primary)' }}>
        {t('skills.title')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
        {t('skills.subtitle')}
      </div>

      {/* Installed */}
      <div style={heading}>{t('skills.installed')}</div>
      {skills.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('skills.none')}</div>
      ) : (
        skills.map(s => (
          <div key={`${s.layer}:${s.name}`} style={row}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{s.name}</span>
            <span style={chip}>{LAYER_LABEL[s.layer]}</span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description}>
              {s.description}
            </span>
          </div>
        ))
      )}

      {/* Suggested for this workspace */}
      <div style={heading}>{t('skills.suggested')}</div>
      {wsRoot === null ? (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('skills.noWorkspace')}</div>
      ) : suggestions.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('skills.noSuggestions')}</div>
      ) : (
        suggestions.map(s => (
          <div key={s.skillId} style={row}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{s.skillId}</span>
            {s.installed && <span style={{ ...chip, color: 'var(--accent)' }}>{t('skills.alreadyInstalled')}</span>}
            <span style={{ color: 'var(--text-muted)' }}>{s.reason}</span>
          </div>
        ))
      )}

      {/* Registry catalog */}
      <div style={heading}>{t('skills.catalog')}</div>
      {registry.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('skills.catalogEmpty')}</div>
      ) : (
        registry.map(e => (
          <div key={e.id} style={{ ...row, alignItems: 'center' }}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{e.title}</span>
            <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.description}>
              {e.description}
            </span>
            {e.installed ? (
              <span style={{ ...chip, color: 'var(--accent)' }}>{t('skills.alreadyInstalled')}</span>
            ) : (
              <button
                onClick={() => doInstall(e.id)}
                disabled={installing !== null || wsRoot === null}
                title={wsRoot === null ? t('skills.noWorkspace') : e.url}
                style={{
                  fontSize: 9, fontWeight: 700, padding: '3px 10px',
                  border: 'var(--border-width) solid var(--border)',
                  background: 'var(--accent)', color: '#fff',
                  boxShadow: 'var(--shadow-hard)',
                  cursor: installing === null && wsRoot !== null ? 'pointer' : 'default',
                  opacity: installing === null && wsRoot !== null ? 1 : 0.5,
                  fontFamily: 'JetBrains Mono, monospace',
                  textTransform: 'uppercase', letterSpacing: '0.08em',
                  flexShrink: 0,
                }}
              >{installing === e.id ? t('skills.installing') : t('skills.install')}</button>
            )}
          </div>
        ))
      )}

      {error && (
        <div style={{ fontSize: 10, color: 'var(--destructive)', marginTop: 6 }}>{error}</div>
      )}
    </div>
  )
}
