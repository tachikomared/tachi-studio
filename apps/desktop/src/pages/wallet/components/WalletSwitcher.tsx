// apps/desktop/src/pages/wallet/components/WalletSwitcher.tsx
import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { usePromptText } from '../../../components/ConfirmProvider'
import type { WalletListEntry } from '../../../types/electron'

export function WalletSwitcher({ onSelect }: { onSelect: (e: WalletListEntry) => void }) {
  const { t } = useTranslation('wallet')
  // In-app text dialog (ConfirmProvider). NOT window.prompt: that is not
  // implemented in Electron's renderer — it throws, so this handler died on the
  // first line and "add agent wallet" was dead in every packaged build.
  const promptText = usePromptText()
  const [wallets, setWallets] = useState<WalletListEntry[]>([])
  const [selectedKey, setSelectedKey] = useState<string>('app')
  const keyOf = (e: WalletListEntry) => e.id.kind === 'app' ? 'app' : `agent:${e.id.name}`
  const load = useCallback(async () => {
    const list = await window.tachi.wallet.listWallets()
    setWallets(list)
    const sel = list.find(e => keyOf(e) === selectedKey) ?? list[0]
    if (sel) { setSelectedKey(keyOf(sel)); onSelect(sel) }
  }, [selectedKey, onSelect])
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const name = (await promptText({
      title:       t('switcher.newTitle'),
      message:     t('switcher.newPrompt'),
      placeholder: t('switcher.newPlaceholder'),
      okLabel:     t('switcher.newOk'),
      cancelLabel: t('switcher.newCancel'),
    }))?.trim()
    // Cancel (null) and a blank entry both mean "no wallet" — the dialog already
    // refuses to resolve whitespace, this is the belt-and-braces guard.
    if (!name) return
    await window.tachi.wallet.createAgentWallet(name)
    await load()
  }
  const chip = (e: WalletListEntry): React.CSSProperties => {
    const on = keyOf(e) === selectedKey
    return {
      fontSize: 11, padding: '6px 10px', border: `2px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
      background: 'var(--bg-elevated)', color: on ? 'var(--text-primary)' : 'var(--text-muted)',
      boxShadow: on ? 'var(--shadow-hard)' : 'none', cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
      display: 'inline-flex', gap: 6, alignItems: 'center',
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14, padding: 10, border: '2px dashed var(--accent)', background: 'var(--accent-muted)' }}>
      <span style={{ fontSize: 8, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--accent-text)', width: '100%' }}>{t('switcher.account')}</span>
      {wallets.map(e => (
        <button key={keyOf(e)} style={chip(e)} onClick={() => { setSelectedKey(keyOf(e)); onSelect(e); if (e.id.kind === 'agent') window.tachi.wallet.setActiveAgentWallet(e.id.name!) }}>
          <span style={{ width: 7, height: 7, background: e.id.kind === 'app' ? 'var(--info)' : 'var(--accent)' }} />
          {e.label}{e.active ? t('switcher.activeSuffix') : ''}
        </button>
      ))}
      <button style={{ ...chip({ id: { kind: 'agent', name: '' }, label: '', address: null, active: false }), borderStyle: 'dashed', color: 'var(--accent-text)' }} onClick={add}>{t('switcher.new')}</button>
    </div>
  )
}
