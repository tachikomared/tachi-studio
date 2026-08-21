import { describe, it, expect } from 'vitest'
import { scrubSecrets, hasSecrets, newRedactionMap } from '../scrub.js'

describe('scrubSecrets — detection per category', () => {
  const cases: Array<[string, string, string]> = [
    ['EMAIL', 'mail me at alice@example.com please', 'EMAIL'],
    ['AWS_KEY', 'key AKIAIOSFODNN7EXAMPLE here', 'AWS_KEY'],
    ['GITHUB_TOKEN', 'token ghp_1234567890abcdefghijklmnopqrstuvwxyz', 'GITHUB_TOKEN'],
    ['API_KEY (openai)', 'use sk-abcdefghijklmnopqrstuvwxyz12', 'API_KEY'],
    ['API_KEY (anthropic)', 'use sk-ant-api03-abcdefghijklmnop_qrstuvwx', 'API_KEY'],
    ['SLACK_TOKEN', 'xoxb-123456789012-abcdefghijklmnop', 'SLACK_TOKEN'],
    ['SSN', 'ssn 123-45-6789 on file', 'SSN'],
  ]
  for (const [name, input, category] of cases) {
    it(`redacts ${name}`, () => {
      const r = scrubSecrets(input)
      expect(r.redactions).toBeGreaterThan(0)
      expect(r.text).toContain(`[REDACTED_${category}_1]`)
      expect(hasSecrets(input)).toBe(true)
      // the secret value itself is gone from the output
      expect(hasSecrets(r.text)).toBe(false)
    })
  }

  it('redacts a PEM private key block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const r = scrubSecrets(`here:\n${pem}\ndone`)
    expect(r.text).toContain('[REDACTED_PRIVATE_KEY_1]')
    expect(r.text).not.toContain('BEGIN RSA PRIVATE KEY')
  })

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
    const r = scrubSecrets(`auth ${jwt}`)
    expect(r.text).toContain('[REDACTED_JWT_1]')
  })

  it('redacts a Luhn-valid credit card but NOT a random 16-digit number', () => {
    const valid = scrubSecrets('card 4111 1111 1111 1111 ok')   // Visa test number, Luhn-valid
    expect(valid.text).toContain('[REDACTED_CREDIT_CARD_1]')
    const invalid = scrubSecrets('order 1234567812345678 ref')  // 16 digits, fails Luhn
    expect(invalid.redactions).toBe(0)
    expect(invalid.text).toContain('1234567812345678')
  })
})

describe('scrubSecrets — stability + no false positives', () => {
  it('maps the same value to the same placeholder, different values to different', () => {
    const r = scrubSecrets('from alice@example.com to bob@example.com cc alice@example.com')
    expect(r.text).toBe('from [REDACTED_EMAIL_1] to [REDACTED_EMAIL_2] cc [REDACTED_EMAIL_1]')
  })

  it('shares the map across calls in a conversation', () => {
    const map = newRedactionMap()
    const a = scrubSecrets('ping alice@example.com', map)
    const b = scrubSecrets('again alice@example.com', map)
    expect(a.text).toContain('[REDACTED_EMAIL_1]')
    expect(b.text).toContain('[REDACTED_EMAIL_1]') // same placeholder, not _2
  })

  it('leaves ordinary prose + code untouched', () => {
    const code = 'function readFile(path) { return fs.readFileSync(path); } // commit a1b2c3d4e5f6 v1.2.3'
    const r = scrubSecrets(code)
    expect(r.redactions).toBe(0)
    expect(r.text).toBe(code)
    expect(hasSecrets(code)).toBe(false)
  })

  it('does not touch a bare UUID or hex git sha', () => {
    const t = 'id 550e8400-e29b-41d4-a716-446655440000 sha 9de4130a1c0f5e6b7d8e9f0a1b2c3d4e5f6a7b8c'
    expect(scrubSecrets(t).redactions).toBe(0)
  })

  it('returns the original string + zero redactions when clean', () => {
    const r = scrubSecrets('nothing secret here')
    expect(r).toMatchObject({ text: 'nothing secret here', redactions: 0 })
  })
})
