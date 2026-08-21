// apps/desktop/src/components/CodeEditor.tsx
//
// Professional, editable code editor (Monaco — the VS Code engine) for the Design
// tab's code view and, later, the file/artifact viewers. Local Monaco (no CDN) is
// wired in lib/monaco-setup. Themed from the app's live CSS variables so it blends
// with whatever brand theme is active. Use uncontrolled (`defaultValue` + a `key`)
// for editing surfaces so it never fights the user's typing.

import { useCallback } from 'react'
import Editor, { type BeforeMount } from '@monaco-editor/react'
import '../lib/monaco-setup'

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch { return fallback }
}
/** Monaco theme colors must be 6-digit hex — coerce 3-digit, fall back otherwise. */
function hex(v: string, fallback: string): string {
  const s = v.trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(c => c + c).join('')
  return fallback
}

export interface CodeEditorProps {
  /** Controlled value. Omit and pass `defaultValue` for an uncontrolled (typing-safe) editor. */
  value?: string
  defaultValue?: string
  /** Monaco language id: 'html', 'typescript', 'css', 'json', 'markdown'… */
  language: string
  onChange?: (value: string) => void
  readOnly?: boolean
  /** Show the minimap (default true). Turn off for narrow panels. */
  minimap?: boolean
}

export function CodeEditor({ value, defaultValue, language, onChange, readOnly, minimap = true }: CodeEditorProps) {
  const beforeMount: BeforeMount = useCallback((monaco) => {
    try {
      monaco.editor.defineTheme('tachi-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': hex(cssVar('--bg-inset', '#0a0a0a'), '#0a0a0a'),
          'editor.foreground': hex(cssVar('--text-primary', '#f5f5f5'), '#f5f5f5'),
          'editorLineNumber.foreground': hex(cssVar('--text-dim', '#5a5a5a'), '#5a5a5a'),
          'editorLineNumber.activeForeground': hex(cssVar('--text-muted', '#9a9a9a'), '#9a9a9a'),
          'editor.lineHighlightBackground': '#ffffff0c',
          'editor.selectionBackground': '#ffffff22',
          'editorCursor.foreground': hex(cssVar('--accent', '#39ff14'), '#39ff14'),
          'editorIndentGuide.background1': '#ffffff12',
        },
      })
    } catch { /* theming is best-effort; vs-dark fallback below */ }
  }, [])

  return (
    <Editor
      height="100%"
      language={language}
      {...(value !== undefined ? { value } : { defaultValue })}
      onChange={(v) => onChange?.(v ?? '')}
      beforeMount={beforeMount}
      theme="tachi-dark"
      loading={<div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 12, fontFamily: 'JetBrains Mono, monospace' }}>loading editor…</div>}
      options={{
        readOnly,
        fontSize: 12.5,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontLigatures: true,
        minimap: { enabled: minimap, maxColumn: 80 },
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 10, bottom: 10 },
        lineNumbersMinChars: 3,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        bracketPairColorization: { enabled: true },
      }}
    />
  )
}
