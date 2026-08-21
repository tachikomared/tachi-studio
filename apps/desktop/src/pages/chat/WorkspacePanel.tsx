// apps/desktop/src/pages/chat/WorkspacePanel.tsx
//
// Sprint C4 — per-conversation Workspace panel.
// Refactored: accepts workspaceDir directly (no longer requires a Conversation).
//
// Composes FolderTree for full file-browser ops (nav, create, rename, delete,
// right-click context menu) instead of a dumb flat FileTree list.
//
// Sections:
//   1. WORKSPACE header with collapse toggle
//   2. FILES — FolderTree with full file ops (create/rename/delete/nav)
//   3. WORKSPACE STATE — most-recent structured state entry (Sprint D3)
//   4. RECENT CHANGES — tool-call turns from the session checkpoint
//
// Brutalist aesthetic: 2px borders, JetBrains Mono, no border-radius, semantic CSS vars.

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderTree } from '../agent/FolderTree'
import { useAgentRuntime } from '../../hooks/useAgentRuntime'
import { WorkspaceStateCard } from './WorkspaceStateCard'
import type { StateEntry } from './WorkspaceStateCard'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecentChange { tool: string; target: string; ts: number }

// ── Shared styles ─────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
}


// ── Recent changes section ────────────────────────────────────────────────────

function RecentChangesList({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('chat')
  const [changes, setChanges] = useState<RecentChange[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sessionId) {
      setChanges([])
      return
    }
    let cancelled = false
    setLoading(true)
    window.tachi.workspacePanel.listRecentChanges({ sessionId })
      .then(res => {
        if (cancelled) return
        setChanges(res.changes)
      })
      .catch(() => {
        if (!cancelled) setChanges([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId])

  const TOOL_COLORS: Record<string, string> = {
    Edit:      'var(--accent-text, #4fc3f7)',
    Write:     '#81c784',
    Bash:      '#ffb74d',
    MultiEdit: 'var(--accent-text, #4fc3f7)',
    Read:      'var(--text-muted)',
    Glob:      'var(--text-muted)',
    Grep:      'var(--text-muted)',
  }

  if (!sessionId) {
    return (
      <div style={{ padding: '6px 10px', color: 'var(--text-dim)', fontSize: 10, ...MONO }}>
        {t('workspace.noSession')}
      </div>
    )
  }
  if (loading) {
    return (
      <div style={{ padding: '6px 10px', color: 'var(--text-dim)', fontSize: 10, ...MONO }}>
        {t('workspace.loading')}
      </div>
    )
  }
  if (changes.length === 0) {
    return (
      <div style={{ padding: '6px 10px', color: 'var(--text-dim)', fontSize: 10, ...MONO }}>
        {t('workspace.noToolCalls')}
      </div>
    )
  }

  return (
    <div style={{ overflowY: 'auto', maxHeight: 180 }}>
      {changes.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 6,
            padding: '2px 10px',
            fontSize: 10,
            ...MONO,
            borderBottom: 'var(--border-width) solid var(--border)',
          }}
        >
          <span style={{
            flexShrink: 0,
            color: TOOL_COLORS[c.tool] ?? 'var(--text-muted)',
            fontWeight: 700,
            minWidth: 52,
          }}>
            {c.tool}
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--text-primary)',
              flex: 1,
            }}
            title={c.target}
          >
            {c.target || '-'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Accordion header ─────────────────────────────────────────────────────────

function AccordionHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '4px 10px',
        background: 'var(--bg-elevated)',
        borderTop: '2px solid var(--border)',
        borderBottom: open ? '2px solid var(--border)' : undefined,
        borderLeft: 'none',
        borderRight: 'none',
        cursor: 'pointer',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase' as const,
        color: 'var(--text-dim)',
        textAlign: 'left' as const,
        flexShrink: 0,
        ...MONO,
      }}
    >
      <span>{open ? '▾' : '▸'}</span>
      <span>{label}</span>
    </button>
  )
}

// ── Recent changes accordion ──────────────────────────────────────────────────

function RecentChangesAccordion({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(true)
  return (
    <>
      <AccordionHeader label={t('workspace.recentChanges')} open={open} onToggle={() => setOpen(o => !o)} />
      {open && (
        <div style={{ flex: '0 0 auto', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <RecentChangesList sessionId={sessionId} />
        </div>
      )}
    </>
  )
}

// ── State snapshot section ────────────────────────────────────────────────────

function StateSection({ workspacePath }: { workspacePath: string | null }) {
  const { t } = useTranslation('chat')
  const [entry, setEntry] = useState<StateEntry | null>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!workspacePath) {
      setEntry(null)
      return
    }

    let cancelled = false

    async function load() {
      try {
        const entries = await window.tachi.playbook.loadEntries(workspacePath!)
        if (cancelled) return

        const stateEntries = (entries as StateEntry[]).filter(
          (e): e is StateEntry => (e as { type?: string }).type === 'state',
        )
        const latest = stateEntries[stateEntries.length - 1] ?? null
        setEntry(latest)
      } catch {
        // Non-fatal — bridge absent on old builds or IPC failed
      }
    }

    void load()
    const interval = setInterval(() => { void load() }, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspacePath])

  if (!entry) return null

  return (
    <>
      <AccordionHeader label={t('workspace.state')} open={open} onToggle={() => setOpen(o => !o)} />
      {open && (
        <div style={{ flexShrink: 0, borderBottom: '2px solid var(--border)' }}>
          <WorkspaceStateCard entry={entry} />
        </div>
      )}
    </>
  )
}

// ── Collapsed sliver ──────────────────────────────────────────────────────────

function CollapsedSliver({ onOpen, side = 'left' }: { onOpen: () => void; side?: 'left' | 'right' }) {
  const { t } = useTranslation('chat')
  return (
    <div
      onClick={onOpen}
      title={t('workspace.openPanel')}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpen()}
      style={{
        width: 32,
        minWidth: 32,
        borderRight: side === 'left' ? '2px solid var(--border)' : undefined,
        borderLeft:  side === 'right' ? '2px solid var(--border)' : undefined,
        background: 'var(--bg-surface)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <span style={{
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
        transform: 'rotate(180deg)',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        userSelect: 'none',
        ...MONO,
      }}>
        {t('workspace.title')}
      </span>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface WorkspacePanelProps {
  /** Direct workspace directory path. Agent page passes agent.store.workingDir here. */
  workspaceDir?: string | null
  /**
   * Called when the user clicks a file in the FolderTree.
   * Optional — if not provided, file clicks are no-ops at the panel level.
   */
  onFileClick?: (absolutePath: string) => void
  /**
   * Called when the user selects "Preview in Panel" from the FolderTree context menu.
   */
  onPanelPreview?: (absolutePath: string) => void
  /** Currently selected/previewed file path — highlighted in FolderTree. */
  selectedPath?: string | null
  /**
   * Whether the panel renders as a left-side or right-side panel.
   * Left: borderRight on collapsed sliver. Right: borderLeft.
   * Default: 'left'.
   */
  side?: 'left' | 'right'
  /** If true, panel starts in open (expanded) state. Default: true when workspaceDir is set. */
  defaultOpen?: boolean
}

export function WorkspacePanel({
  workspaceDir,
  onFileClick,
  onPanelPreview,
  selectedPath,
  side = 'left',
  defaultOpen,
}: WorkspacePanelProps) {
  const { t } = useTranslation('chat')
  const effectiveDir = workspaceDir ?? null
  // Default open when a workspaceDir is provided; otherwise collapsed.
  const [open, setOpen] = useState(defaultOpen ?? (effectiveDir != null))
  const runtime = useAgentRuntime()
  const sessionId = runtime.sessionId

  // If workspaceDir changes from null to a value, auto-expand.
  useEffect(() => {
    if (effectiveDir && !open) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveDir])

  if (!open) {
    return <CollapsedSliver onOpen={() => setOpen(true)} side={side} />
  }

  const borderSide = side === 'left'
    ? { borderRight: '2px solid var(--border)' }
    : { borderLeft: '2px solid var(--border)' }

  return (
    <div style={{
      width: 280,
      minWidth: 280,
      maxWidth: 280,
      ...borderSide,
      background: 'var(--bg-surface)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflow: 'hidden',
      ...MONO,
    }}>

      {/* ── Files section: FolderTree toolbar is the panel header (Option A) ── */}
      <div style={{
        flex: '1 1 0',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '2px solid var(--border)',
      }}>
        {effectiveDir
          ? (
            /* FolderTree is self-contained: handles back/forward/up nav,
             * +F/+D create, right-click context menu (New file, New folder,
             * Open, Preview, Rename, Delete), inline rename, and reload.
             * We strip its left-side border (it has one built-in for the
             * collapsed sliver) by overriding its outer wrapper via the
             * visible=true path which does NOT render a border. The FolderTree
             * expanded view renders its own borderRight — inside this panel
             * that is unwanted, so we wrap it in a clip div. */
            <div style={{
              flex: 1,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}>
              <FolderTree
                workingDir={effectiveDir}
                onFileClick={onFileClick ?? (() => {})}
                selectedPath={selectedPath ?? null}
                visible={true}
                onToggleVisible={() => {
                  // Panel-level collapse: collapse the whole WorkspacePanel
                  // rather than just removing the FolderTree from its slot.
                  setOpen(false)
                }}
                onPanelPreview={onPanelPreview}
              />
            </div>
          )
          : (
            <div style={{
              padding: '16px 10px',
              color: 'var(--text-dim)',
              fontSize: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'flex-start',
            }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                {t('workspace.noWorkspace')}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 9, lineHeight: 1.5 }}>
                {t('workspace.pickFolder')}
              </span>
            </div>
          )
        }
      </div>

      {/* ── Workspace state (Sprint D3) ────────────────────────────────────── */}
      <StateSection workspacePath={effectiveDir} />

      {/* ── Recent changes (accordion) ─────────────────────────────────────── */}
      <RecentChangesAccordion sessionId={sessionId} />

    </div>
  )
}
