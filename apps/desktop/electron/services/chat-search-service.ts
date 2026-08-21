// apps/desktop/electron/services/chat-search-service.ts
//
// SQLite FTS5 full-text search over saved chat conversations (STEAL 2026-07-07,
// cluster C1: TencentDB schema shape + lossless-claw FTS5 hardening + orca's
// mtime-rescan scanner).
//
// DESIGN: the JSON files under ${userData}/conversations/ (written by
// chat.ipc.ts on every completed assistant turn) remain the source of truth.
// This service maintains a DERIVED search index next to them — losing the
// index loses nothing; it rebuilds from the JSON on the next search.
//
// Engine: node-sqlite3-wasm (SQLite 3.53 w/ FTS5 compiled to wasm) — chosen
// over better-sqlite3 deliberately: identical behavior in Electron main and
// vitest with ZERO native-ABI pain (no electron-rebuild, no prebuild dance —
// the exact bug class that has bitten this repo's packaged builds before).
// Chat-scale corpora (MBs of text) don't need native speed.
//
// Query hardening (verified in the 2026-07-07 spike):
// - FTS5 MATCH gets sanitizeFts5Query (quote-wrapped tokens);
// - CJK queries bypass FTS entirely (unicode61 can't segment them) → LIKE scan
//   with escaped pattern + hand-built snippet;
// - any MATCH error falls back to the LIKE path (belt-and-suspenders).

import { readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeFts5Query, containsCjk, escapeLike, buildLikeSnippet } from './util/fts-query'

// Types kept in sync with mcp/tools/history.ts (the same JSON files).
interface SavedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; filename?: string }>
}
interface SavedConversation {
  id: string
  title: string
  messages: SavedMessage[]
  providerId?: string
  model?: string
  createdAt?: string
  updatedAt?: string
}

export interface ChatSearchHit {
  convId:    string
  title:     string
  turnIndex: number
  role:      string
  snippet:   string
  updatedAt: string
}

export interface ChatIndexStatus {
  conversations: number
  messages:      number
}

const ID_RE = /^[\w-]{1,128}$/
const SCHEMA_VERSION = '1'
const MAX_SNIPPET_TOKENS = 12

function messageText(m: SavedMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
}

/**
 * Factory with injectable dirs so tests run on temp folders without electron.
 * The app-level singleton below feeds it the real userData paths.
 */
export function createChatIndex(opts: { conversationsDir: string; indexDir: string }) {
  // Lazy import keeps wasm instantiation off the startup path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null

  function getDb() {
    if (db) return db
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('node-sqlite3-wasm') as { Database: new (path: string) => unknown }
    mkdirSync(opts.indexDir, { recursive: true })
    db = new Database(join(opts.indexDir, 'chat-index.db'))
    ensureSchema()
    return db
  }

  function ensureSchema(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '', mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
        msg_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        conv_id TEXT NOT NULL, turn_index INTEGER NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (conv_id, turn_index)
      );
    `)
    // Schema fingerprint (TencentDB embedding_meta pattern): version mismatch →
    // drop derived tables and rebuild from the JSON source of truth.
    const row = db.get('SELECT value FROM meta WHERE key = ?', ['schema_version']) as { value?: string } | undefined
    if (row?.value !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS messages_fts')
      db.exec('DELETE FROM conversations; DELETE FROM messages;')
      db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', SCHEMA_VERSION])
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, conv_id UNINDEXED, turn_index UNINDEXED, role UNINDEXED
      );
    `)
  }

  function listSourceFiles(): Array<{ id: string; mtimeMs: number; size: number }> {
    let names: string[] = []
    try { names = readdirSync(opts.conversationsDir) } catch { return [] }
    const out: Array<{ id: string; mtimeMs: number; size: number }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!ID_RE.test(id)) continue
      try {
        const st = statSync(join(opts.conversationsDir, name))
        out.push({ id, mtimeMs: Math.floor(st.mtimeMs), size: st.size })
      } catch { /* raced deletion */ }
    }
    return out
  }

  function indexConversation(id: string, mtimeMs: number, size: number): void {
    let conv: SavedConversation
    try {
      conv = JSON.parse(readFileSync(join(opts.conversationsDir, `${id}.json`), 'utf8')) as SavedConversation
    } catch { return } // unparseable → skip; retried next sync when the file changes
    if (!conv || !Array.isArray(conv.messages)) return
    db.run('DELETE FROM messages WHERE conv_id = ?', [id])
    db.run('DELETE FROM messages_fts WHERE conv_id = ?', [id])
    let count = 0
    for (let i = 0; i < conv.messages.length; i++) {
      const text = messageText(conv.messages[i]).trim()
      if (!text) continue
      const role = conv.messages[i].role ?? 'user'
      db.run('INSERT OR REPLACE INTO messages (conv_id, turn_index, role, content) VALUES (?, ?, ?, ?)', [id, i, role, text])
      db.run('INSERT INTO messages_fts (content, conv_id, turn_index, role) VALUES (?, ?, ?, ?)', [text, String(id), String(i), role])
      count++
    }
    db.run(
      'INSERT OR REPLACE INTO conversations (id, title, updated_at, mtime_ms, size, msg_count) VALUES (?, ?, ?, ?, ?, ?)',
      [id, conv.title ?? '', conv.updatedAt ?? '', mtimeMs, size, count],
    )
  }

  /** Incremental sync: (mtime,size)-changed files re-index; vanished files drop out. */
  function sync(): { indexed: number; removed: number; total: number; ms: number } {
    const started = Date.now()
    getDb()
    const source = listSourceFiles()
    const known = new Map<string, { mtime_ms: number; size: number }>(
      (db.all('SELECT id, mtime_ms, size FROM conversations') as Array<{ id: string; mtime_ms: number; size: number }>)
        .map(r => [r.id, { mtime_ms: r.mtime_ms, size: r.size }]),
    )
    let indexed = 0
    const seen = new Set<string>()
    for (const f of source) {
      seen.add(f.id)
      const prev = known.get(f.id)
      if (prev && prev.mtime_ms === f.mtimeMs && prev.size === f.size) continue
      indexConversation(f.id, f.mtimeMs, f.size)
      indexed++
    }
    let removed = 0
    for (const id of known.keys()) {
      if (seen.has(id)) continue
      db.run('DELETE FROM messages WHERE conv_id = ?', [id])
      db.run('DELETE FROM messages_fts WHERE conv_id = ?', [id])
      db.run('DELETE FROM conversations WHERE id = ?', [id])
      removed++
    }
    return { indexed, removed, total: source.length, ms: Date.now() - started }
  }

  function likeSearch(query: string, limit: number): ChatSearchHit[] {
    const pattern = `%${escapeLike(query.trim())}%`
    const rows = db.all(
      `SELECT m.conv_id, m.turn_index, m.role, m.content, c.title, c.updated_at
         FROM messages m JOIN conversations c ON c.id = m.conv_id
        WHERE m.content LIKE ? ESCAPE '\\'
        ORDER BY c.updated_at DESC, m.turn_index ASC LIMIT ?`,
      [pattern, limit],
    ) as Array<{ conv_id: string; turn_index: number; role: string; content: string; title: string; updated_at: string }>
    return rows.map(r => ({
      convId: r.conv_id, title: r.title, turnIndex: r.turn_index, role: r.role,
      snippet: buildLikeSnippet(r.content, query), updatedAt: r.updated_at,
    }))
  }

  /** Full-text search; syncs the index first (cheap: stat-scan + changed files only). */
  function search(query: string, limit = 20): { hits: ChatSearchHit[]; mode: 'fts' | 'like' } {
    getDb()
    sync()
    const q = query.trim()
    if (!q) return { hits: [], mode: 'fts' }
    if (containsCjk(q)) return { hits: likeSearch(q, limit), mode: 'like' }
    try {
      const rows = db.all(
        `SELECT f.conv_id, f.turn_index, f.role,
                snippet(messages_fts, 0, '«', '»', '…', ${MAX_SNIPPET_TOKENS}) AS snip,
                c.title, c.updated_at
           FROM messages_fts f JOIN conversations c ON c.id = f.conv_id
          WHERE messages_fts MATCH ?
          ORDER BY bm25(messages_fts) LIMIT ?`,
        [sanitizeFts5Query(q), limit],
      ) as Array<{ conv_id: string; turn_index: number; role: string; snip: string; title: string; updated_at: string }>
      return {
        hits: rows.map(r => ({
          convId: r.conv_id, title: r.title, turnIndex: Number(r.turn_index), role: r.role,
          snippet: r.snip, updatedAt: r.updated_at,
        })),
        mode: 'fts',
      }
    } catch {
      // Sanitizer edge case → degrade to the LIKE scan rather than erroring.
      return { hits: likeSearch(q, limit), mode: 'like' }
    }
  }

  function status(): ChatIndexStatus {
    getDb()
    const c = db.get('SELECT COUNT(*) AS n FROM conversations') as { n: number }
    const m = db.get('SELECT COUNT(*) AS n FROM messages') as { n: number }
    return { conversations: c.n, messages: m.n }
  }

  function close(): void {
    try { db?.close() } catch { /* already closed */ }
    db = null
  }

  return { sync, search, status, close }
}

// ── App-level singleton on the real userData paths ───────────────────────────

let appIndex: ReturnType<typeof createChatIndex> | null = null

export function getChatIndex(): ReturnType<typeof createChatIndex> {
  if (!appIndex) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    appIndex = createChatIndex({
      conversationsDir: join(app.getPath('userData'), 'conversations'),
      indexDir:         join(app.getPath('userData'), 'chat-index'),
    })
  }
  return appIndex
}
