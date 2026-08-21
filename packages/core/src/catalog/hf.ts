// packages/core/src/catalog/hf.ts
//
// Pure helpers for turning HuggingFace Hub API shapes into CatalogEntry.
// Network fetching lives in the desktop hf-search service; this file is
// pure so it can be unit-tested.

import type { CatalogEntry, QuantOption, Capability } from './types.js'

/** Minimal slice of the HF model object we depend on. */
export interface HfSibling { rfilename: string; size?: number }
export interface HfRepoLite {
  id: string
  siblings: HfSibling[]
  /** HF `tags` array (optional — used for capability detection). */
  tags?: string[]
  /** HF `pipeline_tag` (optional — e.g. 'image-text-to-text' for vision). */
  pipelineTag?: string
  /** HF popularity signals (optional). */
  downloads?: number
  likes?: number
}

const QUANT_RE = /\b(IQ\d+[A-Z_]*|Q\d+(?:_[0-9KMSXL]+)*|BF16|F16|F32)\b/i

/** Preferred default quant — best size/quality tradeoff for consumer chat. */
const RECOMMENDED_QUANT = 'Q4_K_M'

export function parseQuantFromFilename(filename: string): string | null {
  const m = filename.match(QUANT_RE)
  return m ? m[1].toUpperCase() : null
}

/**
 * Derive capability tags from a model's name + HF tags + pipeline tag. Pure
 * heuristic. Always includes 'chat' as the baseline. Used for both HF search
 * results and (name-only) curated entries.
 */
export function deriveCapabilities(input: {
  name: string
  tags?: string[]
  pipelineTag?: string
}): Capability[] {
  const hay = `${input.name} ${(input.tags ?? []).join(' ')} ${input.pipelineTag ?? ''}`.toLowerCase()
  const caps = new Set<Capability>(['chat'])

  // Vision / multimodal
  if (/\b(vl|vision|multimodal|llava|image-text-to-text|visual)\b/.test(hay)) caps.add('vision')
  // Reasoning
  if (/\b(r1|qwq|o1|o3|reasoning|thinking|deepseek-r)\b/.test(hay)) caps.add('reasoning')
  // Code
  if (/\b(coder|code|codestral|starcoder|deepseek-coder|codegemma)\b/.test(hay)) caps.add('code')
  // Tool / function calling
  if (/\b(tool|tools|function-calling|function_call|functionary)\b/.test(hay)) caps.add('tools')

  // Media modalities — mostly from the HF pipeline_tag, with name fallbacks.
  const pt = (input.pipelineTag ?? '').toLowerCase()
  if (pt === 'text-to-image' || /\b(stable-diffusion|sdxl|flux|text-to-image)\b/.test(hay)) caps.add('image-gen')
  if (pt === 'text-to-video' || pt === 'image-to-video' || /\b(text-to-video|image-to-video|\bwan\b|animatediff)\b/.test(hay)) caps.add('video-gen')
  if (pt === 'text-to-audio' || /\b(musicgen|text-to-music|stable-audio)\b/.test(hay)) caps.add('music')
  if (pt === 'text-to-speech' || /\b(text-to-speech|piper|\bbark\b)\b/.test(hay)) caps.add('tts')
  if (pt === 'automatic-speech-recognition' || /\b(whisper|speech-to-text|\basr\b)\b/.test(hay)) caps.add('stt')

  return [...caps]
}

/** Pull a "7B"/"3.8B" param size out of a repo id; "" if none found. */
function parseParams(repoId: string): string {
  const m = repoId.match(/(\d+(?:\.\d+)?)\s*[Bb]\b/)
  return m ? `${m[1]}B` : ''
}

/** Display name = repo id's model segment minus a trailing -GGUF. */
function modelName(repoId: string): string {
  const seg = repoId.includes('/') ? repoId.slice(repoId.indexOf('/') + 1) : repoId
  return seg.replace(/-?GGUF$/i, '')
}

/** Filesystem-safe local id for a direct-downloaded HF quant. */
export function hfModelId(repoId: string, label: string): string {
  return `hf_${repoId}_${label}`.replace(/[^a-zA-Z0-9._-]+/g, '_').toLowerCase()
}

export function normalizeHfModel(repo: HfRepoLite): CatalogEntry | null {
  // Skip the vision-projector sidecar files; they aren't standalone models.
  const ggufs = repo.siblings.filter(s => {
    const f = s.rfilename.toLowerCase()
    return f.endsWith('.gguf') && !f.includes('mmproj')
  })
  if (ggufs.length === 0) return null

  // Group files by quant label. Only keep files with a RECOGNISED quant.
  const filesByQuant = new Map<string, { path: string; size: number }[]>()
  for (const s of ggufs) {
    const label = parseQuantFromFilename(s.rfilename)
    if (!label) continue
    const arr = filesByQuant.get(label) ?? []
    arr.push({ path: s.rfilename, size: s.size ?? 0 })
    filesByQuant.set(label, arr)
  }
  if (filesByQuant.size === 0) return null

  const quants: QuantOption[] = [...filesByQuant.entries()].map(([label, files]) => {
    const sizeBytes = files.reduce((a, f) => a + f.size, 0)
    const recommended = label.toUpperCase() === RECOMMENDED_QUANT
    if (files.length === 1) {
      // Single file → download straight into llama.cpp by URL. Works for ANY
      // GGUF, including community merges that Ollama's hf.co puller rejects.
      return {
        label, sizeBytes, recommended,
        runtime: 'llamacpp' as const,
        ref: hfModelId(repo.id, label),
        url: `https://huggingface.co/${repo.id}/resolve/main/${files[0].path}`,
      }
    }
    // Split GGUF (…-00001-of-0000N) → let Ollama's hf.co puller assemble it.
    return {
      label, sizeBytes, recommended,
      runtime: 'ollama' as const,
      ref: `hf.co/${repo.id}:${label}`,
    }
  })

  const name = modelName(repo.id)
  return {
    id: `hf:${repo.id}`,
    name,
    family: name.split(/[-\s]/)[0] || name,
    params: parseParams(repo.id),
    kind: 'text',
    source: 'hf',
    quants,
    capabilities: deriveCapabilities({ name, tags: repo.tags, pipelineTag: repo.pipelineTag }),
    downloads: repo.downloads,
    likes: repo.likes,
  }
}
