// apps/desktop/test/unit/runtimeDetectBankrKeychain.test.ts
//
// PINS the id that runtime-detect.ts asks the keychain for when building the
// Bankr Gateway runtime card. Until this fix it asked for retrieveKey('bankr')
// — an id NOTHING else in the app stores a Bankr key under. Every other reader
// (provider-service.ts, bankr-service.ts, curator-service.ts, router-service.ts,
// nook-brain.ts, tachi/provider.ts, model-catalog-cache.ts, sidecar-manager.ts)
// and the provider registry's own `keychainId` for the card (packages/core
// providers/registry.ts) all use 'bankr-gateway'. retrieveKey() does no
// aliasing between ids, so the mismatch meant apiKey was always undefined and
// packages/core's createBankrGatewayDetector short-circuited to 'needs_login'
// at its very first line, before ever calling the health function — a working
// key could NEVER produce anything but "needs login".

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'tachi-runtime-detect-'))
})

afterAll(() => rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
}))

// A tiny fake keychain — the point of this suite is the ARGUMENT it's called
// with, not the encryption behind the real one.
const retrieveKeyMock = vi.hoisted(() =>
  vi.fn((id: string) => (id === 'bankr-gateway' ? 'bk_live_test_key' : null)),
)
vi.mock('../../electron/services/keychain', () => ({ retrieveKey: retrieveKeyMock }))

import { buildRuntimeRegistry } from '../../electron/services/runtime-detect'

describe('buildRuntimeRegistry — Bankr keychain id', () => {
  beforeEach(() => retrieveKeyMock.mockClear())

  it('reads the Bankr key under "bankr-gateway" — the id the Settings card stores it under — not "bankr"', () => {
    buildRuntimeRegistry()
    expect(retrieveKeyMock).toHaveBeenCalledWith('bankr-gateway')
    expect(retrieveKeyMock).not.toHaveBeenCalledWith('bankr')
  })

  it('so a stored key actually reaches the Bankr Gateway detector as a truthy apiKey, and the health function gets called', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    try {
      // createBankrGatewayDetector's fetchFn default binds to the global `fetch`
      // at CONSTRUCTION time (buildRuntimeRegistry() builds it eagerly), so the
      // stub must be in place before this call, not merely before detect().
      const registry = buildRuntimeRegistry()
      const bankr = registry.find(d => d.runtimeId === 'bankr-gateway')
      expect(bankr).toBeDefined()

      const result = await bankr!.detect()

      // Before the fix: apiKey was undefined, the detector returned
      // 'needs_login' at its first line, and fetch was never called at all.
      expect(fetchMock).toHaveBeenCalled()
      expect(result.status).toBe('healthy')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
