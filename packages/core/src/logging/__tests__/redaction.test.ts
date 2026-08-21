import { describe, it, expect } from 'vitest'
import { redactSecrets, redactObject } from '../redaction.js'

describe('redactSecrets', () => {
  it('redacts bearer tokens', () => {
    const input = 'Authorization: Bearer bk_abc123xyz'
    expect(redactSecrets(input)).toBe('Authorization: Bearer [REDACTED]')
  })

  it('redacts x-api-key headers', () => {
    const input = 'x-api-key: bk_secret_key_here'
    expect(redactSecrets(input)).toBe('x-api-key: [REDACTED]')
  })

  it('redacts bk_ prefixed keys inline', () => {
    const input = 'key=bk_supersecretkey&other=value'
    expect(redactSecrets(input)).not.toContain('bk_supersecretkey')
    expect(redactSecrets(input)).toContain('[REDACTED]')
  })

  it('passes through safe strings unchanged', () => {
    const input = 'GET /v1/models HTTP/1.1'
    expect(redactSecrets(input)).toBe(input)
  })
})

describe('redactObject', () => {
  it('redacts authorization field in objects', () => {
    const obj = { authorization: 'Bearer bk_key', status: 200 }
    const result = redactObject(obj)
    expect(result.authorization).toBe('[REDACTED]')
    expect(result.status).toBe(200)
  })

  it('redacts x-api-key field', () => {
    const obj = { 'x-api-key': 'bk_mykey', url: 'https://example.com' }
    const result = redactObject(obj)
    expect(result['x-api-key']).toBe('[REDACTED]')
    expect(result.url).toBe('https://example.com')
  })

  it('does not mutate the original', () => {
    const obj = { authorization: 'Bearer bk_key' }
    redactObject(obj)
    expect(obj.authorization).toBe('Bearer bk_key')
  })
})
