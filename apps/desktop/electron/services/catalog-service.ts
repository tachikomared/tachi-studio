// apps/desktop/electron/services/catalog-service.ts
//
// Builds the curated catalog (llama.cpp GGUF registry + a small recommended
// Ollama set) and the installed-model list (across both runtimes). Fit badges
// are NOT computed here — the renderer computes them via @tachi/core using the
// hardware profile it already holds.

import { statSync } from 'node:fs'
import type { CatalogEntry, InstalledModel } from '@tachi/core'
import { deriveCapabilities } from '@tachi/core'
import { GGUF_MODELS } from './llama-cpp-models'
import { listDownloadedModels, ggufModelPath } from './llama-cpp-installer'
import { listOllamaModels, isOllamaRunning } from './ollama-service'
import { PIPER_VOICES } from './piper-models'
import { listInstalledVoices, voiceOnnxPath } from './piper-installer'
import { WHISPER_MODELS, type WhisperModelName } from './whisper-models'
import { whisperModelPath } from './whisper-installer'
import { listInstalledSdModels, modelComponentPaths } from './sd-cpp-installer'

const MB = 1024 * 1024

/**
 * Recommended Ollama tags spanning sizes and capabilities. Sizes are
 * approximate Q4 download sizes (MB). Names embed capability hints (Coder /
 * Vision / R1) so deriveCapabilities tags them for the UI badges.
 */
interface CuratedOllama { name: string; family: string; params: string; tag: string; sizeMb: number }
const OLLAMA_CURATED: CuratedOllama[] = [
  // ── General chat — small to large ──────────────────────────────────────────
  { name: 'Llama 3.2 1B',          family: 'llama',   params: '1B',   tag: 'llama3.2:1b',       sizeMb: 1300 },
  { name: 'Llama 3.2 3B',          family: 'llama',   params: '3B',   tag: 'llama3.2:3b',       sizeMb: 2000 },
  { name: 'Llama 3.1 8B',          family: 'llama',   params: '8B',   tag: 'llama3.1:8b',       sizeMb: 4700 },
  { name: 'Llama 3.3 70B',         family: 'llama',   params: '70B',  tag: 'llama3.3:70b',      sizeMb: 43000 },
  { name: 'Qwen2.5 3B',            family: 'qwen',    params: '3B',   tag: 'qwen2.5:3b',        sizeMb: 1900 },
  { name: 'Qwen2.5 7B',            family: 'qwen',    params: '7B',   tag: 'qwen2.5:7b',        sizeMb: 4700 },
  { name: 'Qwen2.5 14B',           family: 'qwen',    params: '14B',  tag: 'qwen2.5:14b',       sizeMb: 9000 },
  { name: 'Qwen2.5 32B',           family: 'qwen',    params: '32B',  tag: 'qwen2.5:32b',       sizeMb: 20000 },
  { name: 'Gemma 2 2B',            family: 'gemma',   params: '2B',   tag: 'gemma2:2b',         sizeMb: 1600 },
  { name: 'Gemma 2 9B',            family: 'gemma',   params: '9B',   tag: 'gemma2:9b',         sizeMb: 5400 },
  { name: 'Gemma 2 27B',           family: 'gemma',   params: '27B',  tag: 'gemma2:27b',        sizeMb: 16000 },
  { name: 'Phi-3.5 Mini',          family: 'phi',     params: '3.8B', tag: 'phi3.5:3.8b',       sizeMb: 2200 },
  { name: 'Mistral 7B',            family: 'mistral', params: '7B',   tag: 'mistral:7b',        sizeMb: 4400 },
  { name: 'Mistral Nemo 12B',      family: 'mistral', params: '12B',  tag: 'mistral-nemo:12b',  sizeMb: 7100 },
  // ── Reasoning ───────────────────────────────────────────────────────────────
  { name: 'DeepSeek-R1 7B',        family: 'deepseek', params: '7B',  tag: 'deepseek-r1:7b',    sizeMb: 4700 },
  { name: 'DeepSeek-R1 8B',        family: 'deepseek', params: '8B',  tag: 'deepseek-r1:8b',    sizeMb: 4900 },
  { name: 'DeepSeek-R1 14B',       family: 'deepseek', params: '14B', tag: 'deepseek-r1:14b',   sizeMb: 9000 },
  { name: 'DeepSeek-R1 32B',       family: 'deepseek', params: '32B', tag: 'deepseek-r1:32b',   sizeMb: 20000 },
  // ── Code ────────────────────────────────────────────────────────────────────
  { name: 'Qwen2.5 Coder 7B',      family: 'qwen',    params: '7B',   tag: 'qwen2.5-coder:7b',  sizeMb: 4700 },
  { name: 'Qwen2.5 Coder 14B',     family: 'qwen',    params: '14B',  tag: 'qwen2.5-coder:14b', sizeMb: 9000 },
  { name: 'CodeLlama 7B',          family: 'llama',   params: '7B',   tag: 'codellama:7b',      sizeMb: 3800 },
  { name: 'CodeLlama 13B',         family: 'llama',   params: '13B',  tag: 'codellama:13b',     sizeMb: 7400 },
  { name: 'StarCoder2 3B',         family: 'starcoder', params: '3B', tag: 'starcoder2:3b',     sizeMb: 1700 },
  // ── Vision ──────────────────────────────────────────────────────────────────
  { name: 'LLaVA 7B (Vision)',     family: 'llava',   params: '7B',   tag: 'llava:7b',          sizeMb: 4700 },
  { name: 'LLaVA 13B (Vision)',    family: 'llava',   params: '13B',  tag: 'llava:13b',         sizeMb: 8000 },
  { name: 'Llama 3.2 Vision 11B',  family: 'llama',   params: '11B',  tag: 'llama3.2-vision:11b', sizeMb: 7900 },
]

export function buildCuratedCatalog(): CatalogEntry[] {
  const llamacpp: CatalogEntry[] = GGUF_MODELS.map(m => ({
    id: `llamacpp:${m.id}`,
    name: m.label,
    family: m.family,
    params: `${m.paramsB}B`,
    kind: 'text' as const,
    source: 'curated' as const,
    quants: [{ label: m.quant, sizeBytes: m.sizeMb * MB, runtime: 'llamacpp' as const, ref: m.id, recommended: true }],
    capabilities: deriveCapabilities({ name: `${m.label} ${m.family}` }),
  }))

  const ollama: CatalogEntry[] = OLLAMA_CURATED.map(o => ({
    id: `ollama:${o.tag}`,
    name: o.name,
    family: o.family,
    params: o.params,
    kind: 'text' as const,
    source: 'curated' as const,
    quants: [{ label: 'Q4', sizeBytes: o.sizeMb * MB, runtime: 'ollama' as const, ref: o.tag, recommended: true }],
    capabilities: deriveCapabilities({ name: `${o.name} ${o.family}` }),
  }))

  return [...llamacpp, ...ollama]
}

// ── sd.cpp weights: the biggest things on the disk, and the last to be listed ─
//
// listInstalledModels covered four runtimes and not this one, so the multi-GB
// local image/video checkpoints — 5-18 GB each — were the ONLY weights in the
// app with no surface that could see them and no surface that could free them
// (`sd-cpp:remove-model` has been fully implemented and caller-less all along).
//
// ── THE SHARED-BYTES RULE ────────────────────────────────────────────────────
//
// An sd row is a DIRECTORY of components, and curated rows share components on
// purpose: the 5.6 GB umt5 encoder is one file that Wan 2.1 T2V, Wan 2.1 I2V
// and their siblings each hold a hard link to (sd-cpp-installer's
// placeReusedComponent), and the FLUX autoencoder is shared with Z-Image.
// Charging each row for its full component list would have invented ~11 GB of
// usage that is not on the volume.
//
// So the physical file — not the registry declaration, not the path — is the
// unit of accounting. Two passes:
//
//   1. one stat per component with `{ bigint: true }`, keyed by `dev:ino`.
//      That key is the file's IDENTITY: two names for one inode collapse to one
//      key, and the COPY fallback (cross-volume, or a filesystem with no hard
//      links) produces two distinct inodes and is therefore correctly counted
//      twice — it really is two copies of the bytes.
//   2. per row: `sizeBytes` adds a component only when this row is the FIRST
//      installed holder of that inode (charge once, never twice);
//      `freeableBytes` adds it only when this row holds the sole name for it
//      (`holders.length === 1 && nlink <= 1`) — deleting one of two names for a
//      hard-linked file frees nothing, so promising the bytes back would be the
//      lie this whole lane exists to remove; and `sharedWith` names the other
//      installed rows that hold the rest.
//
// nlink is checked ALONGSIDE the holder set rather than instead of it: a link
// count above one can also come from a name outside the installed set (a
// half-installed row's directory), and under-promising freed space is the safe
// direction to be wrong in.
//
// Speed-pack LoRAs are deliberately NOT rows here. They live in the shared
// `loras/` directory under a slug two packs can both declare, and
// `sd-cpp:download-speed-adapter` ships with no remove sibling precisely
// because a naive per-pack delete disarms the other pack's preset. A REMOVE
// button that cannot honestly remove is the same class of lie as an invisible
// weight; their management surface is the storage dashboard, which owns the
// container directory as a whole.
interface SdComponentStat {
  /** Owning model id. */
  id:    string
  /** `dev:ino` — the PHYSICAL file, shared by every hard link to it. */
  key:   string
  size:  number
  nlink: number
}

/** Every component of every installed sd row, one stat each. Exported for the
 *  accounting tests, which drive it through a fake registry + fake fs. */
export function statSdComponents(
  rows: ReadonlyArray<{ id: string }>,
): SdComponentStat[] {
  const out: SdComponentStat[] = []
  for (const m of rows) {
    let paths: Record<string, string> | null = null
    try { paths = modelComponentPaths(m.id) } catch { paths = null }
    for (const dest of Object.values(paths ?? {})) {
      try {
        const st = statSync(dest, { bigint: true })
        out.push({ id: m.id, key: `${st.dev}:${st.ino}`, size: Number(st.size), nlink: Number(st.nlink) })
      } catch { /* component removed mid-list — it costs nothing it cannot be counted for */ }
    }
  }
  return out
}

/** The installed sd.cpp checkpoints as catalog rows, with the shared-bytes rule
 *  above applied. Pure apart from the two sd-cpp reads it starts from. */
export function listInstalledSdRows(): InstalledModel[] {
  let rows: ReturnType<typeof listInstalledSdModels>
  try { rows = listInstalledSdModels() } catch { return [] }
  const comps = statSdComponents(rows)

  // physical file → the installed rows holding a name for it, in listing order.
  const holders = new Map<string, string[]>()
  for (const c of comps) {
    const held = holders.get(c.key) ?? []
    if (!held.includes(c.id)) held.push(c.id)
    holders.set(c.key, held)
  }
  const nameOf = new Map(rows.map(m => [m.id, m.name]))

  return rows.map(m => {
    let sizeBytes = 0
    let freeableBytes = 0
    const sharedWith = new Set<string>()
    for (const c of comps) {
      if (c.id !== m.id) continue
      const held = holders.get(c.key) ?? [m.id]
      if (held[0] === m.id) sizeBytes += c.size
      if (held.length === 1 && c.nlink <= 1) freeableBytes += c.size
      for (const other of held) if (other !== m.id) sharedWith.add(nameOf.get(other) ?? other)
    }
    return {
      runtime: 'sdcpp' as const,
      ref: m.id,
      name: m.name,
      sizeBytes,
      freeableBytes,
      // The one-verb RUN needs this: an image checkpoint and a video checkpoint
      // open DIFFERENT composer modalities, and the Media studio filters its
      // model list by exactly this field.
      mediaKind: m.kind,
      ...(sharedWith.size > 0 ? { sharedWith: [...sharedWith] } : null),
    }
  })
}

export async function listInstalledModels(): Promise<InstalledModel[]> {
  const installed: InstalledModel[] = []

  // llama.cpp: registry ids of downloaded GGUF files. sizeBytes is the REAL
  // on-disk file size — HF-searched GGUFs (hf_<owner>_<file> ids) aren't in the
  // curated registry, and a 0 here starved every downstream size consumer (the
  // Installed-tab size label + the chat model-picker FIT pill). The registry
  // estimate stays as the fallback if the stat races a file delete.
  for (const id of listDownloadedModels()) {
    const meta = GGUF_MODELS.find(m => m.id === id)
    let sizeBytes = 0
    try { sizeBytes = statSync(ggufModelPath(id)).size } catch { /* deleted mid-list — fall back */ }
    if (!(sizeBytes > 0)) sizeBytes = (meta?.sizeMb ?? 0) * MB
    installed.push({
      runtime: 'llamacpp',
      ref: id,
      name: meta?.label ?? id,
      sizeBytes,
    })
  }

  // piper TTS voices. They were downloadable from Catalog but never appeared on
  // the Installed tab, so there was no way to see what a voice was costing or
  // to remove one — the Catalog card only ever flipped DOWNLOAD → RUN.
  // sizeBytes is the REAL `.onnx` file size (the registry's sizeMb is a
  // rounded display number); the tiny `.onnx.json` sidecar is not counted.
  try {
    for (const { id } of listInstalledVoices()) {
      const meta = PIPER_VOICES.find(v => v.id === id)
      let sizeBytes = 0
      try { sizeBytes = statSync(voiceOnnxPath(id)).size } catch { /* removed mid-list */ }
      if (!(sizeBytes > 0)) sizeBytes = (meta?.sizeMb ?? 0) * MB
      // mediaKind: a voice RUNs in the Media studio's TTS modality — the same
      // one-verb handoff the sd rows below get.
      installed.push({ runtime: 'piper', ref: id, name: meta?.name ?? id, sizeBytes, mediaKind: 'tts' })
    }
  } catch { /* piper dirs unreadable — skip the section, never fail the list */ }

  // sd.cpp image/video checkpoints — see the shared-bytes rule above.
  try {
    installed.push(...listInstalledSdRows())
  } catch { /* sd dirs unreadable — skip the section, never fail the list */ }

  // whisper.cpp STT weights. Same gap, bigger stakes: `medium.en` is ~1.5 GB
  // and had no surface that would delete it.
  try {
    for (const name of Object.keys(WHISPER_MODELS) as WhisperModelName[]) {
      const path = whisperModelPath(name)
      let sizeBytes = 0
      try { sizeBytes = statSync(path).size } catch { continue } // not downloaded
      if (!(sizeBytes > 0)) continue
      installed.push({ runtime: 'whisper', ref: name, name: `Whisper ${name}`, sizeBytes })
    }
  } catch { /* whisper dirs unreadable — skip */ }

  // Ollama: pulled models. Listing this catalog must NOT auto-start Ollama
  // (listOllamaModels calls ensureOllamaRunning, which would spawn the process
  // and block up to ~10s). Gate on a passive health probe first.
  try {
    if (await isOllamaRunning()) {
      for (const m of await listOllamaModels()) {
        installed.push({ runtime: 'ollama', ref: m.name, name: m.name, sizeBytes: m.size })
      }
    }
  } catch { /* Ollama unreachable — skip */ }

  return installed
}
