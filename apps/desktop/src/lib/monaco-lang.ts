// apps/desktop/src/lib/monaco-lang.ts
//
// Map a file path / extension / language name to a Monaco language id. Used by
// the agent file viewer (PreviewPanel) and the chat artifacts panel so both get
// correct syntax highlighting from the same table. Unknown inputs fall back to
// 'plaintext' (Monaco renders it cleanly, no console warning).

// Only ids Monaco actually ships (monaco-editor basic-languages + TS/JSON) — an
// unknown id would log a warning, so map exotic ones down to a close relative.
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yaml: 'yaml', yml: 'yaml',
  rs: 'rust', go: 'go', java: 'java', sql: 'sql',
  xml: 'xml', svg: 'xml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  lua: 'lua', r: 'r', pl: 'perl', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile', tf: 'hcl', hcl: 'hcl',
}

/** Monaco language id for a file path (uses its extension). */
export function monacoLangFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}

/** Monaco language id for a free-form language name (e.g. an artifact's `language`). */
export function monacoLangFromName(name: string | undefined): string {
  if (!name) return 'plaintext'
  const l = name.toLowerCase().trim()
  if (EXT_TO_LANG[l]) return EXT_TO_LANG[l]
  // Already a valid Monaco id?
  const KNOWN = new Set([
    'typescript', 'javascript', 'python', 'json', 'markdown', 'css', 'scss', 'less',
    'html', 'shell', 'yaml', 'rust', 'go', 'java', 'sql', 'xml', 'ini', 'c', 'cpp',
    'csharp', 'ruby', 'php', 'swift', 'kotlin', 'lua', 'r', 'perl', 'graphql', 'dockerfile', 'hcl',
  ])
  return KNOWN.has(l) ? l : 'plaintext'
}
