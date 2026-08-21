// apps/desktop/electron/services/memory-facts-service.ts
//
// Electron-coupled singleton for the structured memory fact store (T16).
// The store itself is PURE and lives in ./memory-facts-store — vitest imports
// that file directly, which is why this module can use plain top-level imports.
//
// P0 REGRESSION (2026-07-25) — DO NOT reintroduce a lazy relative require here.
// This function used to resolve ./settings-store with a runtime require() inside
// the function body "so vitest could import the module". electron-vite bundles
// the whole main process into a single out/main/index.js, so inside app.asar
// there is no ./settings-store on disk: the require threw
// "Cannot find module ./settings-store" on EVERY call. chat-service calls
// injection() unconditionally before any provider branch, so EVERY packaged
// chat send died before emitting a single chunk. The fix has three parts:
//   1. this file — static imports that the bundler actually resolves,
//   2. the pure store moved to ./memory-facts-store so tests stay electron-free,
//   3. a guard test (test/unit/noRuntimeRelativeRequire.test.ts) that fails the
//      build if any function-body relative require() comes back.

import { app } from 'electron'
import { join } from 'node:path'
import { loadSettings } from './settings-store'
import { MemoryFactsStore } from './memory-facts-store'

export { MemoryFactsStore, safeInjection } from './memory-facts-store'
export type { MemoryFact } from '@tachi/core'

// ── Electron-coupled singleton ────────────────────────────────────────────────

let singleton: MemoryFactsStore | null = null

/**
 * Process-wide fact store, rooted at userData/memory-facts.json.
 * Path + legacy-blob lookups stay inside the function so nothing touches
 * app.getPath() at module-load time.
 */
export function getMemoryFactsStore(): MemoryFactsStore {
  if (!singleton) {
    singleton = new MemoryFactsStore(
      join(app.getPath('userData'), 'memory-facts.json'),
      () => loadSettings().userMemory ?? '',
    )
  }
  return singleton
}
