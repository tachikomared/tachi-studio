// apps/desktop/electron/services/vision-chat.ts
//
// Generic OpenAI-compatible VISION chat: one non-streaming /chat/completions
// whose user message carries text PLUS image_url parts, so a vision-capable model
// on ANY openai-compatible gateway (Bankr / Surplus / OpenGateway / …) SEES the
// reference image(s) while writing. Mirrors veniceVisionChat (which keeps Venice's
// own auth) but resolves baseUrl + Bearer key from the provider registry — this is
// what lets the Nodes Vision-Prompt work beyond Venice.

import { getProvider } from '@tachi/core'
import { retrieveKey } from './keychain'
import { enforceProviderEgress } from './egress-policy'

export async function compatVisionChat(input: {
  /** CANONICAL provider id (bankr-gateway / surplus / opengateway / …). */
  providerId: string
  model: string
  system?: string
  userText: string
  imageUrls: string[]
}): Promise<{ text: string }> {
  const desc = getProvider(input.providerId)
  if (!desc?.baseUrl) throw new Error(`No base URL for provider "${input.providerId}".`)
  if (!desc.openaiCompatible) throw new Error(`Vision chat needs an OpenAI-compatible gateway (not "${input.providerId}").`)
  const key = desc.keychainId ? retrieveKey(desc.keychainId) : null
  if (!key) throw new Error(`No API key stored for ${desc.label}.`)
  enforceProviderEgress(input.providerId) // PRIVATE MODE / egress gate (throws if blocked)

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: input.userText.trim() || 'Use the attached reference image(s).' },
  ]
  for (const url of input.imageUrls) {
    if (typeof url === 'string' && url) content.push({ type: 'image_url', image_url: { url } })
  }
  const messages: Array<Record<string, unknown>> = []
  if (input.system && input.system.trim()) messages.push({ role: 'system', content: input.system })
  messages.push({ role: 'user', content })

  const base = desc.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: input.model, messages, stream: false }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${desc.label} vision chat ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: unknown } }> }
  const msg = json.choices?.[0]?.message?.content
  const text = typeof msg === 'string'
    ? msg
    : Array.isArray(msg)
      ? msg.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
      : ''
  return { text: text.trim() }
}

/**
 * Vision via the Anthropic-native `/v1/messages` endpoint. Bankr's OpenAI
 * `/chat/completions` accepts the request but DROPS base64 images for Claude
 * models (confirmed: the model replies "I don't see an image"); its
 * Anthropic-compatible `/v1/messages` forwards them correctly. Same auth/base as
 * the registry. Use this for Bankr + Claude image requests.
 */
export async function anthropicVisionChat(input: {
  providerId: string
  model: string
  system?: string
  userText: string
  imageUrls: string[]
  maxTokens?: number
  signal?: AbortSignal
}): Promise<{ text: string }> {
  const desc = getProvider(input.providerId)
  if (!desc?.baseUrl) throw new Error(`No base URL for provider "${input.providerId}".`)
  const key = desc.keychainId ? retrieveKey(desc.keychainId) : null
  if (!key) throw new Error(`No API key stored for ${desc.label}.`)
  enforceProviderEgress(input.providerId) // PRIVATE MODE / egress gate

  // Anthropic content blocks: text + image (base64 source, or a URL source).
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: input.userText.trim() || 'Use the attached reference image(s).' },
  ]
  for (const url of input.imageUrls) {
    if (typeof url !== 'string' || !url) continue
    const m = /^data:([\w/.+-]+);base64,(.+)$/i.exec(url)
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    else if (/^https?:\/\//i.test(url)) content.push({ type: 'image', source: { type: 'url', url } })
  }

  const base = desc.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      ...(input.system && input.system.trim() ? { system: input.system } : {}),
      messages: [{ role: 'user', content }],
    }),
    signal: input.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${desc.label} vision (/messages) ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json().catch(() => ({}))) as { content?: Array<{ type?: string; text?: string }> }
  const text = Array.isArray(json.content)
    ? json.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
    : ''
  return { text: text.trim() }
}

/** Bankr (+ any gateway exposing /v1/messages) + a Claude model → use the native path. */
export function prefersAnthropicVision(providerId: string, model: string): boolean {
  return providerId === 'bankr-gateway' && /claude/i.test(model)
}
