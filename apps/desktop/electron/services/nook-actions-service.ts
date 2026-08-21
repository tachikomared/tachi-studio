// apps/desktop/electron/services/nook-actions-service.ts
//
// WRITE ACTIONS for the first-class nookplot integration (main-process side).
//
// This module owns the *mutating* network actions that the read-only
// nook-service.ts deliberately left out: posting a bounty, applying to a
// bounty, submitting work, and hiring a service (marketplace agreement).
//
// All of these are non-custodial on-chain (or off-chain authenticated) calls
// that require a connected runtime AND the agent's private key for EIP-712
// signing. We never touch the key here directly — the runtime (built in
// nook-service.ts with the key already wired) signs internally. We only guard
// that a runtime exists and surface a friendly error if it doesn't.
//
// We build on the existing nook-service exports (getRuntime / nookGatewayUrl /
// TOKENS) rather than re-deriving connection state. Amounts arrive from the UI
// as *human* decimal strings (e.g. "250.5") and are converted to base-unit
// (wei) strings here using the token's decimals, so the renderer never has to
// hand-roll BigInt math.

import { getRuntime } from './nook-service'

// ── Token reference (address + decimals) ────────────────────────────────────
// Matches nook-service's TOKENS table but keyed by symbol for the post-bounty
// / hire forms, which pick a token by name.
const TOKEN_BY_SYMBOL: Record<string, { address: string; decimals: number }> = {
  USDC:    { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6  },
  NOOK:    { address: '0xb233bdffd437e60fa451f62c6c09d3804d285ba3', decimals: 18 },
  BOTCOIN: { address: '0xa601877977340862ca67f816eb079958e5bd0ba3', decimals: 18 },
}

export type NookTokenSymbol = keyof typeof TOKEN_BY_SYMBOL

/** Guard: every write needs a live runtime (which carries the signing key). */
function requireRuntime() {
  const rt = getRuntime()
  if (!rt) throw new Error('Connect to nookplot first (and add your agent private key) to perform write actions.')
  return rt
}

/**
 * Convert a human decimal amount ("250", "12.5", "0.001") to a base-unit
 * (wei) string for the given decimals. No floating-point — pure string math so
 * we never lose precision on 18-decimal tokens.
 */
export function toBaseUnits(human: string, decimals: number): string {
  const trimmed = String(human ?? '').trim()
  if (!trimmed) throw new Error('Amount is required.')
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') throw new Error(`Invalid amount "${human}".`)
  const [wholeRaw, fracRaw = ''] = trimmed.split('.')
  const whole = wholeRaw || '0'
  if (fracRaw.length > decimals) throw new Error(`Too many decimal places for this token (max ${decimals}).`)
  const frac = fracRaw.padEnd(decimals, '0')
  const combined = (whole + frac).replace(/^0+/, '') || '0'
  return combined
}

function resolveToken(symbol: string): { address: string; decimals: number } {
  const t = TOKEN_BY_SYMBOL[symbol as NookTokenSymbol]
  if (!t) throw new Error(`Unknown token "${symbol}". Use USDC, NOOK, or BOTCOIN.`)
  return t
}

// ── Post a bounty ────────────────────────────────────────────────────────────
export interface PostBountyInput {
  title:       string
  description: string
  community:   string
  token:       string   // symbol: USDC | NOOK | BOTCOIN
  amount:      string   // human decimal, e.g. "250"
  deadline:    number    // unix seconds
}

export interface PostBountyResult {
  txHash:   string
  bountyId: number | null
}

export async function postBounty(input: PostBountyInput): Promise<PostBountyResult> {
  const rt = requireRuntime()
  if (!input.title?.trim())       throw new Error('Title is required.')
  if (!input.description?.trim()) throw new Error('Description is required.')
  if (!input.community?.trim())   throw new Error('Community is required.')
  if (!input.deadline || input.deadline * 1000 <= Date.now())
    throw new Error('Deadline must be in the future.')

  const tok = resolveToken(input.token)
  const tokenRewardAmount = toBaseUnits(input.amount, tok.decimals)

  // CreateBountyInput: { title, description, community, deadline, tokenRewardAmount?, tokenAddress? }
  const res = await rt.bounties.create({
    title:             input.title.trim(),
    description:       input.description.trim(),
    community:         input.community.trim(),
    deadline:          input.deadline,
    tokenRewardAmount,
    tokenAddress:      tok.address,
  })
  return { txHash: res.txHash, bountyId: res.bountyId ?? null }
}

// ── Apply to a bounty (off-chain shortlist) ──────────────────────────────────
// There is no SDK method for applying — applications live at the off-chain
// endpoint POST /v1/bounties/:id/apply (body: { message }). We go through the
// runtime's authenticated connection so the agent's session key authorizes the
// call. NOTE: `GET /v1/bounties/:id/applications` LISTS applications; the write
// path is the singular `/apply` — posting to `/applications` 404s.
export async function applyBounty(id: string, message: string): Promise<{ ok: true }> {
  const rt = requireRuntime()
  const bountyId = Number(id)
  if (!Number.isFinite(bountyId)) throw new Error(`Invalid bounty id "${id}".`)
  const msg = message?.trim()
  if (!msg) throw new Error('Application message is required.')
  // Gateway requires the application message to be at least 50 chars (it is the
  // primary signal the bounty creator reviews — see the apply_bounty action doc).
  if (msg.length < 50) throw new Error('Application message must be at least 50 characters — describe your approach, relevant experience, and timeline.')
  await rt.connection.request('POST', `/v1/bounties/${bountyId}/apply`, {
    message: msg,
  })
  return { ok: true }
}

// ── Submit work for a bounty (on-chain) ──────────────────────────────────────
export async function submitWork(
  id: string,
  description: string,
  deliverables: string[] = [],
): Promise<{ ok: true; txHash: string }> {
  const rt = requireRuntime()
  const bountyId = Number(id)
  if (!Number.isFinite(bountyId)) throw new Error(`Invalid bounty id "${id}".`)
  if (!description?.trim()) throw new Error('Work description is required.')
  const res = await rt.bounties.submit(bountyId, description.trim(), deliverables)
  return { ok: true, txHash: res.txHash }
}

// ── Hire a service (create marketplace agreement) ────────────────────────────
export interface HireServiceInput {
  listingId: string
  terms:     string
  deadline:  number    // unix seconds
  token?:    string    // symbol; default USDC
  amount?:   string    // human decimal escrow amount; optional
}

export async function hireService(_input: HireServiceInput): Promise<{ ok: true; txHash: string }> {
  // Marketplace agreements are currently UNAVAILABLE end-to-end. The deployed
  // gateway (v0.5.32) changed its agreement API ({requirements, budget}) while
  // the installed @nookplot/runtime's createAgreement still sends {terms,
  // tokenAmount}; the gateway-prepared ForwardRequest then fails on-chain verify
  // ("ForwardRequest signature verification failed"). The domain/types are
  // gateway-supplied, so reshaping our body can't fix it — it needs an SDK that
  // matches the live gateway. Fail with an honest message instead of a cryptic 400.
  throw new Error(
    'Hiring via marketplace agreements is temporarily unavailable — the nookplot gateway changed its agreement API and the installed runtime SDK is out of sync. You can still message the provider directly from Messages.',
  )
}
