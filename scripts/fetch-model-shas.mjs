#!/usr/bin/env node
/**
 * scripts/fetch-model-shas.mjs
 *
 * Resolves the REAL, AUTHORITATIVE SHA256 for every pinned download in the
 * local-engine registries and replaces the `__SHA_PLACEHOLDER_*__` markers with
 * them, so the installers' verification path (which currently SKIPS on a
 * placeholder — audit C2) actually runs.
 *
 * Sources of truth (no multi-GB downloads for the big files):
 *   - HuggingFace LFS files: the file's `lfs.oid` from the repo tree API IS its
 *     sha256 — the publisher's recorded hash. Fetched via
 *     https://huggingface.co/api/models/<repo>/tree/<ref>/<dir>?recursive=1
 *   - HuggingFace NON-LFS files (small configs, e.g. *.onnx.json): downloaded and
 *     hashed locally (they are tiny).
 *   - GitHub release assets (sidecar binary zips): the asset `digest`
 *     ("sha256:<hex>") from the releases API, else downloaded + hashed.
 *
 * Caveat (documented, not silently ignored): HF URLs pin to `resolve/main`, a
 * MUTABLE ref. We record main's CURRENT oid. If upstream later changes the file,
 * verification will FAIL LOUDLY at install time (the safe failure) rather than
 * run changed bytes. To make it immutable, repin the URLs to a commit sha.
 *
 * Usage:
 *   node scripts/fetch-model-shas.mjs            # dry-run: print resolved map
 *   node scripts/fetch-model-shas.mjs --write     # patch the registry files
 */

import { readFileSync, writeFileSync, createWriteStream, mkdtempSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { createHash } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WRITE = process.argv.includes('--write')

const REGISTRIES = [
  join(__dirname, '..', 'apps', 'desktop', 'electron', 'services', 'llama-cpp-models.ts'),
  join(__dirname, '..', 'apps', 'desktop', 'electron', 'services', 'sd-cpp-models.ts'),
  join(__dirname, '..', 'apps', 'desktop', 'electron', 'services', 'piper-models.ts'),
]

// ── helpers ─────────────────────────────────────────────────────────────────

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'tachi-sha-fetch' } })
    if (res.ok) return res.json()
    // 429/401 from HF is often transient rate-limiting on rapid anonymous calls.
    if ((res.status === 429 || res.status === 401) && i < tries - 1) {
      await new Promise(r => setTimeout(r, 1500 * (i + 1)))
      continue
    }
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
}

/** sha256 of a remote file by streaming it to disk (used for small / non-LFS). */
async function hashRemote(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'tachi-sha-fetch' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const h = createHash('sha256')
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    h.update(value)
  }
  return h.digest('hex')
}

// repo + ref + path from a HF resolve URL.
function parseHf(url) {
  const m = url.match(/^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+)$/)
  if (!m) return null
  return { repo: m[1], ref: m[2], path: m[3] }
}

// owner/repo + tag + asset from a GitHub release download URL.
function parseGh(url) {
  const m = url.match(/^https:\/\/github\.com\/(.+?)\/(.+?)\/releases\/download\/(.+?)\/(.+)$/)
  if (!m) return null
  return { owner: m[1], repo: m[2], tag: m[3], asset: m[4] }
}

// HF tree entries can be paginated + nested; fetch recursively for the dir.
async function hfOid(repo, ref, path) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const api = `https://huggingface.co/api/models/${repo}/tree/${ref}/${dir}?recursive=1&expand=1`
  const tree = await getJson(api)
  const entry = tree.find(e => e.path === path)
  if (!entry) throw new Error(`not found in tree: ${path} @ ${repo}`)
  if (entry.lfs && entry.lfs.oid) return { sha: entry.lfs.oid, lfs: true }
  return { sha: null, lfs: false } // non-LFS → caller hashes by download
}

const ghCache = new Map()
async function ghDigest(owner, repo, tag, asset) {
  const key = `${owner}/${repo}@${tag}`
  if (!ghCache.has(key)) {
    ghCache.set(key, await getJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`))
  }
  const rel = ghCache.get(key)
  const a = (rel.assets || []).find(x => x.name === asset)
  if (a && typeof a.digest === 'string' && a.digest.startsWith('sha256:')) return a.digest.slice(7)
  return null // no published digest → caller hashes by download
}

/** Resolve one (placeholderToken → sha) for a given url. */
async function resolveSha(url) {
  const hf = parseHf(url)
  if (hf) {
    const { sha, lfs } = await hfOid(hf.repo, hf.ref, hf.path)
    if (lfs) return { sha, method: 'hf-lfs-oid' }
    return { sha: await hashRemote(url), method: 'hf-download-hash' }
  }
  const gh = parseGh(url)
  if (gh) {
    const d = await ghDigest(gh.owner, gh.repo, gh.tag, gh.asset)
    if (d) return { sha: d, method: 'gh-asset-digest' }
    return { sha: await hashRemote(url), method: 'gh-download-hash' }
  }
  return { sha: await hashRemote(url), method: 'download-hash' }
}

// ── main ──────────────────────────────────────────────────────────────────

// Pull every (url, placeholderToken) pair from a registry's text. The url and
// its sha placeholder live in the same object literal; we associate each
// placeholder with the nearest preceding url in source order.
function extractPairs(text) {
  const tokens = [] // { kind: 'url'|'sha', value, index }
  // piper uses onnxUrl/configUrl rather than url; capture all *Url: fields.
  const urlRe = /(?:url|onnxUrl|configUrl):\s*(?:`([^`]+)`|'([^']+)')/g
  const shaRe = /(?:sha256|onnxSha|configSha|cudartSha256):\s*'(__SHA_PLACEHOLDER_[^']+__)'/g
  let m
  while ((m = urlRe.exec(text))) tokens.push({ kind: 'url', value: (m[1] ?? m[2]), index: m.index })
  while ((m = shaRe.exec(text))) tokens.push({ kind: 'sha', value: m[1], index: m.index })
  tokens.sort((a, b) => a.index - b.index)
  // Capture ALL top-level string/template consts so url templates expand,
  // including nested refs (RELEASE_BASE itself contains ${LLAMA_CPP_VERSION}).
  const consts = {}
  for (const cm of text.matchAll(/(?:const|export const)\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/g)) consts[cm[1]] = cm[2]
  for (const cm of text.matchAll(/(?:const|export const)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/g)) consts[cm[1]] = cm[2]
  const expand = (u) => {
    let prev, out = u
    for (let i = 0; i < 6; i++) {            // iterate for nested ${} refs
      prev = out
      out = out.replace(/\$\{(\w+)\}/g, (_, k) => (k in consts ? consts[k] : `\${${k}}`))
      if (out === prev) break
    }
    return out
  }
  const pairs = []
  let lastUrl = null
  for (const t of tokens) {
    if (t.kind === 'url') lastUrl = expand(t.value)
    else if (t.kind === 'sha' && lastUrl) pairs.push({ url: lastUrl, token: t.value })
  }
  return pairs
}

async function run() {
  const resolved = new Map() // token → sha
  const report = []
  for (const file of REGISTRIES) {
    const text = readFileSync(file, 'utf8')
    const pairs = extractPairs(text)
    for (const { url, token } of pairs) {
      if (resolved.has(token)) continue
      try {
        const { sha, method } = await resolveSha(url)
        if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`bad sha: ${sha}`)
        resolved.set(token, sha)
        report.push({ token, sha, method, url })
        console.log(`  ✓ ${token}\n      ${sha}  (${method})`)
      } catch (e) {
        report.push({ token, sha: null, method: 'FAILED', url, error: String(e.message || e) })
        console.warn(`  ✗ ${token} — ${e.message || e}`)
      }
    }
  }

  const ok = report.filter(r => r.sha).length
  console.log(`\nResolved ${ok}/${report.length} SHAs.`)

  if (!WRITE) {
    console.log('\n(dry run — re-run with --write to patch the registry files)')
    return
  }

  let patched = 0
  for (const file of REGISTRIES) {
    let text = readFileSync(file, 'utf8')
    for (const [token, sha] of resolved) {
      if (text.includes(token)) { text = text.split(token).join(sha); patched++ }
    }
    writeFileSync(file, text, 'utf8')
  }
  const remaining = report.filter(r => !r.sha)
  console.log(`\nPatched ${patched} placeholder(s) across ${REGISTRIES.length} files.`)
  if (remaining.length) {
    console.log(`\n${remaining.length} UNRESOLVED (left as placeholders — verification still skipped for these):`)
    for (const r of remaining) console.log(`  - ${r.token}: ${r.error}`)
  }
}

run().catch(e => { console.error(e); process.exit(1) })
