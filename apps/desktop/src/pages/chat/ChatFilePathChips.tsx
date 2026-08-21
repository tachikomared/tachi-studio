// apps/desktop/src/pages/chat/ChatFilePathChips.tsx
//
// FILE-PATH CHIPS ON THE CHAT SURFACE — a thin adapter around the CODE tab's
// FilePathChips (src/pages/agent/FilePathChips.tsx), which is REUSED VERBATIM
// (imported, never edited or copied) so chat inherits its thumbnails, its
// click-to-enlarge sizing and — critically — its workspace-registration retry
// contract (ensureWorkspaceRegistered + the bounded MAX_THUMB_READ_ATTEMPTS
// re-arm). Forking any of that would mean two divergent copies of a race fix
// that took a live driver session to find.
//
// WHY AN ADAPTER IS NEEDED AT ALL — three things the agent component assumes
// that the chat surface cannot supply:
//
//  1. onOpen ⇒ the PreviewPanel. Chat has no preview overlay (ChatPage mounts
//     History + Artifacts, never PreviewPanel), so the chat action is REVEAL in
//     the OS file manager — the same shell IPC SourceChips already uses for its
//     citation files. One honest action instead of a dead click.
//
//  2. `useTranslation('agent')`. Namespaces are lazy-loaded per (lng, ns) with
//     suspense ON (src/i18n/index.ts), and the only Suspense boundary is the
//     app root — so a chat user who has never opened the CODE tab would blank
//     the WHOLE APP to the root fallback the first time a reply mentions a
//     file. The local <Suspense fallback={null}> confines that to the chip row:
//     the transcript paints immediately and the chips pop in a frame later.
//
//  3. No working dir ⇒ no chips. extractFilePaths returns [] without one (the
//     confinement mirrors what agent:read-file enforces in main). Chat messages
//     frequently have no dir at all, so this adapter falls back to plain
//     absolute-path chips — no thumbnails, because with no authorized workspace
//     root main WOULD refuse the read, and a chip that promises a preview it
//     cannot deliver is worse than a chip that just reveals the file.
//
// The path scanning in both modes runs through the SAME exported pure
// extractor; see messageWorkingDir.ts for why the fallback confines to the
// drive root.

import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePathChips, extractFilePaths, isImagePath } from '../agent/FilePathChips'
import { absoluteFilePathsFallback } from './messageWorkingDir'

const chipStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  cursor: 'pointer',
  maxWidth: 260,
}

interface ChatFilePathChipsProps {
  /** The assistant reply's text — scanned for file paths. */
  text: string
  /** Send-time working dir for THIS message (resolveMessageWorkingDir). */
  workingDir: string | null
}

export function ChatFilePathChips({ text, workingDir }: ChatFilePathChipsProps): React.ReactElement | null {
  const { t } = useTranslation('chat')

  // Reveal, not preview — see the header note. Same guard as SourceChips: the
  // file may have been moved or deleted since the answer was written.
  const onOpen = useCallback((path: string) => {
    window.tachi.shell.revealInFolder(path).catch(() => { /* moved / deleted */ })
  }, [])

  // Both modes are computed unconditionally so the hook order never changes.
  // The confined scan is also the RENDER GATE: FilePathChips renders null on an
  // empty result, and we must not wrap that null in a labelled group.
  const confined = useMemo(
    () => (workingDir ? extractFilePaths(text, workingDir) : []),
    [text, workingDir],
  )
  const loose = useMemo(
    () => (workingDir ? [] : absoluteFilePathsFallback(text)),
    [text, workingDir],
  )

  if (workingDir) {
    if (confined.length === 0) return null
    return (
      <div role="group" aria-label={t('fileChips.label', { defaultValue: 'Files' })}>
        <React.Suspense fallback={null}>
          <FilePathChips text={text} workingDir={workingDir} onOpen={onOpen} />
        </React.Suspense>
      </div>
    )
  }

  if (loose.length === 0) return null
  return (
    <div
      role="group"
      aria-label={t('fileChips.label', { defaultValue: 'Files' })}
      style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}
    >
      {loose.map((path) => {
        const basename = path.split(/[\\/]/).pop() ?? path
        return (
          <button
            key={path}
            type="button"
            onClick={() => onOpen(path)}
            title={path}
            aria-label={t('fileChips.revealAria', { defaultValue: 'Reveal {{name}} in the file manager', name: basename })}
            style={chipStyle}
          >
            <span aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0 }}>
              {isImagePath(path) ? '[IMG]' : '[FILE]'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {basename}
            </span>
          </button>
        )
      })}
    </div>
  )
}
