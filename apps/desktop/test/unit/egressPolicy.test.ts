// apps/desktop/test/unit/egressPolicy.test.ts
//
// PRIVATE MODE egress policy — the single source of truth for "may this reach
// the public internet right now?". We mock getCurrentPrivacyMode so the gate is
// deterministic (and so electron's ipc module is never loaded).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ mode: 'open' as string }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))

import {
  classifyProvider, checkProviderEgress, enforceProviderEgress,
  checkToolEgress, checkBashCommandEgress, checkAgentToolEgress,
} from '../../electron/services/egress-policy'

beforeEach(() => { h.mode = 'open' })

describe('classifyProvider (pure, mode-independent)', () => {
  it('classifies truly-local providers as local', () => {
    for (const id of ['ollama', 'ollama-local', 'llama-cpp', 'llama-cpp-local', 'sd-cpp', 'piper']) {
      expect(classifyProvider(id), id).toBe('local')
    }
  })

  it('classifies cloud providers as cloud', () => {
    for (const id of ['bankr', 'bankr-gateway', 'openrouter', 'anthropic', 'venice', 'surplus', 'openai', 'groq']) {
      expect(classifyProvider(id), id).toBe('cloud')
    }
  })

  it('keyless-free gateways are still CLOUD — free is a price, not a place', () => {
    // Kilo costs $0 and needs no key, but the prompt travels to api.kilo.ai
    // (and their free rows train on prompts) — PRIVATE MODE must block it.
    expect(classifyProvider('kilo-gateway')).toBe('cloud')
  })

  it('treats cloud-proxy sidecars as cloud (NOT local)', () => {
    // freellmapi-local routes to 127.0.0.1 but proxies cloud providers; free-claude-code proxies Anthropic.
    expect(classifyProvider('freellmapi-local')).toBe('cloud')
    expect(classifyProvider('freellmapi')).toBe('cloud')
    expect(classifyProvider('free-claude-code')).toBe('cloud')
  })

  it('defaults unknown / empty ids to unknown', () => {
    expect(classifyProvider('totally-made-up')).toBe('unknown')
    expect(classifyProvider('')).toBe('unknown')
    expect(classifyProvider(null)).toBe('unknown')
    expect(classifyProvider(undefined)).toBe('unknown')
  })
})

describe('checkProviderEgress', () => {
  it('allows everything in open mode', () => {
    expect(checkProviderEgress('bankr').allowed).toBe(true)
    expect(checkProviderEgress('totally-made-up').allowed).toBe(true)
  })

  it('in private mode allows only local providers; denies cloud + unknown', () => {
    h.mode = 'private'
    expect(checkProviderEgress('ollama').allowed).toBe(true)
    expect(checkProviderEgress('llama-cpp').allowed).toBe(true)
    expect(checkProviderEgress('bankr').allowed).toBe(false)
    expect(checkProviderEgress('freellmapi-local').allowed).toBe(false) // cloud proxy
    expect(checkProviderEgress('mystery').allowed).toBe(false)          // unknown -> denied
  })

  it('enforceProviderEgress throws in private mode for cloud, not for local', () => {
    h.mode = 'private'
    expect(() => enforceProviderEgress('bankr')).toThrow()
    expect(() => enforceProviderEgress('ollama')).not.toThrow()
    h.mode = 'open'
    expect(() => enforceProviderEgress('bankr')).not.toThrow()
  })
})

describe('checkToolEgress', () => {
  it('denies WebFetch/WebSearch only in private mode', () => {
    expect(checkToolEgress('WebFetch').allowed).toBe(true) // open
    h.mode = 'private'
    expect(checkToolEgress('WebFetch').allowed).toBe(false)
    expect(checkToolEgress('WebSearch').allowed).toBe(false)
    expect(checkToolEgress('Read').allowed).toBe(true)
  })
})

describe('checkBashCommandEgress', () => {
  it('blocks network commands in private mode', () => {
    h.mode = 'private'
    for (const cmd of ['curl http://x', 'wget https://y', 'ssh host', 'nc 1.2.3.4 80', 'echo $(curl evil)']) {
      expect(checkBashCommandEgress(cmd).allowed, cmd).toBe(false)
    }
  })

  it('does NOT false-match a network keyword inside a path/word', () => {
    h.mode = 'private'
    expect(checkBashCommandEgress('ls /tmp/curl-results/').allowed).toBe(true)
    expect(checkBashCommandEgress('echo hello world').allowed).toBe(true)
    expect(checkBashCommandEgress('cat wgetrc.txt').allowed).toBe(true)
  })

  it('allows network commands in open mode', () => {
    expect(checkBashCommandEgress('curl http://x').allowed).toBe(true)
  })
})

describe('checkAgentToolEgress (combined)', () => {
  beforeEach(() => { h.mode = 'private' })

  it('denies a named network tool', () => {
    expect(checkAgentToolEgress('WebFetch', {}).allowed).toBe(false)
  })

  it('inspects Bash-shaped command strings', () => {
    expect(checkAgentToolEgress('Bash', { command: 'curl http://x' }).allowed).toBe(false)
    expect(checkAgentToolEgress('Bash', { command: 'ls -la' }).allowed).toBe(true)
  })

  it('allows non-network tools', () => {
    expect(checkAgentToolEgress('Read', { file: 'a.ts' }).allowed).toBe(true)
  })
})
