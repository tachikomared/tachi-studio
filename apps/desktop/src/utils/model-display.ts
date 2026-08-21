// Human display names for model ids (UX Top-10 #10a): raw ids like
// "hf_hauhaucs_gemma-4-e2b-uncensored-iq3_m.gguf" must never be primary UI
// copy — surfaces render modelDisplayName(id) and keep the raw id in `title`
// (hover). Pure + deterministic; mirrors the main-process catalog prettify()
// helpers (bankr/venice/surplus services) so picker labels and badge labels
// agree, and adds GGUF-filename handling those never needed.

const UPPER = new Set(['gpt', 'glm', 'llm', 'sd', 'sdxl', 'xl', 'tts', 'stt', 'vl', 'moe', 'ai'])
const FIXED: Record<string, string> = {
  deepseek: 'DeepSeek', qwen: 'Qwen', llama: 'Llama', mistral: 'Mistral',
  gemma: 'Gemma', mimo: 'MiMo', minimax: 'MiniMax', kokoro: 'Kokoro',
  phi: 'Phi', flux: 'Flux', wan: 'Wan', whisper: 'Whisper', piper: 'Piper',
  claude: 'Claude', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku',
  gemini: 'Gemini', grok: 'Grok', nemotron: 'Nemotron', uncensored: 'Uncensored',
}
// Quantization / precision suffix tokens (GGUF naming) — noise for humans.
const QUANT = /^(i?q\d(?:_[a-z0-9]+)*|f16|f32|bf16|fp16|fp32|gguf)$/i

// Router-alias tails: the segment after the slash is a TIER, not a model name.
// `kilo-auto/free` used to render as "Free" — an invented model that told the
// user nothing about what answered (driver-proven 2026-08-01). For these the
// meaningful half is the HEAD ("kilo-auto"); the raw id stays in the badge's
// title/hover either way.
const ROUTER_TIER_TAIL = new Set(['free', 'auto', 'default'])

export function modelDisplayName(id: string | null | undefined): string {
  if (!id) return ''
  let s = String(id).trim()
  if (!s) return ''
  if (/^auto$/i.test(s)) return 'Auto'
  // Basename (catalog ids can be org/model or a file path) — EXCEPT when the
  // tail is a routing tier, where the basename would name nothing real.
  const segs = s.split(/[\\/]/).filter(Boolean)
  if (segs.length > 1 && ROUTER_TIER_TAIL.has(segs[segs.length - 1].toLowerCase())) {
    s = segs[segs.length - 2]
  } else {
    s = segs.pop() ?? s
  }
  const isGguf = /\.gguf$/i.test(s)
  s = s.replace(/\.(gguf|safetensors|bin|onnx)$/i, '')
  // GGUF convention "hf_<owner>_<model...>" — the owner is picker metadata,
  // not part of the model's name.
  if (isGguf) s = s.replace(/^hf_[^_]+_/i, '')
  // Ollama-style ":latest" tag is noise; keep meaningful tags (":7b").
  s = s.replace(/:latest$/i, '')
  // Trailing quantization chunk as a whole ("-iq3_m", ".Q4_K_M", "-f16").
  s = s.replace(/[-_.](i?q\d[a-z0-9_]*|f16|f32|bf16|fp16|fp32)$/i, '')
  // Dots stay inside words — they carry version numbers (4.8, Llama-3.1).
  const words = s.split(/[-_\s:]+/).filter(Boolean)
  // Backstop for quant tokens that were already word-separated.
  while (words.length > 1 && QUANT.test(words[words.length - 1])) words.pop()
  const out = words.map(w => {
    const lower = w.toLowerCase()
    if (UPPER.has(lower)) return w.toUpperCase()
    if (FIXED[lower]) return FIXED[lower]
    if (/^\d/.test(w)) return lower       // version tokens: 4.8, 7b, 32k
    if (/^[a-z]\d/i.test(w)) return lower // size tokens: e2b, x7b
    return w.charAt(0).toUpperCase() + w.slice(1)
  })
  const name = out.join(' ').trim()
  return name || String(id)
}
