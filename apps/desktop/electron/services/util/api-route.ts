// apps/desktop/electron/services/util/api-route.ts
//
// Pure routing logic for the local OpenAI-compatible API server. Kept free of
// electron imports so test/unit can exercise it directly.
//
// The server fronts two engines:
//   - llama.cpp  (llama-server, one loaded GGUF model, no auth)
//   - freellmapi (the bundled free-provider router, Bearer-gated)
// A request's `model` field picks the engine; everything else is a verbatim
// passthrough.

export interface UpstreamContext {
  /** llama-server port, present only when running with a loaded model. */
  llamaPort?: number | null
  /** Registry id of the model currently loaded in llama-server. */
  llamaModelId?: string | null
  /** freellmapi port, present only when the router sidecar is up. */
  freellmPort?: number | null
  /**
   * Every GGUF DOWNLOADED on this machine, whether or not one is loaded right
   * now, plus the id llama-server last served.
   *
   * Without this the router cannot tell "a model that lives on your disk and
   * happens to be unloaded" from "a model name we have never heard of" — and
   * that difference is the whole of the bug below.
   */
  localModelIds?: readonly string[] | null
}

export type UpstreamPick =
  | { kind: 'llama'; port: number }
  | { kind: 'freellm'; port: number }
  /**
   * The request named a LOCAL model that is not loaded. Never served by anyone
   * else — see the refusal rule in pickUpstream. `modelId` is the one to load
   * (the named id, or the last-served one for a bare `local` / `llama-cpp`).
   */
  | { kind: 'llama-not-loaded'; modelId: string | null }
  | { kind: 'none'; reason: string }

/** The generic aliases that mean "whatever GGUF this machine is serving". */
function isLocalAlias(m: string): boolean {
  return m === 'llama-cpp' || m === 'local' || m.startsWith('llama-cpp:')
}

/**
 * Decide which engine serves `model`.
 *
 * llama.cpp wins when the request names the loaded GGUF (exactly, or via the
 * generic aliases `llama-cpp` / `local`). Everything else goes to freellmapi,
 * whose router resolves model ids across its provider pool. If only llama is
 * up, it serves any model name — llama-server treats `model` cosmetically
 * (one server = one model), and failing a request that the ONLY running
 * engine could serve helps nobody.
 *
 * ── THE REFUSAL, AND WHY IT IS THE MOST IMPORTANT LINE HERE ─────────────────
 * A request that NAMES A LOCAL MODEL IS NEVER HANDED TO A CLOUD ROUTER, even
 * when that router is the only thing running.
 *
 * Until 2026-08-03 it was. `wantsLlama` required llama to be UP, so the moment
 * it was not, a request for `local` — or for a GGUF sitting on the user's own
 * disk — fell straight through to freellmapi, and the caller got an answer
 * from somebody else's GPU with their prompt on it. No error, no mention: the
 * response is shaped identically. The one thing a user picks a local model FOR
 * is the one thing that silently stopped happening.
 *
 * That path was always reachable (the engine can be stopped by hand, or crash)
 * but the idle auto-unload shipped the same day made it ROUTINE: ten quiet
 * minutes and every subsequent API call was a cloud call. The unload is right;
 * routing around it was not.
 *
 * So an unloaded-but-downloaded model now returns its own outcome and the
 * caller decides — wake it, or refuse. Both are honest. Substituting is not.
 */
export function pickUpstream(model: string | undefined, ctx: UpstreamContext): UpstreamPick {
  const llamaUp = typeof ctx.llamaPort === 'number' && ctx.llamaPort > 0
  const freellmUp = typeof ctx.freellmPort === 'number' && ctx.freellmPort > 0
  const m = (model ?? '').trim()

  const wantsLlama = llamaUp && (m === ctx.llamaModelId || isLocalAlias(m))
  if (wantsLlama) return { kind: 'llama', port: ctx.llamaPort as number }

  // Not up — but is this OUR model? Matched against what is on disk, so the
  // answer does not depend on whether the engine happens to be awake.
  if (!llamaUp) {
    const onDisk = (ctx.localModelIds ?? []).map(x => (x ?? '').trim()).filter(Boolean)
    const named = onDisk.find(id => id === m)
    if (named) return { kind: 'llama-not-loaded', modelId: named }
    if (isLocalAlias(m)) {
      // A bare alias: load whatever we served last, else the only thing on
      // disk. Null when the machine has no GGUF at all — the caller then says
      // "nothing to wake" rather than pretending it could.
      const last = (ctx.llamaModelId ?? '').trim()
      return { kind: 'llama-not-loaded', modelId: last || onDisk[0] || null }
    }
  }

  if (freellmUp) return { kind: 'freellm', port: ctx.freellmPort as number }
  if (llamaUp) return { kind: 'llama', port: ctx.llamaPort as number }
  return {
    kind: 'none',
    reason: 'no local engine is running — start FreeLLM or llama.cpp from the Dashboard',
  }
}

export interface OpenAiModelEntry {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

/**
 * Merge freellmapi's /v1/models payload with the loaded llama.cpp model into
 * one OpenAI-shaped list. The llama entry leads (it's the user's own
 * hardware); duplicate ids are dropped keeping first occurrence.
 */
export function mergeModelLists(
  freellmData: Array<{ id?: unknown; created?: unknown; owned_by?: unknown }> | null | undefined,
  llamaModelId: string | null | undefined,
): { object: 'list'; data: OpenAiModelEntry[] } {
  const out: OpenAiModelEntry[] = []
  const seen = new Set<string>()
  if (llamaModelId) {
    out.push({ id: llamaModelId, object: 'model', created: 0, owned_by: 'llama.cpp' })
    seen.add(llamaModelId)
  }
  for (const raw of freellmData ?? []) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      object: 'model',
      created: typeof raw.created === 'number' ? raw.created : 0,
      owned_by: typeof raw.owned_by === 'string' ? raw.owned_by : 'freellm',
    })
  }
  return { object: 'list', data: out }
}

/** OpenAI-shaped error body (what clients' SDKs know how to surface). */
export function openAiError(message: string, type: string, code?: string): string {
  return JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } })
}
