import { describe, it, expect } from 'vitest'
import { mapBankrError } from '../bankr-errors.js'

describe('mapBankrError', () => {
  it('maps 401 to invalid key message', () => {
    const err = mapBankrError(401)
    expect(err.code).toBe('INVALID_KEY')
    expect(err.message).toContain('Invalid Bankr API key')
  })

  it('maps 402 to credits exhausted', () => {
    const err = mapBankrError(402)
    expect(err.code).toBe('CREDITS_EXHAUSTED')
    expect(err.message).toContain('credits exhausted')
  })

  it('maps 403 to access denied', () => {
    const err = mapBankrError(403)
    expect(err.code).toBe('ACCESS_DENIED')
  })

  it('maps 408 to timeout', () => {
    const err = mapBankrError(408)
    expect(err.code).toBe('TIMEOUT')
  })

  it('maps 429 to rate limited', () => {
    const err = mapBankrError(429)
    expect(err.code).toBe('RATE_LIMITED')
  })

  it('maps 5xx to gateway error', () => {
    expect(mapBankrError(500).code).toBe('GATEWAY_ERROR')
    expect(mapBankrError(503).code).toBe('GATEWAY_ERROR')
  })

  it('maps unknown status to unknown error', () => {
    const err = mapBankrError(418)
    expect(err.code).toBe('UNKNOWN')
  })

  it('maps network failure (0) to unreachable', () => {
    const err = mapBankrError(0)
    expect(err.code).toBe('UNREACHABLE')
  })
})
