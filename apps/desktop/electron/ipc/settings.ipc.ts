import { ipcMain } from 'electron'
import { z } from 'zod'
import { listProviders, customEndpointKeychainId } from '@tachi/core'
import { loadSettings, saveSettings } from '../services/settings-store'
import { appSettingsSaveSchema } from '../services/settings-schema'
import { storeKey, deleteKey, getStorageBackend, hasKey } from '../services/keychain'

const FREELLMAPI_PROVIDER_IDS = [
  'google', 'groq', 'cerebras', 'sambanova', 'mistral',
  'openrouter', 'github', 'cloudflare', 'cohere', 'zai', 'nvidia',
]

// list-keys reports which ids have a stored credential. Provider keychain ids
// come FROM THE REGISTRY so a newly added provider is reported automatically —
// a hardcoded copy silently broke imgnai ("✓ Key stored" never showed even
// though the key saved fine). Non-provider keys (search APIs) stay literal.
// 'civitai' is a WEIGHTS SOURCE, not an inference provider — it has no row in
// the provider registry, so it has to be listed here or the Settings card can
// never show "✓ Key stored" (the exact bug the comment above records for
// imgnai). Search works without the key; it only gates account-locked
// downloads and raises rate limits.
// 'huggingface' is the same case as 'civitai': a WEIGHTS HOST with no provider
// registry row. Without it here the Settings card's "✓ Key stored" line can
// never appear, however well the token saved.
const NON_PROVIDER_KEY_IDS = ['brave-search', 'tavily', 'civitai', 'huggingface']
const PROVIDER_KEYCHAIN_IDS = [
  ...new Set(listProviders().map(p => p.keychainId).filter((id): id is string => !!id)),
]
const EXTRA_PROVIDER_IDS = [...PROVIDER_KEYCHAIN_IDS, ...NON_PROVIDER_KEY_IDS]

export function registerSettingsIpc() {
  ipcMain.handle('settings:load', () => {
    const settings = loadSettings()
    const backend = getStorageBackend()
    return { ...settings, storageBackend: backend }
  })

  ipcMain.handle('settings:save', (_event, partial: unknown) => {
    // No .passthrough() — only known AppSettings keys are allowed; unknown keys are stripped
    const validated = appSettingsSaveSchema.parse(partial)
    saveSettings(validated)
  })

  ipcMain.handle('settings:save-key', (_event, payload: unknown) => {
    const schema = z.object({ providerId: z.string().min(1), key: z.string().min(1) })
    const { providerId, key } = schema.parse(payload)
    storeKey(providerId, key)
  })

  ipcMain.handle('settings:delete-key', (_event, payload: unknown) => {
    const schema = z.object({ providerId: z.string().min(1) })
    const { providerId } = schema.parse(payload)
    deleteKey(providerId)
  })

  ipcMain.handle('settings:list-keys', () => {
    // Custom OpenAI-compatible endpoints (USER-PAINS T17) store their optional
    // key under `custom:<id>` — derive those ids from the persisted providers so
    // the Settings card / picker can reflect "key stored" for them too.
    const customKeychainIds = (loadSettings().providers ?? [])
      .filter(p => p.kind === 'custom-openai')
      .map(p => customEndpointKeychainId(p.id))
    return [...FREELLMAPI_PROVIDER_IDS, ...EXTRA_PROVIDER_IDS, ...customKeychainIds].filter(id => hasKey(id))
  })
}
