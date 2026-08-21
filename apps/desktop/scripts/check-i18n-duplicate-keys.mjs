// Detects DUPLICATE keys (any nesting level) in the i18n locale JSONs.
//
// Why: JSON.parse silently keeps the LAST occurrence of a duplicated key, so
// a second "filePreview" block appended to es/agent.json SHADOWED the first
// one's translations without any error anywhere (seen live 2026-07-19). This
// walker re-parses the raw text with a duplicate-aware reviver and fails
// loudly, listing file + full key path of every duplicate.
//
// Usage: node scripts/check-i18n-duplicate-keys.mjs   (exit 1 on duplicates)
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'locales')

/**
 * Minimal JSON parser that reports duplicate object keys with their paths.
 * We only need objects/arrays/strings/numbers/booleans/null — the grammar the
 * locale files use. Positions are tracked for error messages.
 * Exported so the vitest gate (i18nDuplicateKeys.test.ts) runs the same walk.
 */
export function findDuplicateKeys(text, file) {
  const dupes = []
  let i = 0

  const err = (msg) => { throw new Error(`${file}: ${msg} at offset ${i}`) }
  const ws = () => { while (i < text.length && /[\s]/.test(text[i])) i++ }

  const parseValue = (path) => {
    ws()
    const c = text[i]
    if (c === '{') return parseObject(path)
    if (c === '[') return parseArray(path)
    if (c === '"') return void parseString()
    if (c === '-' || (c >= '0' && c <= '9')) { while (i < text.length && /[-+.eE0-9]/.test(text[i])) i++; return }
    if (text.startsWith('true', i)) { i += 4; return }
    if (text.startsWith('false', i)) { i += 5; return }
    if (text.startsWith('null', i)) { i += 4; return }
    err(`unexpected character "${c}"`)
  }

  const parseString = () => {
    // assumes text[i] === '"'
    i++
    let out = ''
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') { out += text[i + 1] === 'u' ? text.slice(i, i + 6) : text.slice(i, i + 2); i += text[i + 1] === 'u' ? 6 : 2; continue }
      if (c === '"') { i++; return out }
      out += c; i++
    }
    err('unterminated string')
  }

  const parseObject = (path) => {
    i++ // {
    const seen = new Set()
    ws()
    if (text[i] === '}') { i++; return }
    for (;;) {
      ws()
      if (text[i] !== '"') err('expected key string')
      const key = parseString()
      const keyPath = path ? `${path}.${key}` : key
      if (seen.has(key)) dupes.push(keyPath)
      seen.add(key)
      ws()
      if (text[i] !== ':') err('expected ":"')
      i++
      parseValue(keyPath)
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === '}') { i++; return }
      err('expected "," or "}"')
    }
  }

  const parseArray = (path) => {
    i++ // [
    ws()
    if (text[i] === ']') { i++; return }
    let idx = 0
    for (;;) {
      parseValue(`${path}[${idx++}]`)
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === ']') { i++; return }
      err('expected "," or "]"')
    }
  }

  parseValue('')
  return dupes
}

/** Scan every locale file; returns [{file, path}] for each duplicate key. */
export function scanLocales(localesDir = LOCALES_DIR) {
  const found = []
  let files = 0
  for (const locale of readdirSync(localesDir)) {
    const dir = join(localesDir, locale)
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      files++
      const text = readFileSync(join(dir, f), 'utf8')
      // Sanity: the file must also be plain-parseable.
      JSON.parse(text)
      for (const d of findDuplicateKeys(text, `${locale}/${f}`)) {
        found.push({ file: `${locale}/${f}`, path: d })
      }
    }
  }
  return { files, duplicates: found }
}

// CLI entry (skipped when imported by the test).
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const { files, duplicates } = scanLocales()
  for (const d of duplicates) console.error(`DUPLICATE ${d.file} :: ${d.path}`)
  console.log(`${files} locale files scanned — ${duplicates.length === 0 ? 'no duplicate keys' : duplicates.length + ' DUPLICATE key(s) found'}`)
  process.exit(duplicates.length === 0 ? 0 : 1)
}
