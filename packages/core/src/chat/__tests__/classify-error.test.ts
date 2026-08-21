import { describe, it, expect } from 'vitest'
import { classifyProviderError, type ProviderErrorKind } from '../classify-error.js'

describe('classifyProviderError', () => {
  const cases: Array<[string, ProviderErrorKind]> = [
    // no-key
    ['Add a venice API key in Settings.', 'no-key'],
    ['NO_PROVIDER', 'no-key'],
    ['No API key configured for openrouter', 'no-key'],
    ['api key not set', 'no-key'],
    // auth — beats no-key wording when the key was REJECTED
    ['401 Unauthorized', 'auth'],
    ['Incorrect API key provided: sk-abc...', 'auth'],
    ['HTTP 403 for https://api.example.com', 'auth'],
    ['invalid_api_key: your token was rejected', 'auth'],
    ['authentication failed', 'auth'],
    // auth beats no-key when BOTH signals appear (rejected key ≠ missing key)
    ['401 Unauthorized: no api key found in request header', 'auth'],
    ['Error 403 Forbidden — missing api key or key invalid', 'auth'],
    ['Authentication failed. Please add your api key again in Settings.', 'auth'],
    // rate limit
    ['HTTP 429: Too Many Requests', 'rate-limit'],
    ['rate limit exceeded, retry after 20s', 'rate-limit'],
    // quota / billing
    ['insufficient_quota: You exceeded your current quota', 'quota'],
    ['402 Payment Required', 'quota'],
    ['Not enough credits', 'quota'],
    // context length
    ['This model\'s maximum context length is 8192 tokens', 'context-length'],
    ['context_length_exceeded', 'context-length'],
    ['Prompt is too long: 210000 tokens', 'context-length'],
    // upstream
    ['HTTP 502 for https://llm.bankr.bot/v1/chat', 'upstream'],
    ['Service Unavailable', 'upstream'],
    ['Overloaded', 'upstream'],
    // network
    ['fetch failed', 'network'],
    ['getaddrinfo ENOTFOUND api.venice.ai', 'network'],
    ['connect ECONNREFUSED 127.0.0.1:31415', 'network'],
    ['socket hang up', 'network'],
    ['Request timed out after 30000ms', 'network'],
    // unknown
    ['something exploded in a novel way', 'unknown'],
    ['', 'unknown'],
  ]

  it.each(cases)('%s -> %s', (raw, kind) => {
    expect(classifyProviderError(raw)).toBe(kind)
  })

  it('handles null/undefined', () => {
    expect(classifyProviderError(undefined)).toBe('unknown')
    expect(classifyProviderError(null)).toBe('unknown')
  })

  it('caps pathological input length without throwing', () => {
    expect(classifyProviderError('x'.repeat(1_000_000))).toBe('unknown')
  })
})
