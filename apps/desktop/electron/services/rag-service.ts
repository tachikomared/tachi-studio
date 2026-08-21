// apps/desktop/electron/services/rag-service.ts
//
// LOCAL folder RAG — activates the dormant @tachi/core rag primitives
// (chunkText + VectorStore + cosine) with a real in-process embedder:
// all-MiniLM-L6-v2 (384-dim, ~25MB q8 ONNX) via @huggingface/transformers,
// running on onnxruntime-node in the MAIN process. No cloud, no server:
// index and query never leave the machine.
//
// PRIVATE MODE: embedding itself is local, but the MODEL is downloaded from
// huggingface.co on first use — that download is gated: in private mode an
// uncached model returns a clear error instead of egressing.
//
// Index lifecycle: userData/rag/indexes/<sha1(root)>.json. An index is reused
// while its file-signature (count + newest mtime over indexable files) is
// unchanged; otherwise rebuilt. Flat cosine scan — see vector-store.ts.

import { app } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, mkdirSync } from 'fs'
import { join, extname, resolve as resolvePath, sep } from 'path'
import { createHash } from 'crypto'
import { chunkText, VectorStore, type StoredVector, type ScoredChunk } from '@tachi/core'
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'
import { extractPdfText } from './pdf-extract'
import { isSensitiveFileName, isSensitiveDirName } from './util/sensitive-files'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const EMBED_BATCH = 24
const MAX_FILES = 400
const MAX_FILE_BYTES = 512 * 1024
// PDFs are binary and legitimately larger than the text cap — extraction
// produces a bounded text layer, so allow a bigger source file for them.
const MAX_PDF_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_CHUNKS = 4000
const SNIPPET_CHARS = 1200

const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.sql',
  '.yaml', '.yml', '.toml', '.css', '.html', '.sh', '.ps1',
])
// PDFs are indexed via local text-layer extraction (STEAL 2026-07-08), so a
// user's docs/reports folder becomes searchable, not just its code/markdown.
const PDF_EXT = '.pdf'
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'release-build', '.next',
  'coverage', '__pycache__', 'venv', '.venv', 'target', '.idea', '.vscode',
])

function ragRoot(): string { return join(app.getPath('userData'), 'rag') }
function modelsDir(): string { return join(ragRoot(), 'models') }
function indexesDir(): string { return join(ragRoot(), 'indexes') }
function indexPath(root: string): string {
  return join(indexesDir(), `${createHash('sha1').update(resolvePath(root).toLowerCase()).digest('hex').slice(0, 16)}.json`)
}

// ── Embedder (lazy singleton) ─────────────────────────────────────────────────

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
let embedderPromise: Promise<FeatureExtractor> | null = null

function modelCached(): boolean {
  // transformers.js cache layout: <cache_dir>/<model id with / kept>/…
  return existsSync(join(modelsDir(), ...MODEL_ID.split('/')))
}

async function getEmbedder(): Promise<FeatureExtractor> {
  if (!embedderPromise) {
    if (getCurrentPrivacyMode() === 'private' && !modelCached()) {
      throw new Error('RAG model is not downloaded yet and PRIVATE MODE blocks the one-time download. Leave private mode once to fetch it (~25MB), then it runs fully offline.')
    }
    embedderPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = modelsDir()
      mkdirSync(modelsDir(), { recursive: true })
      const pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
      return pipe as unknown as FeatureExtractor
    })()
    embedderPromise.catch(() => { embedderPromise = null }) // allow retry after failure
  }
  return embedderPromise
}

async function embed(texts: string[]): Promise<number[][]> {
  const pipe = await getEmbedder()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const t = await pipe(batch, { pooling: 'mean', normalize: true })
    out.push(...t.tolist())
  }
  return out
}

// ── Folder walking ────────────────────────────────────────────────────────────

interface WalkedFile { abs: string; rel: string; mtimeMs: number; size: number }

async function walkFolder(root: string): Promise<WalkedFile[]> {
  const rootAbs = resolvePath(root)
  const out: WalkedFile[] = []
  const stack = [rootAbs]
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop()!
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        // Skip build noise AND credential stores (.ssh/.aws/…) fail-closed.
        if (!SKIP_DIRS.has(e.name) && !isSensitiveDirName(e.name) && !e.name.startsWith('.')) stack.push(abs)
        continue
      }
      const ext = extname(e.name).toLowerCase()
      const isPdf = ext === PDF_EXT
      if (!e.isFile() || (!TEXT_EXTS.has(ext) && !isPdf)) continue
      // Never ingest secret-bearing files (a secrets.yaml has a "text" ext).
      if (isSensitiveFileName(e.name)) continue
      try {
        const st = await fs.stat(abs)
        if (st.size === 0 || st.size > (isPdf ? MAX_PDF_BYTES : MAX_FILE_BYTES)) continue
        out.push({ abs, rel: abs.slice(rootAbs.length + 1).split(sep).join('/'), mtimeMs: st.mtimeMs, size: st.size })
      } catch { /* unreadable — skip */ }
    }
  }
  return out
}

/** Cheap change signature: file count + newest mtime + total bytes. */
function signatureOf(files: WalkedFile[]): string {
  const newest = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
  const bytes = files.reduce((s, f) => s + f.size, 0)
  return `${files.length}:${Math.round(newest)}:${bytes}`
}

// ── Index build / load ────────────────────────────────────────────────────────

interface PersistedIndex { signature: string; builtAt: number; files: number; chunks: number; store: string }
const memCache = new Map<string, { signature: string; store: VectorStore }>()

export interface RagIndexResult { ok: boolean; files?: number; chunks?: number; ms?: number; reused?: boolean; error?: string }

export async function indexFolder(root: string, force = false): Promise<RagIndexResult> {
  const t0 = Date.now()
  try {
    const files = await walkFolder(root)
    if (files.length === 0) return { ok: false, error: 'No indexable text files found in this folder.' }
    const signature = signatureOf(files)
    const pPath = indexPath(root)

    if (!force) {
      const cached = memCache.get(pPath)
      if (cached && cached.signature === signature) {
        return { ok: true, files: files.length, chunks: cached.store.size, ms: Date.now() - t0, reused: true }
      }
      try {
        const disk = JSON.parse(await fs.readFile(pPath, 'utf8')) as PersistedIndex
        if (disk.signature === signature) {
          const store = VectorStore.deserialize(disk.store)
          memCache.set(pPath, { signature, store })
          return { ok: true, files: disk.files, chunks: store.size, ms: Date.now() - t0, reused: true }
        }
      } catch { /* no disk index — build */ }
    }

    const store = new VectorStore()
    let total = 0
    for (const f of files) {
      if (total >= MAX_TOTAL_CHUNKS) break
      let text: string
      try {
        if (extname(f.abs).toLowerCase() === PDF_EXT) {
          const buf = await fs.readFile(f.abs)
          const res = await extractPdfText(new Uint8Array(buf))
          if (!res.ok || res.scanned || !res.text.trim()) continue   // skip unreadable/scanned PDFs
          text = res.text
        } else {
          text = await fs.readFile(f.abs, 'utf8')
        }
      } catch { continue }
      const chunks = chunkText(text, f.rel).slice(0, MAX_TOTAL_CHUNKS - total)
      if (chunks.length === 0) continue
      const vectors = await embed(chunks.map(c => c.text))
      store.add(chunks.map((chunk, i): StoredVector => ({ id: chunk.id, chunk, vector: vectors[i] })))
      total += chunks.length
    }

    mkdirSync(indexesDir(), { recursive: true })
    const persisted: PersistedIndex = { signature, builtAt: Date.now(), files: files.length, chunks: store.size, store: store.serialize() }
    await fs.writeFile(pPath, JSON.stringify(persisted), 'utf8')
    memCache.set(pPath, { signature, store })
    return { ok: true, files: files.length, chunks: store.size, ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface RagSearchHit { path: string; startLine: number; endLine: number; score: number; text: string }

export async function searchFolder(root: string, query: string, k = 6): Promise<{ ok: boolean; hits?: RagSearchHit[]; error?: string; indexed?: { files: number; chunks: number; reused: boolean } }> {
  const idx = await indexFolder(root, false)
  if (!idx.ok) return { ok: false, error: idx.error }
  const store = memCache.get(indexPath(root))!.store
  try {
    const [qv] = await embed([query])
    const hits: ScoredChunk[] = store.query(qv, k)
    return {
      ok: true,
      indexed: { files: idx.files ?? 0, chunks: idx.chunks ?? 0, reused: !!idx.reused },
      hits: hits.map(h => ({
        path: h.chunk.path,
        startLine: h.chunk.startLine,
        endLine: h.chunk.endLine,
        score: Math.round(h.score * 1000) / 1000,
        text: h.chunk.text.length > SNIPPET_CHARS ? `${h.chunk.text.slice(0, SNIPPET_CHARS)}…` : h.chunk.text,
      })),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function ragStatus(root: string): { indexed: boolean; modelCached: boolean } {
  return { indexed: existsSync(indexPath(root)), modelCached: modelCached() }
}
