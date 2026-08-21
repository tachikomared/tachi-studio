// apps/desktop/src/pages/nodes/canvas/nodeTypes/ImageRefNode.tsx
//
// Reference-image node — attach an image to use as a REFERENCE (NOT generation).
// It is the init frame for image-to-video and a style/subject reference for
// image models. The picked file is stored as a data URL; when this node is wired
// into a Media node the run engine uses that data URL as the media node's
// `image_url` param (detected by source type, regardless of which plug the edge
// lands on — see imageRefFeederUrl in graph-to-agentkit). Its text output is only
// a short marker so it never pastes a giant data URL into a text prompt.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type NodeProps } from '@xyflow/react'
import type { TachiImageRefNode } from '../../types'
import { useNodesStore } from '../../store/nodes.store'
import { EightHandles } from '../EightHandles'

const COLOR = 'var(--warning)'

const nodeStyle: React.CSSProperties = {
  position: 'relative', background: 'var(--bg-surface)', border: `2px solid ${COLOR}`,
  fontFamily: 'JetBrains Mono, monospace', width: 230, boxShadow: `4px 4px 0 ${COLOR}`,
}
const headerStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: `2px solid ${COLOR}`, background: COLOR, color: 'var(--bg-base)',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const bodyStyle: React.CSSProperties = { padding: '8px 10px' }
const labelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-dim)', display: 'block', marginBottom: 3,
}
const dropStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
  width: '100%', boxSizing: 'border-box', minHeight: 34, padding: '6px 8px', cursor: 'pointer',
  border: '2px dashed var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.04em',
}
const hintStyle: React.CSSProperties = { marginTop: 5, fontSize: 8, lineHeight: 1.4, color: 'var(--text-dim)' }

// Guard against pathologically large images bloating the saved flow JSON.
const MAX_BYTES = 12 * 1024 * 1024 // 12 MB

export function ImageRefNode({ id, data }: NodeProps<TachiImageRefNode>) {
  const { t } = useTranslation('nodes')
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const deleteNode     = useNodesStore(s => s.deleteNode)
  const [hover, setHover] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const dataUrl    = typeof data.dataUrl === 'string' ? data.dataUrl : ''
  const displayUrl = typeof data.displayUrl === 'string' ? data.displayUrl : ''
  const fileName   = typeof data.fileName === 'string' ? data.fileName : ''
  // Preview source: disk-backed refs render via tachi-media://; legacy nodes
  // still carry the inline data URL.
  const previewSrc = displayUrl || dataUrl

  const onFile = (file: File | undefined) => {
    setErr(null)
    if (!file) return
    if (file.size > MAX_BYTES) { setErr(t('imageRefNode.tooLarge', { size: (file.size / 1048576).toFixed(1) })); return }
    const reader = new FileReader()
    reader.onerror = () => setErr(t('imageRefNode.readError'))
    reader.onload = () => {
      void (async () => {
        const url = typeof reader.result === 'string' ? reader.result : ''
        if (!url) { setErr(t('imageRefNode.readError')); return }
        // Save the image to DISK (userData/media/refs) and keep only its path in
        // node data. Storing multi-MB base64 in the graph made every drag tick
        // (persist middleware) stringify megabytes — the old canvas-lag source.
        const saved = await window.tachi?.nodes?.saveRefImage?.(url, file.name).catch(() => null)
        if (saved?.ok) {
          updateNodeData(id, {
            filePath: saved.path, displayUrl: saved.url, dataUrl: undefined,
            fileName: file.name, lastOutput: `[image reference: ${file.name}]`,
          })
        } else {
          // Fallback (IPC unavailable / write failed): legacy inline storage
          // still runs fine, it's just heavier to persist.
          updateNodeData(id, { dataUrl: url, filePath: undefined, displayUrl: undefined, fileName: file.name, lastOutput: `[image reference: ${file.name}]` })
        }
      })()
    }
    reader.readAsDataURL(file)
  }

  const clear = () => {
    setErr(null)
    updateNodeData(id, { dataUrl: undefined, filePath: undefined, displayUrl: undefined, fileName: undefined, lastOutput: undefined })
  }

  return (
    <div
      style={nodeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={hover ? 'tachi-node-hover' : undefined}
    >
      <div style={headerStyle}>
        <span>image ref</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            className="nodrag" title={t('node.delete')} aria-label={t('node.delete')}
            style={{ width: 16, height: 16, padding: 0, border: 'var(--border-width) solid var(--bg-base)', background: 'transparent', color: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 800, lineHeight: 1, cursor: 'pointer' }}
          >×</button>
        )}
      </div>

      <div style={bodyStyle}>
        <label style={labelStyle}>{t('imageRefNode.label')}</label>

        {previewSrc && (
          <img
            src={previewSrc}
            alt={fileName || t('imageRefNode.altFallback')}
            style={{ display: 'block', width: '100%', maxHeight: 130, objectFit: 'contain', border: '2px solid var(--border)', background: 'var(--bg-base)', marginBottom: 5 }}
          />
        )}

        <label className="nodrag" style={dropStyle}>
          {previewSrc ? t('imageRefNode.replace') : t('imageRefNode.choose')}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onFile(e.target.files?.[0])}
            style={{ display: 'none' }}
          />
        </label>

        {fileName && (
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <span style={{ fontSize: 9, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>{fileName}</span>
            <button
              onClick={(e) => { e.stopPropagation(); clear() }}
              className="nodrag" title={t('imageRefNode.removeImage')}
              style={{ flexShrink: 0, height: 16, padding: '0 5px', border: `var(--border-width) solid ${COLOR}`, background: 'transparent', color: COLOR, fontFamily: 'JetBrains Mono, monospace', fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' }}
            >{t('imageRefNode.clear')}</button>
          </div>
        )}

        {err && <div style={{ marginTop: 4, fontSize: 8, color: 'var(--danger)' }}>{err}</div>}

        <div style={hintStyle}>
          {t('imageRefNode.hint1')}<strong>{t('imageRefNode.hintVideoImage')}</strong>{t('imageRefNode.hint2')}<strong>Prompt</strong>{t('imageRefNode.hint3')}
        </div>
      </div>

      {/* Source-only: a reference image feeds downstream media nodes. */}
      <EightHandles role="source" color={COLOR} />
    </div>
  )
}
