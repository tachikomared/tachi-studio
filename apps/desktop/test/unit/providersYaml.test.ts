// apps/desktop/test/unit/providersYaml.test.ts
//
// providers.yaml schema sanity + presence of the free-provider expansion
// (STEAL 2026-06-12 cluster E / TL;DR #3, free-coding-models sources.js).
//
// codestral was planned but DROPPED: codestral.mistral.ai exposes no
// /v1/models endpoint (404 even authenticated; chat/fim return 401), so the
// generic key-verify probe can never succeed there. Codestral models remain
// reachable via the existing `mistral` entry.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

interface ProviderEntry { label: string; kind: string; verifyUrl: string; verifyAuth: string }

const yamlPath = join(__dirname, '..', '..', 'electron', 'services', 'providers', 'providers.yaml')
const doc = parse(readFileSync(yamlPath, 'utf8')) as { providers: Record<string, ProviderEntry> }

const NEW_IDS = ['nvidia-nim', 'sambanova', 'github-models', 'zai', 'scaleway-ai', 'novita']

describe('providers.yaml free-provider expansion', () => {
  it.each(NEW_IDS)('defines %s as a verifiable api_key provider', (id) => {
    const p = doc.providers[id]
    expect(p, `missing provider entry: ${id}`).toBeDefined()
    expect(p!.kind).toBe('api_key')
    expect(p!.label.length).toBeGreaterThan(0)
    expect(p!.verifyUrl).toMatch(/^https:\/\//)
    expect(['bearer', 'x-api-key']).toContain(p!.verifyAuth)
  })

  it('keeps every existing entry intact', () => {
    for (const id of ['anthropic-oauth', 'openrouter', 'openai', 'anthropic', 'groq', 'mistral', 'cerebras', 'cohere', 'ollama']) {
      expect(doc.providers[id], `pre-existing provider vanished: ${id}`).toBeDefined()
    }
  })
})
