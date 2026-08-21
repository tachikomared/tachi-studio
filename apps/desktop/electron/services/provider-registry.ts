// Sprint B3 — provider-as-data registry.
// Schema inspired by NangoHQ/nango's `providers.yaml` concept (Elastic License v2);
// all data values here are written fresh from public provider documentation,
// not copied from Nango's YAML.

import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type {
  ProviderDef,
  OAuthPkceProvider,
  OAuthDeviceProvider,
} from './providers/provider-types'

// Re-export types so callers can import from one place.
export type { ProviderDef, OAuthPkceProvider, OAuthDeviceProvider }
export type { ApiKeyProvider, LocalProvider, VerifyAuth } from './providers/provider-types'

// ── YAML shape (raw parse) ────────────────────────────────────────────────────

interface RawProvider {
  label:        string
  kind:         'oauth_pkce' | 'oauth_device' | 'api_key' | 'local'
  authBaseUrl?: string
  tokenUrl?:    string
  clientId?:    string
  scope?:       string
  verifyUrl:    string
  verifyAuth:   'bearer' | 'x-api-key' | 'none'
}

interface RawYaml {
  providers: Record<string, RawProvider>
}

// ── Lazy-loaded singleton ────────────────────────────────────────────────────

let _registry: Record<string, ProviderDef> | null = null

function resolveYamlPath(): string {
  // electron-vite bundles JS/TS but leaves static assets untouched only when
  // they're referenced in code that vite knows about. Since we read this via
  // fs.readFileSync at runtime we need an explicit path strategy:
  //
  //  • Dev  (app.isPackaged === false): __dirname resolves to
  //    apps/desktop/out/main/ — so we walk up and back into services.
  //    electron-vite copies non-TS assets from src into out automatically,
  //    BUT only from the renderer. For the main process we rely on the fact
  //    that electron-vite is running with the SOURCE tree still present, so
  //    we use process.cwd() / the source path.
  //
  //  • Packaged (app.isPackaged === true): the YAML is declared in
  //    extraResources in electron-builder.json and lands at
  //    <resources>/providers/providers.yaml.

  if (app.isPackaged) {
    return join(process.resourcesPath, 'providers', 'providers.yaml')
  }

  // In dev, __dirname is something like …/apps/desktop/out/main
  // The source YAML is at …/apps/desktop/electron/services/providers/providers.yaml
  // Walk back from __dirname to the project root and find it.
  // We try multiple candidate paths so this works whether electron-vite is
  // running in watch mode (source tree) or after a build.
  const candidates = [
    // Source tree (electron-vite dev): __dirname = out/main
    join(__dirname, '..', '..', 'electron', 'services', 'providers', 'providers.yaml'),
    // If __dirname happens to be the services dir directly (tests / ts-node)
    join(__dirname, 'providers', 'providers.yaml'),
    // Fallback: cwd-relative (useful for integration tests run from project root)
    join(process.cwd(), 'apps', 'desktop', 'electron', 'services', 'providers', 'providers.yaml'),
  ]

  for (const p of candidates) {
    try {
      readFileSync(p)   // probe — throws if absent
      return p
    } catch {
      // try next
    }
  }

  throw new Error(
    `[provider-registry] Cannot find providers.yaml. Tried:\n${candidates.join('\n')}`
  )
}

// R8b: `yaml` is loaded on first parse, not at boot — 13.8 ms of the 1317 ms
// pre-STARTUP_T0 prelude, shared with role-registry.ts / aeon-service.ts.
// Bare specifier ⇒ `require()` is allowed (noRuntimeRelativeRequire.test.ts)
// and keeps buildRegistry() synchronous.
function parseYaml(text: string): unknown {
  const { parse } = require('yaml') as typeof import('yaml')
  return parse(text)
}

function buildRegistry(): Record<string, ProviderDef> {
  const yamlPath = resolveYamlPath()
  const raw = parseYaml(readFileSync(yamlPath, 'utf-8')) as RawYaml

  if (!raw?.providers || typeof raw.providers !== 'object') {
    throw new Error(`[provider-registry] providers.yaml missing top-level "providers" map`)
  }

  const result: Record<string, ProviderDef> = {}

  for (const [id, entry] of Object.entries(raw.providers)) {
    const base = {
      id,
      label:      entry.label,
      verifyUrl:  entry.verifyUrl,
      verifyAuth: entry.verifyAuth,
    }

    switch (entry.kind) {
      case 'oauth_pkce':
        result[id] = {
          ...base,
          kind:        'oauth_pkce',
          authBaseUrl: entry.authBaseUrl!,
          tokenUrl:    entry.tokenUrl!,
          clientId:    entry.clientId,
          scope:       entry.scope ?? '',
        } satisfies OAuthPkceProvider
        break

      case 'oauth_device':
        result[id] = {
          ...base,
          kind:        'oauth_device',
          authBaseUrl: entry.authBaseUrl!,
          tokenUrl:    entry.tokenUrl!,
          clientId:    entry.clientId!,
          scope:       entry.scope ?? '',
        } satisfies OAuthDeviceProvider
        break

      case 'api_key':
        result[id] = { ...base, kind: 'api_key' }
        break

      case 'local':
        result[id] = { ...base, kind: 'local' }
        break

      default:
        console.warn(`[provider-registry] Unknown provider kind "${(entry as RawProvider).kind}" for id "${id}" — skipping`)
    }
  }

  return result
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load (or return the cached) full registry.
 * Reads providers.yaml synchronously on first call, then caches in memory.
 */
export function loadRegistry(): Record<string, ProviderDef> {
  if (!_registry) {
    _registry = buildRegistry()
  }
  return _registry
}

/**
 * Look up any provider by id. Returns undefined if not found.
 */
export function getProvider(id: string): ProviderDef | undefined {
  return loadRegistry()[id]
}

/**
 * Look up an OAuth provider (pkce or device) by id.
 * Returns undefined if the provider is not found or is not an OAuth kind.
 */
export function getOAuthProvider(id: string): OAuthPkceProvider | OAuthDeviceProvider | undefined {
  const p = getProvider(id)
  if (!p) return undefined
  if (p.kind === 'oauth_pkce' || p.kind === 'oauth_device') return p
  return undefined
}

/**
 * Return all registered providers as a flat array, sorted by id.
 */
export function listProviders(): ProviderDef[] {
  return Object.values(loadRegistry()).sort((a, b) => a.id.localeCompare(b.id))
}
