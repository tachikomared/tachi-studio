// apps/desktop/src/pages/agent/FolderTree.tsx
//
// File-explorer-style workspace browser.
//
// Per-user request: open folder (enter) / close (go up) / back / forward /
// hide panel. Replaces the previous flat tree-with-one-expand model.
//
// Model:
//   - currentDir is the directory whose entries fill the body.
//   - history is a stack of directories the user has visited; historyIndex
//     points at the "current" position so back/forward walk it.
//   - workspaceRoot guards against navigating above the user's workspace
//     (we don't expose the rest of the filesystem).
//
// Layout:
//   - When visible: 220 px column with toolbar (← →  ↑  ×) + path crumb + entries
//   - When hidden: 32 px sliver with vertical "FILES" label, click to re-expand
//
// IPC: uses `window.tachi.agent.listDir(dir)` already in agent.ipc.ts —
// returns top-level entries (children are not needed for this model since
// each navigation re-fetches its own listing).

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../../components/ConfirmProvider'

interface DirEntry {
  name:  string
  isDir: boolean
  // Optional children from agent:list-dir — we ignore them in this model,
  // we re-fetch on navigation.
  children?: DirEntry[]
}

// Extensions that can be shown in the full-overlay PreviewPanel (iframe + img).
const PANEL_PREVIEW_EXTS = new Set([
  'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh',
])

function isPanelPreviewable(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return PANEL_PREVIEW_EXTS.has(ext)
}

interface FolderTreeProps {
  workingDir:        string
  onFileClick?:      (absolutePath: string) => void
  selectedPath?:     string | null
  /** Controlled visibility — parent decides. Defaults to true (visible) when undefined. */
  visible?:          boolean
  onToggleVisible?:  () => void
  /** Open the full-overlay PreviewPanel for HTML/image/text files. */
  onPanelPreview?:   (absolutePath: string) => void
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function detectSep(path: string): '\\' | '/' {
  return path.includes('\\') ? '\\' : '/'
}

function pathJoin(base: string, name: string): string {
  const sep = detectSep(base)
  // Avoid double-separator if base already ends in one.
  if (base.endsWith(sep)) return base + name
  return base + sep + name
}

function parentDir(path: string): string {
  const sep = detectSep(path)
  // Trim a trailing separator so the lastIndexOf finds the right one.
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf(sep)
  if (idx < 0) return trimmed   // already root
  return trimmed.slice(0, idx) || sep
}

function isAncestor(ancestor: string, child: string): boolean {
  // Normalize trailing separator to make the prefix check robust.
  const sep = detectSep(ancestor)
  const a = ancestor.endsWith(sep) ? ancestor : ancestor + sep
  return child === ancestor || child.startsWith(a)
}

function basename(path: string): string {
  const sep = detectSep(path)
  const t   = path.endsWith(sep) ? path.slice(0, -1) : path
  const i   = t.lastIndexOf(sep)
  return i < 0 ? t : t.slice(i + 1)
}

// ── Component ────────────────────────────────────────────────────────────────

export function FolderTree({
  workingDir,
  onFileClick,
  selectedPath,
  visible = true,
  onToggleVisible,
  onPanelPreview,
}: FolderTreeProps) {
  const { t } = useTranslation('agent')
  // Alias for use inside the context-menu IIFE below, where a local
  // `const t = ctxMenu.target` shadows the translation function.
  const tr = t
  const confirm = useConfirm()
  // History stack — we maintain it ourselves rather than relying on the
  // browser's history API since this panel's nav is scoped to the workspace.
  const [history, setHistory]           = useState<string[]>([workingDir])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [entries, setEntries]           = useState<DirEntry[]>([])
  const [loading, setLoading]           = useState(false)
  const [error,   setError]             = useState<string | null>(null)
  // Create-new-entry inline row. null = no row open; 'file' / 'folder' = mode.
  const [creating, setCreating] = useState<null | 'file' | 'folder'>(null)
  const [newName, setNewName]   = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  // ── Right-click context menu state ────────────────────────────────────────
  // null = menu closed; otherwise we render a floating menu at (x, y) for the
  // given target. `target` describes what the user right-clicked (an entry or
  // empty pane); the menu items change accordingly.
  type CtxTarget =
    | { kind: 'entry'; entry: DirEntry; path: string }
    | { kind: 'empty' }
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: CtxTarget } | null>(null)

  // Inline rename state — when user picks "Rename" from context menu,
  // we drop a textbox in-place on that row.
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue]   = useState('')

  const currentDir = history[historyIndex] ?? workingDir

  // Reset history when the user picks a new workspace folder entirely.
  useEffect(() => {
    setHistory([workingDir])
    setHistoryIndex(0)
  }, [workingDir])

  // Load entries for current dir.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.tachi.agent
      .listDir(currentDir)
      .then((es: DirEntry[]) => {
        if (cancelled) return
        setEntries(es)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [currentDir])

  const canBack    = historyIndex > 0
  const canForward = historyIndex < history.length - 1
  const canUp      = isAncestor(workingDir, parentDir(currentDir)) && parentDir(currentDir) !== currentDir

  const navigateTo = useCallback((next: string) => {
    // Don't navigate above the workspace root.
    if (!isAncestor(workingDir, next)) return
    setHistory(h => {
      const truncated = h.slice(0, historyIndex + 1)
      // Avoid pushing duplicate-of-tail entry.
      if (truncated[truncated.length - 1] === next) return truncated
      return [...truncated, next]
    })
    setHistoryIndex(i => i + 1)
  }, [historyIndex, workingDir])

  const goBack    = useCallback(() => { if (canBack)    setHistoryIndex(i => i - 1) }, [canBack])
  const goForward = useCallback(() => { if (canForward) setHistoryIndex(i => i + 1) }, [canForward])
  const goUp      = useCallback(() => { if (canUp)      navigateTo(parentDir(currentDir)) }, [canUp, currentDir, navigateTo])

  // ── Refresh the listing — used after a successful create. ─────────────────
  const reload = useCallback(() => {
    setLoading(true); setError(null)
    window.tachi.agent.listDir(currentDir)
      .then((es: DirEntry[]) => { setEntries(es); setLoading(false) })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [currentDir])

  // ── Create handler — fires the IPC, refreshes, closes inline row. ─────────
  const submitCreate = useCallback(async () => {
    if (!creating) return
    const name = newName.trim()
    if (!name) return
    setCreateError(null)
    const api = window.tachi.agent
    const result = creating === 'file'
      ? await api.createFile(currentDir, name)
      : await api.createFolder(currentDir, name)
    if (!result.ok) {
      setCreateError(result.error)
      return
    }
    setCreating(null)
    setNewName('')
    reload()
  }, [creating, newName, currentDir, reload])

  const cancelCreate = useCallback(() => {
    setCreating(null); setNewName(''); setCreateError(null)
  }, [])

  // ── Context-menu actions ─────────────────────────────────────────────────
  const closeCtx = useCallback(() => setCtxMenu(null), [])

  const submitRename = useCallback(async (oldPath: string, next: string) => {
    const trimmed = next.trim()
    if (!trimmed) { setRenamingPath(null); return }
    const result = await window.tachi.agent.renameEntry(oldPath, trimmed)
    if (!result.ok) {
      // Re-use the createError row at the toolbar level — quick visibility.
      setCreateError(t('folder.renameError', { error: result.error }))
    }
    setRenamingPath(null)
    setRenameValue('')
    reload()
  }, [reload])

  const submitDelete = useCallback(async (path: string, label: string) => {
    const ok = await confirm({ message: t('folder.deleteConfirm', { label }), danger: true, okLabel: t('folder.deleteOk') })
    if (!ok) return
    const result = await window.tachi.agent.deleteEntry(path)
    if (!result.ok) setCreateError(t('folder.deleteError', { error: result.error }))
    reload()
  }, [reload, confirm, t])

  // Close menu on any click outside it. We attach to document while open.
  useEffect(() => {
    if (!ctxMenu) return
    const onDocClick = () => closeCtx()
    document.addEventListener('click', onDocClick)
    document.addEventListener('contextmenu', onDocClick)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('contextmenu', onDocClick)
    }
  }, [ctxMenu, closeCtx])

  // ── Crumb ──────────────────────────────────────────────────────────────────
  // Show path relative to workspace root, "/" when at root.
  const crumb = useMemo(() => {
    const sep = detectSep(workingDir)
    if (currentDir === workingDir) return '/'
    const rootWithSep = workingDir.endsWith(sep) ? workingDir : workingDir + sep
    return currentDir.startsWith(rootWithSep)
      ? '/' + currentDir.slice(rootWithSep.length).split(sep).join('/')
      : currentDir
  }, [currentDir, workingDir])

  // ── Collapsed-sliver render ───────────────────────────────────────────────
  if (!visible) {
    return (
      <div
        style={{
          width: 32,
          flexShrink: 0,
          borderRight: '2px solid var(--border)',
          background: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 8,
          cursor: 'pointer',
        }}
        onClick={() => onToggleVisible?.()}
        title={t('folder.showPanel')}
      >
        <div style={{
          writingMode: 'vertical-rl',
          transform: 'rotate(180deg)',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {t('folder.files')}
        </div>
      </div>
    )
  }

  // ── Expanded render ───────────────────────────────────────────────────────
  // Fills parent width. Parent (WorkspacePanel) controls the panel width and
  // outer border — FolderTree just fills available space. Previous fixed
  // 220-260px caused a dead gap inside WorkspacePanel's 280px slot ("the wall"
  // the user reported), and the embedded borderRight made it visible.
  return (
    <div
      style={{
        width: '100%', flex: 1, minHeight: 0, flexShrink: 0,
        background: 'var(--bg-surface)',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {/* ── Header / toolbar ──
       *  ASCII labels (<, >, ^, +) — JetBrains Mono rendered the unicode
       *  arrows as empty boxes at 22px size on Windows. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '4px 6px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}>
        <NavBtn label="<"  title={t('folder.back')}    disabled={!canBack}    onClick={goBack} />
        <NavBtn label=">"  title={t('folder.forward')} disabled={!canForward} onClick={goForward} />
        <NavBtn label="^"  title={t('folder.up')}      disabled={!canUp}      onClick={goUp} />
        <div style={{ width: 6 }} />
        <NavBtn label="+F" title={t('folder.newFile')}
          onClick={() => { setCreating('file');   setNewName(''); setCreateError(null) }} />
        <NavBtn label="+D" title={t('folder.newFolder')}
          onClick={() => { setCreating('folder'); setNewName(''); setCreateError(null) }} />
        <div style={{ flex: 1 }} />
        <NavBtn label="x"  title={t('folder.hidePanel')} onClick={() => onToggleVisible?.()} />
      </div>

      {/* ── Crumb ── */}
      <div
        title={currentDir}
        style={{
          padding: '4px 8px',
          borderBottom: '2px solid var(--border)',
          fontSize: 10,
          color: 'var(--text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
        }}
      >
        {crumb}
      </div>

      {/* ── Inline create-new row ──
       *  Shown when the user clicks +F or +D. Enter confirms, Esc cancels. */}
      {creating !== null && (
        <div style={{
          padding: '6px 8px',
          borderBottom: '2px solid var(--accent)',
          background: 'var(--accent-muted)',
          display: 'flex', flexDirection: 'column', gap: 4,
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--accent-text)',
          }}>
            {creating === 'file' ? t('folder.newFileHeader') : t('folder.newFolderHeader')}
          </div>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void submitCreate() }
              if (e.key === 'Escape') { e.preventDefault(); cancelCreate() }
            }}
            placeholder={creating === 'file' ? t('folder.fileNamePlaceholder') : t('folder.folderNamePlaceholder')}
            style={{
              padding: '4px 6px',
              border: '2px solid var(--accent)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              outline: 'none',
            }}
          />
          {createError && (
            <div style={{ fontSize: 9, color: 'var(--danger, #ff5252)' }}>
              {createError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 4 }}>
            <NavBtn label="OK" title={t('folder.create')}  onClick={() => void submitCreate()} disabled={newName.trim().length === 0} />
            <NavBtn label="x"  title={t('folder.cancel')}  onClick={cancelCreate} />
          </div>
        </div>
      )}

      {/* ── Body ── */}
      <div
        style={{ flex: 1, overflowY: 'auto', padding: '4px 0', position: 'relative' }}
        onContextMenu={(ev) => {
          // Empty-area right-click → "Create File / Create Folder" menu.
          // (Per-entry context menu is wired on the button below; their
          // handler stops propagation so this only fires on empty pane.)
          ev.preventDefault()
          setCtxMenu({ x: ev.clientX, y: ev.clientY, target: { kind: 'empty' } })
        }}
      >
        {loading && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)' }}>{t('folder.loading')}</div>
        )}
        {error && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--danger, #ff5252)' }}>{error}</div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)' }}>
            {t('folder.empty')}
          </div>
        )}
        {!loading && !error && entries.map(e => {
          const absolutePath = pathJoin(currentDir, e.name)
          const isSelected   = selectedPath === absolutePath
          const onClick      = e.isDir
            ? () => navigateTo(absolutePath)
            : () => onFileClick?.(absolutePath)

          // Inline rename mode for this entry.
          if (renamingPath === absolutePath) {
            return (
              <div
                key={e.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '3px 10px', width: '100%',
                  background: 'var(--accent-muted)',
                  borderLeft: '2px solid var(--accent)',
                }}
              >
                <span style={{
                  width: 12, display: 'inline-block', textAlign: 'center',
                  fontSize: 10, color: e.isDir ? 'var(--accent)' : 'var(--text-dim)',
                }}>{e.isDir ? '▸' : '·'}</span>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(ev) => setRenameValue(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter')  { ev.preventDefault(); void submitRename(absolutePath, renameValue) }
                    if (ev.key === 'Escape') { ev.preventDefault(); setRenamingPath(null); setRenameValue('') }
                  }}
                  onBlur={() => { setRenamingPath(null); setRenameValue('') }}
                  style={{
                    flex: 1, fontSize: 11,
                    padding: '1px 4px',
                    border: '2px solid var(--accent)',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    fontFamily: 'JetBrains Mono, monospace',
                    outline: 'none',
                  }}
                />
              </div>
            )
          }

          return (
            <button
              key={e.name}
              onClick={onClick}
              onDoubleClick={onClick}
              onContextMenu={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                setCtxMenu({
                  x: ev.clientX,
                  y: ev.clientY,
                  target: { kind: 'entry', entry: e, path: absolutePath },
                })
              }}
              title={e.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', width: '100%',
                background: isSelected ? 'var(--accent-muted)' : 'transparent',
                border: 'none',
                borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{
                width: 12, display: 'inline-block', textAlign: 'center',
                fontSize: 10, color: e.isDir ? 'var(--accent)' : 'var(--text-dim)',
              }}>
                {e.isDir ? '▸' : '·'}
              </span>
              <span style={{
                flex: 1, fontSize: 11,
                color: isSelected
                  ? 'var(--accent-text)'
                  : (e.isDir ? 'var(--text-primary)' : 'var(--text-muted)'),
                fontFamily: 'JetBrains Mono, monospace',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {e.name}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Floating context menu ──
       *  Anchored at the cursor position. Click anywhere outside (or on a
       *  menu item) closes it via the document-level listener installed in
       *  the effect above. */}
      {ctxMenu && (
        <div
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top:  ctxMenu.y,
            zIndex: 9999,
            background: 'var(--bg-surface)',
            border: '2px solid var(--border)',
            boxShadow: 'var(--shadow-hard)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            minWidth: 160,
            // Stop propagation so clicking inside the menu doesn't close it
            // before the action fires (the action then closes via its onClick).
          }}
          onClick={(ev) => ev.stopPropagation()}
          onContextMenu={(ev) => ev.preventDefault()}
        >
          {ctxMenu.target.kind === 'empty' && (
            <>
              <MenuItem label={t('folder.newFile')}   onClick={() => { setCreating('file');   setNewName(''); setCreateError(null); closeCtx() }} />
              <MenuItem label={t('folder.newFolder')} onClick={() => { setCreating('folder'); setNewName(''); setCreateError(null); closeCtx() }} />
            </>
          )}
          {ctxMenu.target.kind === 'entry' && (() => {
            const t = ctxMenu.target
            return (
              <>
                {t.entry.isDir && (
                  <MenuItem label={tr('folder.open')} onClick={() => { navigateTo(t.path); closeCtx() }} />
                )}
                {!t.entry.isDir && (
                  <MenuItem label={tr('folder.preview')} onClick={() => { onFileClick?.(t.path); closeCtx() }} />
                )}
                {!t.entry.isDir && isPanelPreviewable(t.entry.name) && onPanelPreview && (
                  <MenuItem label={tr('folder.previewInPanel')} onClick={() => { onPanelPreview(t.path); closeCtx() }} />
                )}
                <MenuSeparator />
                <MenuItem label={tr('folder.newFile')}   onClick={() => { setCreating('file');   setNewName(''); setCreateError(null); closeCtx() }} />
                <MenuItem label={tr('folder.newFolder')} onClick={() => { setCreating('folder'); setNewName(''); setCreateError(null); closeCtx() }} />
                <MenuSeparator />
                <MenuItem label={tr('folder.rename')}     onClick={() => { setRenamingPath(t.path); setRenameValue(t.entry.name); closeCtx() }} />
                <MenuItem label={tr('folder.delete')}     danger
                  onClick={() => { void submitDelete(t.path, t.entry.name); closeCtx() }} />
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

// ── Context-menu primitives ───────────────────────────────────────────────────

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'block', width: '100%',
        padding: '5px 10px',
        background: hover
          ? (danger ? 'var(--danger, #d43f00)' : 'var(--bg-elevated)')
          : 'transparent',
        color: hover && danger
          ? '#ffffff'
          : (danger ? 'var(--danger, #ff5252)' : 'var(--text-primary)'),
        border: 'none',
        textAlign: 'left',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function MenuSeparator() {
  return <div style={{ height: 0, borderTop: 'var(--border-width) solid var(--border)' }} />
}

// ── Toolbar button ───────────────────────────────────────────────────────────

interface NavBtnProps {
  label:    string
  title:    string
  onClick?: () => void
  disabled?: boolean
}

function NavBtn({ label, title, onClick, disabled }: NavBtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        // Auto-width so 2-char labels like "+F" / "OK" fit without
        // clipping; 22px minimum keeps the single-char buttons square.
        minWidth: 22, height: 22, padding: '0 4px',
        border: '2px solid var(--border)',
        background: disabled ? 'transparent' : 'var(--bg-surface)',
        color: disabled ? 'var(--text-dim)' : 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11, fontWeight: 700, lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}
