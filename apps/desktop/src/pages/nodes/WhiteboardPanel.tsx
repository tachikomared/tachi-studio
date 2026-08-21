// apps/desktop/src/pages/nodes/WhiteboardPanel.tsx
//
// Excalidraw whiteboard hosted inside the Nodes tab. Loaded LAZILY from
// NodesPage (React.lazy) so the ~1MB excalidraw chunk is only fetched the
// first time the user toggles WHITEBOARD on — it never bloats the initial
// renderer bundle. The CSS import below therefore also lives inside the
// lazy chunk (required for @excalidraw/excalidraw@0.18 — styles ship as a
// separate ./index.css export).
//
// Persistence: the scene (elements + canvas background color) is saved to
// localStorage under 'tachi-whiteboard-scene', debounced ~800ms after the
// last change, flushed on unmount, and restored via initialData on mount.
// The Nodes flow canvas is COMPLETELY independent — this component never
// touches the nodes store.

// EXCALIDRAW_ASSET_PATH is set in src/main.tsx — it must exist before this
// chunk's excalidraw dependency executes (chunk deps run before this module).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Excalidraw, serializeAsJSON, languages } from '@excalidraw/excalidraw'
import type { ExcalidrawProps, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { showToast } from '../../components/Toaster'

const STORAGE_KEY = 'tachi-whiteboard-scene'
const SAVE_DEBOUNCE_MS = 800

type OnChange = NonNullable<ExcalidrawProps['onChange']>
type OnChangeParams = Parameters<OnChange>

/** Parse the persisted scene from localStorage. Malformed / missing data →
 *  null (start with a blank board) — never throw into render. */
export function loadWhiteboardScene(): ExcalidrawInitialDataState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      elements?: unknown
      appState?: { viewBackgroundColor?: unknown }
    } | null
    if (!parsed || !Array.isArray(parsed.elements)) return null
    const bg = parsed.appState?.viewBackgroundColor
    return {
      elements: parsed.elements as ExcalidrawInitialDataState['elements'],
      // Only the background color is restored (scroll/zoom reset is fine);
      // Excalidraw runs its own restore() over initialData, which sanitizes
      // whatever we hand it.
      ...(typeof bg === 'string' ? { appState: { viewBackgroundColor: bg } } : {}),
    }
  } catch {
    return null
  }
}

export default function WhiteboardPanel() {
  const { t, i18n } = useTranslation('nodes')

  // Excalidraw ships its own UI translations — map the app locale ('ru') onto
  // excalidraw's language codes ('ru-RU'); no match → its English default.
  const langCode = useMemo(() => {
    const app = (i18n.language || 'en').toLowerCase()
    const base = app.split('-')[0]
    const hit =
      languages.find(l => l.code.toLowerCase() === app) ??
      languages.find(l => l.code.toLowerCase().startsWith(base))
    return hit?.code
  }, [i18n.language])

  // Read the persisted scene exactly once per mount (lazy useState initializer).
  const [initialData] = useState<ExcalidrawInitialDataState | null>(loadWhiteboardScene)

  // Debounced persistence. onChange fires on every pointer move while drawing,
  // so we only stash the latest (elements, appState, files) refs here and do
  // the (potentially large) serializeAsJSON once, SAVE_DEBOUNCE_MS after the
  // last change.
  const sceneRef      = useRef<OnChangeParams | null>(null)
  const timerRef      = useRef<number | null>(null)
  const failedOnceRef = useRef(false)
  // Keep the latest t() without re-creating callbacks on language change.
  const tRef = useRef(t)
  tRef.current = t

  const persist = useCallback(() => {
    timerRef.current = null
    const scene = sceneRef.current
    if (!scene) return
    sceneRef.current = null
    const [elements, appState, files] = scene
    try {
      const json = serializeAsJSON(
        elements,
        { viewBackgroundColor: appState.viewBackgroundColor },
        files,
        'local',
      )
      localStorage.setItem(STORAGE_KEY, json)
    } catch {
      // Quota exceeded (or storage unavailable) — warn ONCE per mount, keep
      // the board fully usable in-session.
      if (!failedOnceRef.current) {
        failedOnceRef.current = true
        showToast({ kind: 'warning', text: tRef.current('whiteboard.saveFailed') })
      }
    }
  }, [])

  const handleChange = useCallback<OnChange>((elements, appState, files) => {
    sceneRef.current = [elements, appState, files]
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(persist, SAVE_DEBOUNCE_MS)
  }, [persist])

  // Flush any pending save on unmount so quick toggle-away never loses the
  // last strokes.
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    persist()
  }, [persist])

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        minWidth: 0,
        minHeight: 0,
        padding: 10,
        background: 'var(--bg-base)',
      }}
    >
      {/* Brutalist 2px frame around the excalidraw canvas. Excalidraw sizes
          itself to 100% of this box (it needs a definite flex box, hence
          minWidth/minHeight 0 up the chain). */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          border: '2px solid var(--border)',
          boxShadow: 'var(--shadow-hard)',
          overflow: 'hidden',
        }}
      >
        <Excalidraw
          theme="dark"
          langCode={langCode}
          initialData={initialData}
          onChange={handleChange}
          UIOptions={{
            canvasActions: {
              // Hide the noisy bits: excalidraw's own theme toggle (the app
              // owns theming), the .excalidraw file open/save actions and the
              // export dialog (link/excalidraw+ clutter). KEEP save-as-image
              // (PNG export) and clear-canvas + background color.
              toggleTheme: false,
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              saveAsImage: true,
              clearCanvas: true,
              changeViewBackgroundColor: true,
            },
          }}
        />
      </div>
    </div>
  )
}
