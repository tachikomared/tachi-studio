// apps/desktop/electron/services/ollama-service.ts
//
// Zero-terminal Ollama support: detect, auto-start, list installed models.
// User picks "Ollama (local)" in chat → we make sure it's running before
// the first request. No CLI required.
import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

const OLLAMA_BASE = 'http://127.0.0.1:11434'
const HEALTH_POLL_INTERVAL_MS = 400
const MAX_HEALTH_ATTEMPTS      = 25  // ~10 s

let spawnedProc: ChildProcess | null = null

export interface OllamaModel {
  name:        string  // e.g. "llama3.2:latest"
  size:        number  // bytes
  modified_at: string
  digest:      string
  details?: {
    family?:        string
    parameter_size?: string
    quantization_level?: string
  }
}

/**
 * Probe /api/tags. Returns true if Ollama answers within 1.5 s.
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(1500) as AbortSignal,
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Find the ollama executable on disk. Returns an absolute path or null.
 * Covers the default installer paths on each OS — users who installed via
 * Homebrew / scoop / a custom prefix should still have it on PATH, which
 * `spawn` will resolve.
 */
export function findOllamaBinary(): string | null {
  const home = homedir()
  const candidates: string[] = []

  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    candidates.push(
      join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      join(programFiles, 'Ollama', 'ollama.exe'),
    )
  } else if (platform() === 'darwin') {
    candidates.push(
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
    )
  } else {
    // Linux
    candidates.push(
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      join(home, '.local', 'bin', 'ollama'),
    )
  }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Fall back to relying on PATH — spawn will try to resolve.
  return null
}

/**
 * Make sure Ollama is reachable. Probes first; if down, tries to spawn
 * `ollama serve` from the detected binary path (or via PATH). Polls until
 * healthy or times out.
 *
 * Throws with a user-friendly message if it can't find/start Ollama —
 * caller is expected to surface this to the renderer.
 */
export async function ensureOllamaRunning(): Promise<void> {
  if (await isOllamaRunning()) return

  // Don't spawn duplicate instances
  if (spawnedProc && spawnedProc.exitCode === null) {
    // Already starting — wait for it
    for (let i = 0; i < MAX_HEALTH_ATTEMPTS; i++) {
      if (await isOllamaRunning()) return
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
    }
    throw new Error('Ollama did not become ready within the expected time.')
  }

  const binary = findOllamaBinary() ?? 'ollama'  // fall back to PATH

  let proc: ChildProcess
  try {
    proc = spawn(binary, ['serve'], {
      stdio:    'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
      // On Windows, detached requires shell:true which we avoid. Letting the
      // process attach to the Electron parent is fine — it'll be cleaned up
      // by the OS when Electron exits.
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not spawn Ollama. Make sure it's installed (https://ollama.com/download). Detail: ${msg}`,
    )
  }

  spawnedProc = proc
  proc.on('exit', () => { if (spawnedProc === proc) spawnedProc = null })
  // Don't tie Ollama's lifetime to ours on Unix (detached + unref keeps it
  // running for other clients). On Windows we have no choice — it dies with us.
  if (process.platform !== 'win32') proc.unref()

  // Poll for health
  for (let i = 0; i < MAX_HEALTH_ATTEMPTS; i++) {
    if (await isOllamaRunning()) return
    if (proc.exitCode !== null) {
      throw new Error(`Ollama exited immediately (code ${proc.exitCode}). Is it installed and not blocked by another instance?`)
    }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  throw new Error('Ollama started but did not respond on :11434 in time.')
}

/**
 * List models the user has pulled. Ensures Ollama is running first.
 */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  await ensureOllamaRunning()
  const res = await fetch(`${OLLAMA_BASE}/api/tags`)
  if (!res.ok) throw new Error(`/api/tags returned ${res.status}`)
  const data = await res.json() as { models?: OllamaModel[] }
  return data.models ?? []
}

/**
 * Lifecycle: called from app.on('will-quit') so we don't leave a serve
 * process orphaned on Windows (where unref isn't reliable).
 */
export function stopOllamaIfWeStartedIt(): void {
  if (spawnedProc && spawnedProc.exitCode === null) {
    try { spawnedProc.kill() } catch { /* best effort */ }
    spawnedProc = null
  }
}

export interface OllamaPullProgress {
  status: string
  completed?: number
  total?: number
}

/** Delete a locally-installed Ollama model via DELETE /api/delete. */
export async function deleteOllamaModel(name: string): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE}/api/delete`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    // Send both keys — `model` is the current field, `name` the legacy one.
    body: JSON.stringify({ model: name, name }),
    signal: AbortSignal.timeout(15_000) as AbortSignal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`/api/delete returned ${res.status}${detail ? `: ${detail}` : ''}`)
  }
}

/**
 * Pull a model via POST /api/pull (NDJSON stream of progress objects).
 * Ensures Ollama is running first. Calls `onProgress` for each status line.
 */
export async function pullOllamaModel(
  name: string,
  onProgress: (p: OllamaPullProgress) => void,
): Promise<void> {
  await ensureOllamaRunning()
  const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `model` is the current field, `name` the legacy one — send both.
    body: JSON.stringify({ model: name, name, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`/api/pull returned ${res.status}`)

  // Parse one NDJSON line. JSON.parse throws SyntaxError on a malformed
  // (e.g. partial) line — swallow only that; re-throw a real Ollama error.
  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const obj = JSON.parse(trimmed) as OllamaPullProgress & { error?: string }
      if (obj.error) throw new Error(obj.error)
      onProgress(obj)
    } catch (err) {
      if (err instanceof SyntaxError) return // ignore malformed partial JSON
      throw err
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  // Flush the decoder + any final line that lacked a trailing newline — some
  // Ollama versions end the stream (including the final "success") without one.
  buf += decoder.decode()
  if (buf.trim()) handleLine(buf)
}
