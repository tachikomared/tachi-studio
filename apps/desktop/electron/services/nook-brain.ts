// apps/desktop/electron/services/nook-brain.ts
//
// The agent "brain" — powered by TachiDesk's OWN providers (the same ones the
// Chat / Code / Nodes tabs use), so the autonomous agent and the mining solver
// run on the model the user already configured here. No re-entering keys: the
// keys live in the app keychain; the freellmapi sidecar is the local free path.
// Every provider here is OpenAI-compatible, so one /chat/completions covers all.

import { retrieveKey } from './keychain'
import { getFreellmapiPort, getFreellmapiApiKey } from './sidecar-manager'

export interface BrainProviderInfo {
  id: string
  label: string
  available: boolean
  reason?: string
  defaultModel: string
}

interface BrainProvider {
  id: string
  label: string
  keyId?: string
  defaultModel: string
  baseUrl: () => string | null
  apiKey: () => string
  available: () => { ok: boolean; reason?: string }
}

const PROVIDERS: BrainProvider[] = [
  {
    id: 'freellmapi', label: 'Free (freellmapi)', defaultModel: 'auto',
    baseUrl: () => { const p = getFreellmapiPort(); return p ? `http://127.0.0.1:${p}/v1` : null },
    apiKey: () => getFreellmapiApiKey() ?? '',
    available: () => getFreellmapiPort() ? { ok: true } : { ok: false, reason: 'Start freellmapi in Studio' },
  },
  {
    id: 'openrouter', label: 'OpenRouter', keyId: 'openrouter', defaultModel: 'openai/gpt-4o-mini',
    baseUrl: () => 'https://openrouter.ai/api/v1', apiKey: () => retrieveKey('openrouter') ?? '',
    available: () => retrieveKey('openrouter') ? { ok: true } : { ok: false, reason: 'Add an OpenRouter key in Settings' },
  },
  {
    id: 'bankr', label: 'Bankr', keyId: 'bankr-gateway', defaultModel: 'claude-sonnet-4.6',
    baseUrl: () => 'https://llm.bankr.bot/v1', apiKey: () => retrieveKey('bankr-gateway') ?? '',
    available: () => retrieveKey('bankr-gateway') ? { ok: true } : { ok: false, reason: 'Add a Bankr key in Settings' },
  },
  {
    id: 'surplus', label: 'Surplus', keyId: 'surplus', defaultModel: 'claude-sonnet-4.5',
    baseUrl: () => 'https://www.surplusintelligence.ai/api/inference/v1', apiKey: () => retrieveKey('surplus') ?? '',
    available: () => retrieveKey('surplus') ? { ok: true } : { ok: false, reason: 'Add a Surplus key in Settings' },
  },
  {
    id: 'opengateway', label: 'OpenGateway', keyId: 'opengateway', defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    baseUrl: () => 'https://opengateway.gitlawb.com/v1', apiKey: () => retrieveKey('opengateway') ?? '',
    available: () => ({ ok: true }),   // nemotron :free needs no credits (MiMo is paid since 2026-07)
  },
  {
    id: 'ollama', label: 'Ollama (local)', defaultModel: 'llama3.1',
    baseUrl: () => 'http://127.0.0.1:11434/v1', apiKey: () => 'ollama',
    available: () => ({ ok: true }),   // assume the local daemon is up; call will error clearly if not
  },
]

export function listBrainProviders(): BrainProviderInfo[] {
  return PROVIDERS.map(p => {
    const a = p.available()
    return { id: p.id, label: p.label, available: a.ok, reason: a.reason, defaultModel: p.defaultModel }
  })
}

export function isBrainProvider(id: string): boolean {
  return PROVIDERS.some(p => p.id === id)
}

/** One-shot completion against the chosen app provider (OpenAI-compatible). */
export async function complete(prompt: string, providerId: string, model?: string): Promise<string> {
  const p = PROVIDERS.find(x => x.id === providerId)
  if (!p) throw new Error(`Unknown provider "${providerId}"`)
  const base = p.baseUrl()
  if (!base) throw new Error(`${p.label} is not available right now`)
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey()}` },
    body: JSON.stringify({
      model: model || p.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(90_000) as AbortSignal,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`${p.label} ${res.status}${t ? ': ' + t.slice(0, 160) : ''}`)
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content ?? ''
}
