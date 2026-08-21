// apps/desktop/electron/ipc-router/router.ts
//
// Typed IPC router — wraps ipcMain.handle with Zod-validated, envelope-wrapped routes.
//
// Design goals:
//   - Zero wire-protocol change: channel names stay identical (e.g. "shell:open-external").
//   - Additive: coexists with existing registerXxxIpc() calls; only migrated namespaces
//     use the router.
//   - Typed end-to-end: input/output are Zod schemas; inferRouterAPI<T> derives the
//     renderer-side interface from the router definition at the type level only.
//
// Usage (main process):
//   import { shellRouter } from './ipc/shell.ipc'
//   import { registerRouter } from './ipc-router/router'
//   registerRouter(shellRouter)

import { ipcMain } from 'electron'
import { z, ZodError } from 'zod'
import type { RouteDef, RouteMap, RouterDef, IpcResult } from './types'

// ── Public builder API ────────────────────────────────────────────────────────

/**
 * Define a single typed route.
 *
 * @example
 * const myRoute = route({
 *   input:  z.object({ url: z.string().url() }),
 *   output: z.object({ ok: z.literal(true) }),
 *   handle: async ({ url }) => { ...; return { ok: true } },
 * })
 */
export function route<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(def: RouteDef<TInput, TOutput>): RouteDef<TInput, TOutput> {
  return def
}

/**
 * Bundle a set of routes under a namespace prefix.
 *
 * The namespace is used to build channel names:
 *   namespace "shell" + route key "openExternal" → channel "shell:open-external"
 *
 * @example
 * export const shellRouter = defineRouter('shell', {
 *   openExternal: route({ ... }),
 * })
 */
export function defineRouter<TRoutes extends RouteMap>(
  namespace: string,
  routes: TRoutes,
): RouterDef<TRoutes> {
  return { namespace, routes }
}

// ── Channel-name helpers ──────────────────────────────────────────────────────

/**
 * Convert a camelCase key to kebab-case for use in channel names.
 * "openExternal" → "open-external"
 * "listModels"   → "list-models"
 */
function camelToKebab(key: string): string {
  return key.replace(/([A-Z])/g, '-$1').toLowerCase()
}

/**
 * Build the full channel name: "<namespace>:<kebab-key>"
 * "shell" + "openExternal" → "shell:open-external"
 */
export function channelName(namespace: string, routeKey: string): string {
  return `${namespace}:${camelToKebab(routeKey)}`
}

// ── Main-process registration ─────────────────────────────────────────────────

/**
 * Register all routes in a RouterDef with ipcMain.handle.
 *
 * Each handler:
 *   1. Parses the payload with the route's Zod input schema.
 *   2. Calls the route handler.
 *   3. Returns { ok: true, data: <output> } on success.
 *   4. Returns { ok: false, error: { code, message } } on any thrown error.
 *
 * The channel name is derived automatically from the namespace + route key.
 * Existing ipcMain.handle registrations for the same channel are silently
 * replaced (Electron 31 removes the old handler when you call handle again).
 */
export function registerRouter<TRoutes extends RouteMap>(
  router: RouterDef<TRoutes>,
): void {
  const { namespace, routes } = router

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [key, routeDef] of Object.entries(routes) as Array<[string, RouteDef<any, any>]>) {
    const channel = channelName(namespace, key)

    ipcMain.handle(channel, async (_event, payload: unknown): Promise<IpcResult<unknown>> => {
      try {
        const input = routeDef.input.parse(payload)
        const output = await routeDef.handle(input)
        return { ok: true, data: output }
      } catch (err) {
        if (err instanceof ZodError) {
          return {
            ok:    false,
            error: {
              code:    'VALIDATION_ERROR',
              message: err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
            },
          }
        }
        return {
          ok:    false,
          error: {
            code:    'HANDLER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }
    })
  }
}
