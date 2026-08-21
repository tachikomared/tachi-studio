// apps/desktop/electron/services/cost-pricing.ts
//
// Cost-ledger price helpers. The authoritative $/M-token table now lives in
// @tachi/core (packages/core/src/pricing.ts) as the SINGLE source of truth,
// shared with the renderer's per-conversation estimates (ObservabilityTab.tsx)
// — no more drifting duplicate. Unknown model → null, NEVER a fabricated
// number: unpriced usage is recorded with costUsd 0 and priced:false so the
// dashboard can show it honestly.

export {
  ratesFor, costUsd, costUsdFromRates, isVerifiedFreeModel,
  retirementOf, RETIRED_MODELS,
  type ModelRates, type RetiredModel,
} from '@tachi/core'
