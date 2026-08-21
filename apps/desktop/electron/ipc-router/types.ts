// apps/desktop/electron/ipc-router/types.ts
//
// Shared TypeScript helpers for the typed IPC router.
// No runtime code lives here — only type-level utilities.

import type { z } from 'zod'

// ── Route definition shape ────────────────────────────────────────────────────
//
// TInput and TOutput are Zod schemas. Concrete Zod types like ZodObject extend
// ZodTypeAny so the constraint is correct; the RouteMap uses `any` for the
// generic parameters to avoid TypeScript's invariant-check false-positives when
// assigning concrete RouteDef<ZodObject,...> to a map value type.

export interface RouteDef<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
> {
  input:  TInput
  output: TOutput
  handle: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>
}

// RouteMap uses `any` generic args so concrete RouteDef<ZodObject<...>, ...>
// is assignable without TypeScript emitting false invariant errors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteMap = Record<string, RouteDef<any, any>>

export interface RouterDef<TRoutes extends RouteMap> {
  /** Wire namespace prefix, e.g. "shell" → channels like "shell:open-external" */
  namespace: string
  routes:    TRoutes
}

// ── Renderer-side API shape inferred from a RouterDef ────────────────────────
//
// Given a RouterDef, this produces the async function map that the renderer
// calls through contextBridge. Each route becomes:
//   routeKey(input: I) => Promise<O>
//
// Usage in electron.d.ts:
//   import type { shellRouter } from '../../electron/ipc/shell.ipc'
//   type ShellAPI = inferRouterAPI<typeof shellRouter>

type CamelFromKebab<S extends string> =
  S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<CamelFromKebab<Tail>>}`
    : S

type RouteKeyToCamel<K extends string> = CamelFromKebab<K>

export type inferRouterAPI<TRouter extends RouterDef<RouteMap>> = {
  [K in keyof TRouter['routes'] as RouteKeyToCamel<K & string>]:
    (input: z.infer<TRouter['routes'][K]['input']>) => Promise<z.infer<TRouter['routes'][K]['output']>>
}

// ── Result envelope ───────────────────────────────────────────────────────────
//
// Every ipcMain.handle registered by the router returns this shape.
// The renderer-side preloadBridge unwraps it and throws on { ok: false }.

export type IpcResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: string; message: string } }
