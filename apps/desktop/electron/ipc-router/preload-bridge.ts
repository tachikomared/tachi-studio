// apps/desktop/electron/ipc-router/preload-bridge.ts
//
// Given a RouterDef (passed as a type parameter), generate the typed
// contextBridge namespace that the renderer calls through window.tachi.<ns>.
//
// Usage in preload.ts:
//   import { preloadBridge } from './ipc-router/preload-bridge'
//   import type { shellRouter } from './ipc/shell.ipc'
//
//   const shell = preloadBridge<typeof shellRouter>('shell', ['openExternal'])
//   contextBridge.exposeInMainWorld('tachi', { ...existing, shell })
//
// The second argument is an explicit list of route keys (camelCase).
// This is necessary because TypeScript generic type parameters are erased at
// runtime — we can't iterate the router's route keys from the type alone.
// The list must match the keys defined in the router (a mismatch is a compile
// error if you use `satisfies` — see the README for the pattern).
//
// Channel-name contract: keys are converted to kebab-case and prefixed with
// the namespace, matching exactly what registerRouter() registers on the main
// side. "shell" + "openExternal" → ipcRenderer.invoke("shell:open-external").

import { ipcRenderer } from 'electron'
import type { RouterDef, RouteMap, IpcResult, inferRouterAPI } from './types'

// ── Channel-name helper (must mirror router.ts) ───────────────────────────────

function camelToKebab(key: string): string {
  return key.replace(/([A-Z])/g, '-$1').toLowerCase()
}

// ── Bridge builder ────────────────────────────────────────────────────────────

/**
 * Build the renderer-side proxy object for a typed router namespace.
 *
 * TRouter   - the router type (e.g. typeof shellRouter)
 * namespace - wire prefix used in channel names (must match the router's namespace)
 * routeKeys - runtime list of camelCase route keys (matches TRouter['routes'])
 *
 * Each key in routeKeys becomes an async function:
 *   (input) => Promise<output>
 *
 * On success the envelope { ok: true, data } is unwrapped and data is returned.
 * On failure { ok: false, error } the error is thrown as an Error object.
 */
export function preloadBridge<TRouter extends RouterDef<RouteMap>>(
  namespace: string,
  routeKeys: ReadonlyArray<string & keyof TRouter['routes']>,
): inferRouterAPI<TRouter> {
  const api: Record<string, (input: unknown) => Promise<unknown>> = {}

  for (const key of routeKeys) {
    const channel = `${namespace}:${camelToKebab(key)}`
    api[key] = async (input: unknown) => {
      const result = await ipcRenderer.invoke(channel, input) as IpcResult<unknown>
      if (!result.ok) {
        throw Object.assign(
          new Error(result.error.message),
          { code: result.error.code },
        )
      }
      return result.data
    }
  }

  return api as inferRouterAPI<TRouter>
}
