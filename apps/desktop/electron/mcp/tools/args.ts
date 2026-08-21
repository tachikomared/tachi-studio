// apps/desktop/electron/mcp/tools/args.ts
//
// Shared MCP tool-argument validation (was copy-pasted per tool module).

/** Assert `args[field]` is a string and return it — throws a clear error otherwise. */
export function assertString(args: unknown, field: string): string {
  const v = (args as Record<string, unknown> | null | undefined)?.[field]
  if (typeof v !== 'string') throw new Error(`${field} must be a string`)
  return v
}

/** Return `args[field]` when present — throws if present but not a string. */
export function optionalString(args: unknown, field: string): string | undefined {
  const v = (args as Record<string, unknown> | null | undefined)?.[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`${field} must be a string when provided`)
  return v
}
