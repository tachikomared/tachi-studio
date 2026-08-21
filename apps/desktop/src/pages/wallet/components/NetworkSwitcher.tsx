// apps/desktop/src/pages/wallet/components/NetworkSwitcher.tsx
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NetworkDef } from '../../../types/electron'

/** `value` = null means "All networks". */
export function NetworkSwitcher({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { t } = useTranslation('wallet')
  const [nets, setNets] = useState<NetworkDef[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => { window.tachi.wallet.listNetworks().then(setNets).catch(() => setNets([])) }, [])
  const active = value == null ? null : nets.find(n => n.id === value)
  const chip: React.CSSProperties = {
    fontSize: 11, padding: '7px 11px', border: '2px solid var(--accent)', background: 'var(--accent-muted)',
    color: 'var(--text-primary)', boxShadow: 'var(--shadow-hard)', cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
  }
  const item = (on: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, padding: '7px 10px',
    borderBottom: '1px solid var(--border)', color: on ? 'var(--text-primary)' : 'var(--text-muted)',
    background: on ? 'var(--accent-muted)' : 'transparent', cursor: 'pointer',
  })
  return (
    <div style={{ position: 'relative' }}>
      <button style={chip} onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--info)' }}>⬡</span> {active ? active.name : t('network.all')} <span style={{ color: 'var(--text-dim)' }}>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, marginTop: 6, border: '2px solid var(--accent)', background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-hard)', minWidth: 200, zIndex: 10 }}>
          <div style={item(value == null)} onClick={() => { onChange(null); setOpen(false) }}>
            <span style={{ width: 7, height: 7, background: 'var(--accent)' }} /> {t('network.all')} {value == null && <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>}
          </div>
          {nets.map(n => (
            <div key={n.id} style={item(value === n.id)} onClick={() => { onChange(n.id); setOpen(false) }}>
              <span style={{ width: 7, height: 7, background: n.color }} /> {n.name}
              {value === n.id && <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
