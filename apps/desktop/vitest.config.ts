// apps/desktop/vitest.config.ts
//
// Unit-test runner for the desktop app's PURE utilities only (no electron / no
// DOM). Tests live under test/ — deliberately OUTSIDE the tsc include
// (["electron","src"]) and outside the electron-vite build entries, so they
// never affect the `tsc --noEmit` gate or the production bundle.
//
// Scope: framework-free helpers that are easy to get subtly wrong and hard to
// verify by clicking (context packing, provider-response traversal, download
// progress aggregation, byte/time formatting). Run with `pnpm -F
// tachi-studio-desktop test` or `npx vitest run` from apps/desktop.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
