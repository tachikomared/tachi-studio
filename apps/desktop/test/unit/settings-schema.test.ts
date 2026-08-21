// apps/desktop/test/unit/settings-schema.test.ts
//
// Regression suite for the settings:save allowlist (settings-schema.ts).
// Bug class being guarded: the schema strips unknown keys BY DESIGN, so any
// AppSettings key missing from the schema makes that setting silently
// non-persistent (observed for userMemory, mcpMode, mcpServerEnabled,
// routerSimpleMax, routerMidMax — three broken Settings/Chat features).

import { describe, it, expect } from 'vitest'
import { appSettingsSaveSchema } from '../../electron/services/settings-schema'
import { DEFAULT_SETTINGS, type AppSettings } from '@tachi/core'

// Fully-populated settings object: every key of AppSettings carries an explicit,
// non-default, non-undefined value so a stripped key is always detectable.
const FULL: AppSettings = {
  ...DEFAULT_SETTINGS,
  onboardingComplete: true,
  theme: 'tachi-neon',
  activeProviderId: 'bankr',
  providers: [{
    id: 'p1',
    kind: 'custom-openai',
    displayName: 'Local llama',
    baseUrl: 'http://127.0.0.1:8080/v1',
    selectedModel: 'qwen2.5-coder',
    enabled: true,
  }],
  consoleDockOpen: true,
  consoleDockHeight: 320,
  bankrBuddyPort: 23445,
  followProviderTheme: true,
  webSearchEnabled: true,
  userMemory: 'prefers pnpm over npm; UI must stay brutalist',
  notificationsEnabled: false,
  strictPrivacyMode: true,
  hotkeys: { 'toggle-console': 'Ctrl+`' },
  routerSimpleMax: 0.1,
  routerMidMax: 0.4,
  mcpMode: 'read_write',
  mcpServerEnabled: false,
}

describe('appSettingsSaveSchema (settings:save allowlist)', () => {
  it('round-trips every AppSettings key — no key is silently stripped', () => {
    const parsed = appSettingsSaveSchema.parse(FULL)
    expect(parsed).toStrictEqual(FULL)
  })

  it('persists userMemory (regression: Settings -> Memory silently no-oped)', () => {
    const parsed = appSettingsSaveSchema.parse({ userMemory: 'remember this' })
    expect(parsed).toStrictEqual({ userMemory: 'remember this' })
  })

  it('persists mcpMode (regression: MCP permission picker was cosmetic)', () => {
    const parsed = appSettingsSaveSchema.parse({ mcpMode: 'locked' })
    expect(parsed).toStrictEqual({ mcpMode: 'locked' })
  })

  it('rejects an invalid mcpMode value instead of silently dropping it', () => {
    expect(() => appSettingsSaveSchema.parse({ mcpMode: 'yolo' })).toThrow()
  })

  it('persists the smart-router boundaries (regression: SMART chip tuning lost)', () => {
    const parsed = appSettingsSaveSchema.parse({ routerSimpleMax: 0.07, routerMidMax: 0.5 })
    expect(parsed).toStrictEqual({ routerSimpleMax: 0.07, routerMidMax: 0.5 })
  })

  it('caps userMemory at the MemorySection limit (4000 chars)', () => {
    expect(() => appSettingsSaveSchema.parse({ userMemory: 'x'.repeat(4001) })).toThrow()
    expect(appSettingsSaveSchema.parse({ userMemory: 'x'.repeat(4000) }))
      .toStrictEqual({ userMemory: 'x'.repeat(4000) })
  })

  it('persists the KV-cache choice, and only from the closed set', () => {
    // This value ends up in the llama-server spawn argv. The write side is the
    // first of two gates (main re-validates what it reads, because a
    // hand-edited tachi-settings.json never passes through here).
    expect(appSettingsSaveSchema.parse({ llamaKvCache: 'q8_0' })).toStrictEqual({ llamaKvCache: 'q8_0' })
    expect(() => appSettingsSaveSchema.parse({ llamaKvCache: 'q2_k' })).toThrow()
    expect(() => appSettingsSaveSchema.parse({ llamaKvCache: '--flash-attn' })).toThrow()
  })

  it('still strips unknown keys (the security property must survive the fix)', () => {
    const parsed = appSettingsSaveSchema.parse({ theme: 'bankr', evil: 'payload' })
    expect(parsed).toStrictEqual({ theme: 'bankr' })
  })
})

// ── Retired themes ──────────────────────────────────────────────────────────
// A deleted theme's id is still sitting in the settings file of everyone who was
// on it, and the renderer echoes settings back on the next save — so `.parse()`
// would THROW on an ordinary save of an unrelated key and take the whole
// settings write with it. Retired ids are coerced, never rejected, and the write
// self-heals the file. (`tachi-crab` was removed 2026-07-26.)
describe('retired theme ids', () => {
  it('coerces a persisted retired id to its replacement instead of throwing', () => {
    expect(appSettingsSaveSchema.parse({ theme: 'tachi-crab' })).toStrictEqual({ theme: 'tachi-dark' })
  })

  it('does not throw when a retired id rides along with an unrelated key', () => {
    // The real-world shape: the renderer saves one flag and echoes the theme.
    expect(appSettingsSaveSchema.parse({ theme: 'tachi-crab', webSearchEnabled: true }))
      .toStrictEqual({ theme: 'tachi-dark', webSearchEnabled: true })
  })

  it('still rejects an id that was never a theme at all', () => {
    expect(() => appSettingsSaveSchema.parse({ theme: 'tachi-lobster' })).toThrow()
  })
})

// ── Custom (imported) themes ────────────────────────────────────────────────
// The active-theme value is a union: the built-in ids OR a `custom:<slug>`
// pointer. The built-in ENUM is deliberately not extended with dynamic ids —
// the themes themselves live in the separate `customThemes` array.
describe('custom themes', () => {
  it('accepts a custom: theme id alongside the built-ins', () => {
    expect(appSettingsSaveSchema.parse({ theme: 'custom:neo-brutal' })).toStrictEqual({ theme: 'custom:neo-brutal' })
    expect(appSettingsSaveSchema.parse({ theme: 'comic' })).toStrictEqual({ theme: 'comic' })
  })

  it('rejects a malformed custom id rather than silently dropping the theme', () => {
    for (const bad of ['custom:', 'custom:Neo', 'custom:-neo', 'custom:a b', 'custom:x'.repeat(40), 'neo-brutal']) {
      expect(() => appSettingsSaveSchema.parse({ theme: bad }), bad).toThrow()
    }
  })

  it('round-trips the customThemes array', () => {
    const customThemes = [{ id: 'neo', label: 'Neo Brutal', css: ':root[data-theme="custom:neo"]{--bg-base:#000}' }]
    expect(appSettingsSaveSchema.parse({ customThemes })).toStrictEqual({ customThemes })
  })

  it('round-trips structureCss — zod strips unknown keys, so a missing schema line silently drops the layer on the next boot', () => {
    const withStructure = [{
      id: 'neo', label: 'Neo Brutal',
      css: ':root[data-theme="custom:neo"]{--bg-base:#000}',
      structureCss: ':root[data-theme="custom:neo"] body{background-image:none!important}',
    }]
    expect(appSettingsSaveSchema.parse({ customThemes: withStructure })).toStrictEqual({ customThemes: withStructure })
    // Legacy palette-only entries stay valid without the field.
    const legacy = [{ id: 'neo', label: 'Neo', css: ':root{}' }]
    expect(appSettingsSaveSchema.parse({ customThemes: legacy })).toStrictEqual({ customThemes: legacy })
    // The structure layer has its own cap, matching MAX_STRUCTURE_CSS_CHARS.
    const huge = [{ id: 'neo', label: 'Neo', css: ':root{}', structureCss: 'a'.repeat(200_001) }]
    expect(() => appSettingsSaveSchema.parse({ customThemes: huge })).toThrow()
  })

  it('rejects an entry with a bad slug, an empty label or empty css', () => {
    const base = { id: 'neo', label: 'Neo', css: ':root{}' }
    expect(() => appSettingsSaveSchema.parse({ customThemes: [{ ...base, id: 'NEO' }] })).toThrow()
    expect(() => appSettingsSaveSchema.parse({ customThemes: [{ ...base, label: '' }] })).toThrow()
    expect(() => appSettingsSaveSchema.parse({ customThemes: [{ ...base, css: '' }] })).toThrow()
  })

  it('caps the payload size (a renderer cannot dump megabytes into settings)', () => {
    const huge = { id: 'neo', label: 'Neo', css: 'a'.repeat(32_001) }
    expect(() => appSettingsSaveSchema.parse({ customThemes: [huge] })).toThrow()
  })
})
