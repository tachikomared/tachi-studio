import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import './globals.css'
import './i18n'
import { App } from './app/App'
import { RootErrorBoundary } from './components/RootErrorBoundary'

// Excalidraw (lazy-loaded in the NODES whiteboard) resolves its runtime fonts
// against this global, falling back to esm.sh — which the packaged build's
// strict CSP blocks. It MUST be set before the excalidraw chunk executes;
// setting it inside the whiteboard chunk is too late (rollup executes the
// excalidraw dependency chunk BEFORE the importer's own module body — verified
// live: fonts fell back to esm.sh and got CSP-blocked). The main entry always
// runs first, so it is the one safe place. Fonts are copied to
// out/renderer/excalidraw-assets/ by copyExcalidrawFontsPlugin.
;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  new URL('excalidraw-assets/', window.location.href).toString()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <Suspense fallback={<div style={{ background: 'var(--bg-base)', height: '100vh' }} />}>
        <App />
      </Suspense>
    </RootErrorBoundary>
  </React.StrictMode>,
)
