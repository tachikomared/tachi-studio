// apps/desktop/src/pages/settings/FusionSection.tsx
//
// Choose which models run in the Fusion panel (consult_panel / fuse_plan / chat
// Fusion) and which model judges. Names are substring-matched against the active
// gateway's live catalog by resolveFusion; empty fields fall back to the built-in
// per-provider preset. Persisted to AppSettings.fusionPanel / fusionJudge.

import React from 'react'

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const inputStyle: React.CSSProperties = {
  ...MONO, width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 11,
  border: '2px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-primary)', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)',
}

export function FusionSection() {
  const [panel, setPanel] = React.useState('')
  const [judge, setJudge] = React.useState('')
  const [loaded, setLoaded] = React.useState(false)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    window.tachi.settings.load()
      .then(s => {
        setPanel(Array.isArray(s.fusionPanel) ? s.fusionPanel.join(', ') : '')
        setJudge(typeof s.fusionJudge === 'string' ? s.fusionJudge : '')
      })
      .catch(() => { /* defaults */ })
      .finally(() => setLoaded(true))
  }, [])

  const flashSaved = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1200) }

  const savePanel = async (raw: string) => {
    const list = raw.split(',').map(s => s.trim()).filter(Boolean)
    try { await window.tachi.settings.save({ fusionPanel: list }); flashSaved() } catch { /* keep UI */ }
  }
  const saveJudge = async (raw: string) => {
    try { await window.tachi.settings.save({ fusionJudge: raw.trim() }); flashSaved() } catch { /* keep UI */ }
  }

  return (
    <div style={{ border: '2px solid var(--border)', background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-hard)', marginBottom: 24, ...MONO }}>
      <div style={{ padding: '10px 14px', borderBottom: '2px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
            Fusion Panel
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
            Pick the models that answer in the Fusion panel — the agent&apos;s consult_panel / fuse_plan AND chat Fusion — and which model judges. Names are matched against your active provider&apos;s catalog — leave empty to use the built-in preset. (A per-message Fusion preset in chat still overrides this.)
          </div>
        </div>
        {saved && (
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>saved</span>
        )}
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Panel models (comma-separated)</span>
          <input
            style={inputStyle}
            value={panel}
            disabled={!loaded}
            placeholder="e.g. claude-opus-4.8, gpt-5.5, glm-5.2"
            onChange={e => setPanel(e.target.value)}
            onBlur={e => savePanel(e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Judge model</span>
          <input
            style={inputStyle}
            value={judge}
            disabled={!loaded}
            placeholder="e.g. claude-opus-4.8  (empty = preset judge)"
            onChange={e => setJudge(e.target.value)}
            onBlur={e => saveJudge(e.target.value)}
          />
        </label>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Tip: 2–4 strong, different-family models make the best panel. Unmatched names fall back silently, so a panel leg that your provider doesn&apos;t serve just drops and the judge synthesizes from the rest.
        </div>
      </div>
    </div>
  )
}
