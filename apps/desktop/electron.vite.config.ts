import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { cpSync } from 'node:fs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Copy the tool-output-rules JSON directory into out/main so the runtime
// loader (tool-output-compactor.ts → join(__dirname, 'tool-output-rules'))
// finds it next to the bundled main process. Vite only emits imported JS,
// so this directory of data files must be copied explicitly.
function copyToolOutputRulesPlugin() {
  return {
    name: 'copy-tool-output-rules',
    writeBundle() {
      cpSync(
        resolve(__dirname, 'electron/services/tool-output-rules'),
        resolve(__dirname, 'out/main/tool-output-rules'),
        { recursive: true },
      )
    },
  }
}

// Excalidraw loads its handwriting fonts at RUNTIME from
// `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/…` — in packaged builds the esm.sh
// fallback is blocked by the strict prod CSP, so the whiteboard's text tool
// would silently fall back to system fonts. Ship ALL fonts next to the
// renderer (WhiteboardPanel points EXCALIDRAW_ASSET_PATH here) — including
// Xiaolai (12 MB): the app is 8-locale incl zh/ja, CJK whiteboard text must
// render, and a missing local file makes excalidraw probe the esm.sh fallback
// per glyph-subset file (~209 CSP-violation console errors per session).
function copyExcalidrawFontsPlugin() {
  return {
    name: 'copy-excalidraw-fonts',
    writeBundle() {
      cpSync(
        resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'),
        resolve(__dirname, 'out/renderer/excalidraw-assets/fonts'),
        { recursive: true },
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@tachi/core'] }), copyToolOutputRulesPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
          // Standalone stdio MCP server spawned as a separate `node <script>`
          // child process by darksol-mcp.ts (resolveServerEntry → sibling
          // out/main/darksol-mcp-server.js). Declared as its own entry so
          // electron-vite emits it as a self-contained module, not a chunk.
          'darksol-mcp-server': resolve(__dirname, 'electron/services/darksol-mcp-server.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@tachi/core'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') },
      },
    },
    plugins: [react(), copyExcalidrawFontsPlugin()],
    // Monaco ships its language services as web workers — emit them as ES modules
    // (Vite `?worker` imports in lib/monaco-setup) so the editor runs fully local.
    worker: { format: 'es' },
    optimizeDeps: { include: ['monaco-editor', '@excalidraw/excalidraw'] },
    resolve: {
      alias: { '@': resolve(__dirname, 'src') },
    },
  },
})
