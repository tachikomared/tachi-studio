import { ipcMain } from 'electron'
import { z } from 'zod'
import { listModels, healthCheck, testKey, testCustomEndpoint, listCustomEndpointModels } from '../services/provider-service'
import { probeModelCapability } from '../services/model-capability-probe'
import { checkUrlEgressSafe } from '../services/egress-policy'
import { retrieveKey } from '../services/keychain'
import {
  validateBankrKey,
  validateImgnaiCredential,
  validateVeniceKey,
  validateSurplusKey,
  unverified,
} from '../services/provider-key-probe'

export function registerProviderIpc() {
  ipcMain.handle('provider:list-models', (_event, payload: unknown) => {
    const { providerId } = z.object({ providerId: z.string() }).parse(payload)
    return listModels(providerId)
  })

  // Last-good catalog from the auto-refresher's disk cache — pickers fall back
  // to this (instead of the frozen static arrays) when a live fetch fails.
  ipcMain.handle('provider:cached-models', async (_event, payload: unknown) => {
    const { providerId } = z.object({ providerId: z.string() }).parse(payload)
    const { readCatalog } = await import('../services/model-catalog-cache')
    return readCatalog(providerId)
  })

  ipcMain.handle('provider:health-check', (_event, payload: unknown) => {
    const { providerId } = z.object({ providerId: z.string() }).parse(payload)
    return healthCheck(providerId)
  })

  ipcMain.handle('provider:test-key', (_event, payload: unknown) => {
    const { providerId, key } = z.object({ providerId: z.string(), key: z.string() }).parse(payload)
    return testKey(providerId, key)
  })

  // ── VALIDATE-BEFORE-STORE, for the four credentials that can be asked ──────
  //
  // Deliberately NOT one generic `provider:validate-key` channel. Of the seven
  // key cards in Settings six now have an endpoint that reads the credential
  // (civitai, huggingface — on their own channels — and these four). The
  // seventh, OpenGateway, has none: its /v1/models answers 200 to any string
  // including no header, and the only key-reading endpoint is a PAID
  // completion. A channel that took a providerId would have to answer
  // *something* for it, and every possible answer is a lie — `ok: true` invents
  // a check, a rejection makes its key unsavable. Naming the provider in the
  // channel makes the absence structural: there is no channel to call.
  //
  // The measured status tables that decide this live in
  // services/provider-key-probe.ts. NOTE that `provider:test-key` above is NOT
  // a substitute: for the OpenAI-shaped providers it probes /v1/models, which
  // most of them answer 200 to any string.
  //
  // All four resolve (never reject) and all four are given the TYPED value —
  // the card pings before it saves, so a REJECTED credential is never written.
  // An UNVERIFIED one is: see the verdict block at the top of
  // provider-key-probe.ts.

  ipcMain.handle('provider:validate-bankr-key', async (_event, payload: unknown) => {
    const parsed = z.object({ key: z.string() }).safeParse(payload ?? {})
    // A malformed payload is "we could not ask", not "the key is bad" — so it is
    // UNVERIFIED, and the card is free to store the key it holds. Answering
    // `rejected` here would let an IPC-shape bug destroy a user's ability to
    // save a working credential.
    if (!parsed.success) return unverified()
    return validateBankrKey(parsed.data.key)
  })

  ipcMain.handle('provider:validate-imgnai-credential', async (_event, payload: unknown) => {
    const parsed = z.object({ key: z.string(), secret: z.string() }).safeParse(payload ?? {})
    if (!parsed.success) return unverified()
    return validateImgnaiCredential(parsed.data.key, parsed.data.secret)
  })

  // Venice: GET /api/v1/api_keys/rate_limits. 200 → tier + balance, 403 → valid
  // but scope-limited, 401/402/anything else → unverified. Venice NEVER returns
  // `rejected` from this channel, and the reason is written out in full in
  // validateVeniceKey.
  ipcMain.handle('provider:validate-venice-key', async (_event, payload: unknown) => {
    const parsed = z.object({ key: z.string() }).safeParse(payload ?? {})
    if (!parsed.success) return unverified()
    return validateVeniceKey(parsed.data.key)
  })

  // Surplus: POST /anthropic/v1/messages/count_tokens — reads the buyer key,
  // runs no inference (their docs: "a heuristic estimate (no upstream
  // round-trip)"), settles nothing. 401 → rejected; anything else → unverified.
  ipcMain.handle('provider:validate-surplus-key', async (_event, payload: unknown) => {
    const parsed = z.object({ key: z.string() }).safeParse(payload ?? {})
    if (!parsed.success) return unverified()
    return validateSurplusKey(parsed.data.key)
  })

  // Custom OpenAI-compatible endpoint (USER-PAINS T17) — TEST button. Probes
  // GET <baseUrl>/models with a 5s timeout in the main process (no CSP/CORS),
  // returning the model count or a friendly error. The (unsaved) key is passed
  // through for the probe only; it is NOT persisted here.
  ipcMain.handle('provider:test-custom-endpoint', (_event, payload: unknown) => {
    const { baseUrl, key } = z.object({ baseUrl: z.string().min(1), key: z.string().optional() }).parse(payload)
    return testCustomEndpoint(baseUrl, key)
  })

  // Custom endpoint live model list for the chat picker (60s cache, fails open).
  ipcMain.handle('provider:list-custom-models', (_event, payload: unknown) => {
    const { providerId, force } = z.object({ providerId: z.string().min(1), force: z.boolean().optional() }).parse(payload)
    return listCustomEndpointModels(providerId, force ?? false)
  })

  // Two-gate model admission probe (STEAL 2026-06-12 cluster E): text + tool
  // call. On-demand (spends a trivial amount of quota) — surfaces use it to
  // flag 'chat-only' models before routing agentic work at them.
  ipcMain.handle('provider:probe-model', async (_event, payload: unknown) => {
    const { baseUrl, model, providerId } = z.object({
      baseUrl: z.string().url(),
      model: z.string().min(1),
      // When given, the key is pulled from the OS keychain — the renderer
      // never handles raw keys.
      providerId: z.string().optional(),
    }).parse(payload)
    const egress = await checkUrlEgressSafe(baseUrl)
    if (!egress.allowed) return { textOk: false, toolsOk: false, verdict: 'unusable', detail: egress.reason }
    const apiKey = providerId ? retrieveKey(providerId) ?? undefined : undefined
    return probeModelCapability({ baseUrl, model, apiKey })
  })
}
