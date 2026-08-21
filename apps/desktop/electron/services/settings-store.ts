import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { AppSettings, DEFAULT_SETTINGS } from '@tachi/core'

/**
 * LAZY on purpose — this was a module-scope `const SETTINGS_FILE = join(
 * app.getPath('userData'), …)`, which made merely IMPORTING this file (or
 * anything that reaches it, e.g. storage-root → download-manager → half the
 * service graph) require a live electron `app`. Two consequences, one of them
 * only visible in tests:
 *   · every vitest file whose import graph ever grew into this one had to mock
 *     electron BEFORE the import, and — because vi.mock factories are hoisted —
 *     with a vi.hoisted() value, or the factory read a `const` still in its
 *     temporal dead zone. That trap has now bitten three test files;
 *   · the userData path was frozen at module-load order rather than read when
 *     it is used.
 * Computing it per call costs one join(); loadSettings is not a hot path (its
 * one hot caller, storage-root::getStorageRoot, caches its own result).
 */
function settingsFile(): string {
  return join(app.getPath('userData'), 'tachi-settings.json')
}

export function loadSettings(): AppSettings {
  const file = settingsFile()
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(partial: Partial<AppSettings>): void {
  const current = loadSettings()
  const merged = { ...current, ...partial }
  const file = settingsFile()
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(merged, null, 2), 'utf8')
  renameSync(file + '.tmp', file)
}
