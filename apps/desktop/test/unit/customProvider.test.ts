// apps/desktop/test/unit/customProvider.test.ts
//
// USER-PAINS T17 — user-added custom OpenAI-compatible endpoints. Covers the
// three pure operations chat + picker + main all rely on: base-URL
// normalization, hostname locality (the PRIVATE MODE egress rule), the
// `custom:<id>` provider-id scheme, and a settings round-trip through the
// settings:save allowlist (kind 'custom-openai').

import { describe, it, expect } from 'vitest'
import {
  normalizeBaseUrl,
  classifyHostLocality,
  endpointLocality,
  isLocalCustomEndpoint,
  customProviderId,
  parseCustomProviderId,
  isCustomProviderId,
  customEndpointKeychainId,
  CUSTOM_PROVIDER_PREFIX,
} from '@tachi/core'
import { appSettingsSaveSchema } from '../../electron/services/settings-schema'
import type { ProviderSettings } from '@tachi/core'

describe('normalizeBaseUrl', () => {
  it('keeps a clean /v1 base untouched', () => {
    expect(normalizeBaseUrl('http://192.168.1.50:1234/v1')).toEqual({ ok: true, url: 'http://192.168.1.50:1234/v1' })
  })

  it('strips a trailing slash', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1/')).toEqual({ ok: true, url: 'http://localhost:1234/v1' })
    expect(normalizeBaseUrl('http://localhost:11434/v1///')).toEqual({ ok: true, url: 'http://localhost:11434/v1' })
  })

  it('strips a pasted /chat/completions endpoint (no duplication)', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1/chat/completions'))
      .toEqual({ ok: true, url: 'http://localhost:1234/v1' })
  })

  it('strips a pasted /models endpoint', () => {
    expect(normalizeBaseUrl('http://host:8000/v1/models'))
      .toEqual({ ok: true, url: 'http://host:8000/v1' })
  })

  it('collapses a doubled /v1/v1 segment', () => {
    expect(normalizeBaseUrl('http://host:8000/v1/v1')).toEqual({ ok: true, url: 'http://host:8000/v1' })
  })

  it('preserves the port and a non-/v1 path', () => {
    expect(normalizeBaseUrl('https://api.example.com:8443/openai/v1'))
      .toEqual({ ok: true, url: 'https://api.example.com:8443/openai/v1' })
  })

  it('accepts a bare host with no path', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toEqual({ ok: true, url: 'http://127.0.0.1:8080' })
  })

  it('drops query + hash', () => {
    expect(normalizeBaseUrl('http://host:1234/v1?foo=1#x')).toEqual({ ok: true, url: 'http://host:1234/v1' })
  })

  it('rejects a non-http(s) scheme', () => {
    expect(normalizeBaseUrl('ftp://host/v1').ok).toBe(false)
    expect(normalizeBaseUrl('file:///etc/passwd').ok).toBe(false)
  })

  it('rejects a non-URL / empty string', () => {
    expect(normalizeBaseUrl('not a url').ok).toBe(false)
    expect(normalizeBaseUrl('').ok).toBe(false)
    expect(normalizeBaseUrl('   ').ok).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  http://localhost:1234/v1  ')).toEqual({ ok: true, url: 'http://localhost:1234/v1' })
  })
})

describe('classifyHostLocality / locality classifier', () => {
  it('classifies loopback + localhost as lan-local', () => {
    expect(classifyHostLocality('localhost')).toBe('lan-local')
    expect(classifyHostLocality('127.0.0.1')).toBe('lan-local')
    expect(classifyHostLocality('127.5.5.5')).toBe('lan-local')
    expect(classifyHostLocality('::1')).toBe('lan-local')
    expect(classifyHostLocality('[::1]')).toBe('lan-local')
  })

  it('classifies RFC1918 private ranges as lan-local', () => {
    expect(classifyHostLocality('192.168.1.50')).toBe('lan-local')
    expect(classifyHostLocality('10.0.0.4')).toBe('lan-local')
    expect(classifyHostLocality('172.16.0.1')).toBe('lan-local')
    expect(classifyHostLocality('172.31.255.255')).toBe('lan-local')
    expect(classifyHostLocality('169.254.1.1')).toBe('lan-local')
  })

  it('classifies mDNS .local + IPv6 ULA/link-local as lan-local', () => {
    expect(classifyHostLocality('mac-studio.local')).toBe('lan-local')
    expect(classifyHostLocality('fd00::1')).toBe('lan-local')
    expect(classifyHostLocality('fe80::1')).toBe('lan-local')
  })

  it('classifies public hosts as cloud', () => {
    expect(classifyHostLocality('api.openai.com')).toBe('cloud')
    expect(classifyHostLocality('8.8.8.8')).toBe('cloud')
    expect(classifyHostLocality('172.15.0.1')).toBe('cloud') // just below the private block
    expect(classifyHostLocality('172.32.0.1')).toBe('cloud') // just above the private block
    expect(classifyHostLocality('example.com')).toBe('cloud')
    expect(classifyHostLocality('')).toBe('cloud')
  })

  it('endpointLocality + isLocalCustomEndpoint parse the URL host', () => {
    expect(endpointLocality('http://192.168.1.50:1234/v1')).toBe('lan-local')
    expect(endpointLocality('https://api.example.com/v1')).toBe('cloud')
    expect(isLocalCustomEndpoint('http://localhost:1234/v1')).toBe(true)
    expect(isLocalCustomEndpoint('https://cloud.example.com/v1')).toBe(false)
    // A malformed URL is treated as cloud (paranoid default).
    expect(isLocalCustomEndpoint('not a url')).toBe(false)
    expect(endpointLocality('not a url')).toBe('cloud')
  })
})

describe('custom provider-id scheme', () => {
  it('wraps + unwraps a settings id', () => {
    expect(customProviderId('abc-123')).toBe('custom:abc-123')
    expect(parseCustomProviderId('custom:abc-123')).toBe('abc-123')
    expect(CUSTOM_PROVIDER_PREFIX).toBe('custom:')
  })

  it('rejects non-custom ids', () => {
    expect(parseCustomProviderId('bankr-gateway')).toBeNull()
    expect(parseCustomProviderId('custom:')).toBeNull() // empty id
    expect(parseCustomProviderId(null)).toBeNull()
    expect(parseCustomProviderId(undefined)).toBeNull()
    expect(isCustomProviderId('custom:x')).toBe(true)
    expect(isCustomProviderId('venice')).toBe(false)
  })

  it('derives a keychain id', () => {
    expect(customEndpointKeychainId('abc-123')).toBe('custom:abc-123')
  })

  it('round-trips id ↔ provider-id ↔ keychain-id', () => {
    const id = 'e9f2'
    const pid = customProviderId(id)
    expect(parseCustomProviderId(pid)).toBe(id)
    expect(customEndpointKeychainId(parseCustomProviderId(pid)!)).toBe('custom:e9f2')
  })
})

describe('custom-openai settings round-trip (settings:save allowlist)', () => {
  it('persists a custom-openai provider entry unchanged', () => {
    const entry: ProviderSettings = {
      id: 'e9f2',
      kind: 'custom-openai',
      displayName: 'LM Studio · office PC',
      baseUrl: 'http://192.168.1.50:1234/v1',
      selectedModel: 'qwen2.5-coder-7b',
      enabled: true,
    }
    const parsed = appSettingsSaveSchema.parse({ providers: [entry] })
    expect(parsed).toStrictEqual({ providers: [entry] })
  })

  it('accepts multiple endpoints (one local, one cloud)', () => {
    const providers: ProviderSettings[] = [
      { id: 'a', kind: 'custom-openai', displayName: 'Local', baseUrl: 'http://localhost:1234/v1', enabled: true },
      { id: 'b', kind: 'custom-openai', displayName: 'Cloud', baseUrl: 'https://api.example.com/v1', enabled: false },
    ]
    const parsed = appSettingsSaveSchema.parse({ providers })
    expect(parsed).toStrictEqual({ providers })
    // The locality split that drives the PRIVATE MODE picker filter:
    expect(isLocalCustomEndpoint(providers[0].baseUrl)).toBe(true)
    expect(isLocalCustomEndpoint(providers[1].baseUrl)).toBe(false)
  })
})
