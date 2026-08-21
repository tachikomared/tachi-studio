import { describe, it, expect } from 'vitest'
import { findFreePort } from '../port-finder.js'

describe('findFreePort', () => {
  it('returns a number in the valid TCP range', async () => {
    const port = await findFreePort(31415)
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('returns a different port when the preferred one is in use', async () => {
    const { createServer } = await import('net')
    const blocker = createServer()
    await new Promise<void>(r => blocker.listen(31415, '127.0.0.1', r))
    try {
      const port = await findFreePort(31415)
      expect(port).not.toBe(31415)
      expect(port).toBeGreaterThanOrEqual(1024)
    } finally {
      await new Promise<void>(r => blocker.close(() => r()))
    }
  })
})
