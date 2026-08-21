// apps/desktop/src/lib/monaco-setup.ts
//
// Bundle Monaco + its language workers LOCALLY (Vite `?worker` imports) and point
// @monaco-editor/react at the local instance via loader.config({ monaco }). The
// default loader pulls Monaco from a CDN, which is wrong for Electron (offline +
// strict CSP). Importing this module once (CodeEditor does) wires it up before any
// editor mounts. The workers run the language services (html/css/ts) off-thread.

import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

loader.config({ monaco })

export { monaco }
