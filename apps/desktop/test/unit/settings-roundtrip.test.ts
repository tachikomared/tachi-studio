// apps/desktop/test/unit/settings-roundtrip.test.ts
//
// Integration round-trip of the settings:save pipeline minus IPC plumbing:
//   appSettingsSaveSchema.parse(partial) -> saveSettings(validated) -> loadSettings()
// Exercises the real settings-store disk IO (temp dir via mocked app.getPath),
// proving the two regression fields (userMemory, mcpMode) actually persist and
// load back merged over DEFAULT_SETTINGS — the user-visible behavior that was
// broken while the schema silently stripped them.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  return mkdtempSync(join(tmpdir(), 'tachi-settings-test-'))
})

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => TEST_DIR },
}))

import { appSettingsSaveSchema } from '../../electron/services/settings-schema'
import { loadSettings, saveSettings } from '../../electron/services/settings-store'
import { DEFAULT_SETTINGS } from '@tachi/core'

beforeEach(() => {
  const file = join(TEST_DIR, 'tachi-settings.json')
  if (existsSync(file)) rmSync(file)
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('settings:save pipeline round-trip (validate -> disk -> load)', () => {
  it('persists and reloads userMemory', () => {
    const validated = appSettingsSaveSchema.parse({ userMemory: 'prefers pnpm; brutalist UI' })
    saveSettings(validated)
    const loaded = loadSettings()
    expect(loaded.userMemory).toBe('prefers pnpm; brutalist UI')
  })

  it('persists and reloads mcpMode', () => {
    const validated = appSettingsSaveSchema.parse({ mcpMode: 'locked' })
    saveSettings(validated)
    const loaded = loadSettings()
    expect(loaded.mcpMode).toBe('locked')
  })

  it('partial saves merge over defaults without clobbering other keys', () => {
    saveSettings(appSettingsSaveSchema.parse({ userMemory: 'fact' }))
    saveSettings(appSettingsSaveSchema.parse({ mcpMode: 'read_write' }))
    const loaded = loadSettings()
    expect(loaded.userMemory).toBe('fact')
    expect(loaded.mcpMode).toBe('read_write')
    expect(loaded.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(loaded.mcpServerEnabled).toBe(DEFAULT_SETTINGS.mcpServerEnabled)
  })
})
