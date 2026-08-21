// apps/desktop/src/components/ProviderIcon.tsx
//
// Brand glyph for a provider, backed by developer-icons (MIT, bundled SVGs, zero
// network). Only providers with a REAL matching icon render one; everything else
// renders null — no wrong-brand fallbacks (an OpenAI glyph on Ollama is worse
// than no glyph). The package is sideEffects:false, so importing just the names
// we use tree-shakes the other ~690 icons out of the renderer bundle.
//
// Matched by substring against a lower-cased provider id OR label, so one map
// covers registry ids ('anthropic-oauth'), freellmapi platform ids ('google'),
// and catalog family strings ('Llama', 'DeepSeek').

import React from 'react'
import {
  Anthropic, OpenAI, DeepSeek, HuggingFace, Google, Meta, Cloudflare, GitHubDark, GitHubCopilot,
} from 'developer-icons'

type IconComp = typeof Anthropic

// [pattern, component, mono?]. First matching rule wins; order matters
// (copilot before generic github). `mono` flags MONOCHROME brand marks whose
// baked fill is near-black (OpenAI #193718, GitHub) — invisible on the dark
// themes (tachi-dark/neon). Those render inside .tachi-brand-mono, which
// forces their svg fills to currentColor = var(--text-primary), so they're
// legible on every theme (dark text on light bankr, light on the dark themes).
// Multi-color marks (Anthropic orange, Google, DeepSeek blue, …) render as-is.
const RULES: Array<[RegExp, IconComp, boolean?]> = [
  [/claude|anthropic/,  Anthropic],
  [/openai|gpt|chatgpt/, OpenAI, true],
  [/deepseek/,          DeepSeek],
  [/hugging|(^|[^a-z])hf([^a-z]|$)/, HuggingFace],
  [/gemini|google/,     Google],
  [/meta|llama/,        Meta],
  [/cloudflare/,        Cloudflare],
  [/copilot/,           GitHubCopilot],
  [/github/,            GitHubDark, true],
]

export function ProviderIcon({
  providerId,
  size = 14,
  style,
}: {
  providerId: string
  size?: number
  style?: React.CSSProperties
}): React.ReactElement | null {
  const key = (providerId || '').toLowerCase()
  const hit = RULES.find(([re]) => re.test(key))
  if (!hit) return null
  const Comp = hit[1]
  const mono = hit[2] === true
  const icon = <Comp size={size} style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle', ...style }} />
  if (!mono) return icon
  // Theme-aware wrapper: currentColor = the theme's text color.
  return <span className="tachi-brand-mono" style={{ display: 'inline-flex', color: 'var(--text-primary)' }}>{icon}</span>
}
