// apps/desktop/src/pages/settings/BackupSection.tsx
//
// Bulk export / backup (Phase 2 #4). Three actions:
//   1. Export backup — chats + design sessions + prompt library + node flows
//      into ONE portable JSON (no keys — those live in the OS keychain).
//   2. Import backup — merge by id: existing local records always win.
//   3. Export chats as Markdown — one .md per conversation into a folder.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, contentToText } from '../../store/chat.store'
import { useDesignStore } from '../../store/design.store'
import { usePromptsStore } from '../../store/prompts.store'
import { buildBackup, parseBackup, mergeById, safeFileName, conversationToMarkdown } from '../../lib/backup'
import { showToast } from '../../components/Toaster'

const btn: React.CSSProperties = {
  padding: '7px 14px', border: '2px solid var(--border-strong)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, cursor: 'pointer',
  boxShadow: 'var(--shadow-hard)',
}

async function collectFlows(): Promise<Array<{ name: string; json: string }>> {
  try {
    const list = await window.tachi.nodes.listFlows() as { ok?: boolean; flows?: Array<{ filename: string }> }
    const names = (list.flows ?? []).map(f => f.filename).slice(0, 100)
    const out: Array<{ name: string; json: string }> = []
    for (const name of names) {
      const r = await window.tachi.nodes.loadFlow(name) as { ok?: boolean; json?: string }
      if (r?.json) out.push({ name, json: r.json })
    }
    return out
  } catch {
    return []
  }
}

export function BackupSection() {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState<string | null>(null)

  const exportBackup = async () => {
    setBusy('export')
    try {
      const chats = useChatStore.getState().conversations
      const design = { projects: useDesignStore.getState().projects, sessions: useDesignStore.getState().sessions }
      const prompts = usePromptsStore.getState().templates
      const flows = await collectFlows()
      const doc = buildBackup({ chats, design, prompts, flows })
      const r = await window.tachi.backup.save(JSON.stringify(doc))
      if (r.ok) showToast({ kind: 'success', text: t('advanced.backup.exported', { path: r.path }) })
      else if (!r.canceled) showToast({ kind: 'error', text: r.error ?? 'export failed' })
    } finally {
      setBusy(null)
    }
  }

  const importBackup = async () => {
    setBusy('import')
    try {
      const r = await window.tachi.backup.load()
      if (!r.ok) { if (!r.canceled) showToast({ kind: 'error', text: r.error ?? 'import failed' }); return }
      const doc = parseBackup(r.json ?? '')
      if (!doc) { showToast({ kind: 'error', text: t('advanced.backup.badFile') }); return }
      let added = 0
      if (Array.isArray(doc.chats)) {
        const m = mergeById(useChatStore.getState().conversations, doc.chats as Array<{ id: string }>)
        useChatStore.setState({ conversations: m.merged as never })
        added += m.added
      }
      if (doc.design) {
        const mp = mergeById(useDesignStore.getState().projects, (doc.design.projects ?? []) as Array<{ id: string }>)
        const ms = mergeById(useDesignStore.getState().sessions, (doc.design.sessions ?? []) as Array<{ id: string }>)
        useDesignStore.setState({ projects: mp.merged as never, sessions: ms.merged as never })
        added += mp.added + ms.added
      }
      if (Array.isArray(doc.prompts)) {
        const m = mergeById(usePromptsStore.getState().templates, doc.prompts as Array<{ id: string }>)
        usePromptsStore.setState({ templates: m.merged as never })
        added += m.added
      }
      let flowsAdded = 0
      if (Array.isArray(doc.flows)) {
        const existing = new Set(((await window.tachi.nodes.listFlows() as { flows?: Array<{ filename: string }> }).flows ?? []).map(f => f.filename))
        for (const f of doc.flows.slice(0, 100)) {
          if (!f?.name || typeof f.json !== 'string' || existing.has(f.name)) continue
          await window.tachi.nodes.saveFlow(f.name.replace(/\.tachi-flow\.json$/i, ''), f.json)
          flowsAdded++
        }
      }
      showToast({ kind: 'success', text: t('advanced.backup.imported', { count: added + flowsAdded }) })
    } finally {
      setBusy(null)
    }
  }

  const exportMarkdown = async () => {
    setBusy('md')
    try {
      const convs = useChatStore.getState().conversations
      if (convs.length === 0) { showToast({ kind: 'info', text: t('advanced.backup.noChats') }); return }
      const files = convs.map(c => ({
        name: safeFileName(c.title),
        content: conversationToMarkdown(c, contentToText as (c: unknown) => string),
      }))
      const r = await window.tachi.backup.exportMd(files)
      if (r.ok) showToast({ kind: 'success', text: t('advanced.backup.mdDone', { count: r.written, dir: r.dir }) })
      else if (!r.canceled) showToast({ kind: 'error', text: r.error ?? 'export failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ border: '2px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('advanced.backup.blurb')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={btn} disabled={busy !== null} onClick={() => void exportBackup()}>
          {busy === 'export' ? '…' : t('advanced.backup.export')}
        </button>
        <button style={btn} disabled={busy !== null} onClick={() => void importBackup()}>
          {busy === 'import' ? '…' : t('advanced.backup.import')}
        </button>
        <button style={btn} disabled={busy !== null} onClick={() => void exportMarkdown()}>
          {busy === 'md' ? '…' : t('advanced.backup.exportMd')}
        </button>
      </div>
      <div style={{ fontSize: 9.5, color: 'var(--text-dim)' }}>{t('advanced.backup.noKeys')}</div>
    </div>
  )
}
