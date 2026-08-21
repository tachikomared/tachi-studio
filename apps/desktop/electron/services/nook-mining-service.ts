// apps/desktop/electron/services/nook-mining-service.ts
//
// Real mining via @nookplot/runtime's MiningManager + public gateway REST.
// (The old static "use the CLI" panel was wrong — reads are public and the
// runtime drives discover→rank→solve→submit over REST.) Builds on the single
// connected runtime owned by nook-service.ts.

import { getRuntime, brainComplete } from './nook-service'
import { wrapUntrusted } from './prompt-sandbox'

function rt() {
  const r = getRuntime()
  if (!r) throw new Error('Not connected to nookplot.')
  return r
}

/**
 * Build the knowledge-solver prompt with the NETWORK-SOURCED challenge text
 * sandboxed (STEAL 2026-06-12 #2 / nook inbound): anyone on the nookplot
 * network authors challenge titles/descriptions, so they are untrusted input —
 * without the wrap, a malicious challenge can steer the brain off-task.
 * Exported for tests.
 */
export function buildKnowledgePrompt(title: string, desc: string): string {
  return (
    `Solve this research/mining challenge and produce a structured reasoning trace.\n\n` +
    wrapUntrusted(`Title: ${title}\n\n${desc}`, 'nook_challenge') + '\n\n' +
    `Respond in markdown with sections: ## Approach, ## Steps, ## Conclusion, ## Uncertainty, ## Citations.`
  )
}

// Knowledge solver = the user's chosen brain (provider+model via gateway BYOK),
// same one the autonomous agent uses. Without this, the runtime's default solver
// calls economy.inference with no provider → gateway 400 "provider must be one of…".
async function solveKnowledge(challenge: Record<string, unknown>): Promise<string> {
  const title = String(challenge.title ?? '')
  const desc = String(challenge.description ?? '')
  return brainComplete(buildKnowledgePrompt(title, desc))
}

export interface NookTrackStat {
  track: string
  openCount: number
  avgRewardNook: number
  successRate: number
}
export interface NookMiningChallengeView {
  id: string
  track: string
  title: string
  description: string
  difficulty: string
  domainTags: string[]
  rewardNook: string
  submissionCount: number
  maxSubmissions: number
  closesAt: string
}
export interface NookMiningRewardsView {
  pendingNook: number | null
  claimableNook: number | null
  epoch: number | null
}
export interface NookMiningStats {
  running: boolean
  ticks: number
  attempted: number
  submitted: number
  skipped: number
  errors: number
  creditsSpent: number
}

// connection.request is public on the runtime; these reads are public (no key needed).
async function gw<T = unknown>(path: string): Promise<T> {
  return await (rt().connection as { request<R>(m: string, p: string): Promise<R> }).request<T>('GET', path)
}

export async function getTrackStats(): Promise<NookTrackStat[]> {
  try {
    const res = await gw<{ tracks?: Record<string, unknown>[] }>(
      '/v1/mining/earnings-preview?capabilities=knowledge,embedding,rlm',
    )
    return (res.tracks ?? []).map((t) => ({
      track: String(t.track ?? t.capability ?? ''),
      openCount: Number(t.openCount ?? t.open ?? 0),
      avgRewardNook: Number(t.avgRewardNook ?? 0),
      successRate: Number(t.successRate ?? 0),
    }))
  } catch { return [] }
}

function trackOf(sourceType: string): string {
  if (sourceType === 'rlm_trajectory' || sourceType === 'rlm_audit') return 'rlm'
  if (sourceType === 'embedding_generation') return 'embedding'
  return 'knowledge'
}

export async function listChallenges(opts?: { limit?: number }): Promise<NookMiningChallengeView[]> {
  const limit = opts?.limit ?? 25
  const res = await gw<{ challenges?: Record<string, unknown>[] }>(
    `/v1/mining/challenges?status=open&limit=${limit}`,
  )
  return (res.challenges ?? []).map((c) => ({
    id: String(c.id ?? ''),
    track: trackOf(String(c.sourceType ?? '')),
    title: String(c.title ?? '(untitled)'),
    description: String(c.description ?? ''),
    difficulty: String(c.difficulty ?? 'medium'),
    domainTags: Array.isArray(c.domainTags) ? (c.domainTags as string[]) : [],
    rewardNook: String(c.baseReward ?? '0'),
    submissionCount: Number(c.submissionCount ?? 0),
    maxSubmissions: Number(c.maxSubmissions ?? 0),
    closesAt: String(c.closesAt ?? ''),
  }))
}

export async function getRewards(): Promise<NookMiningRewardsView> {
  const e = rt().economy as unknown as Record<string, unknown> & {
    getWeeklyRewardInfo?: () => Promise<unknown>
    getMerkleClaimable?: () => Promise<unknown>
  }
  let epoch: number | null = null
  let pendingNook: number | null = null
  let claimableNook: number | null = null
  try {
    const info = await e.getWeeklyRewardInfo?.() as Record<string, unknown> | undefined
    if (info) { epoch = Number(info.epoch ?? info.currentEpoch ?? 0) || null; pendingNook = Number(info.pending ?? info.estimatedReward ?? 0) || null }
  } catch { /* ignore */ }
  try {
    const m = await e.getMerkleClaimable?.() as Record<string, unknown> | undefined
    if (m) claimableNook = Number(m.nook ?? m.claimable ?? 0) || null
  } catch { /* ignore */ }
  return { pendingNook, claimableNook, epoch }
}

// ── Actions (knowledge solver consumes inference credits) ─────────────────────

let session: { stop: () => Promise<void>; stats: () => unknown } | null = null

export async function solveOnce(): Promise<NookMiningStats & { detail?: string }> {
  const res = await (rt().mining as { runOnce: (o: unknown) => Promise<unknown[]> }).runOnce({ tracks: ['knowledge'], explain: true, solveKnowledge })
  const arr = (Array.isArray(res) ? res : []) as { status?: string; reason?: string; challengeId?: string }[]
  const submitted = arr.filter((r) => r.status === 'submitted').length
  const errors = arr.filter((r) => r.status === 'error').length
  // Surface WHY nothing was submitted (TrackResult.reason explains skip/error).
  const firstIssue = arr.find((r) => r.status === 'error') ?? arr.find((r) => r.status === 'skipped')
  const detail = firstIssue?.reason
    ?? (arr.length === 0 ? 'No open knowledge challenges matched right now.' : undefined)
  return { running: false, ticks: 1, attempted: arr.length, submitted, skipped: arr.length - submitted - errors, errors, creditsSpent: 0, detail }
}

export async function startLoop(opts?: { maxCredits?: number }): Promise<{ running: boolean }> {
  if (session) return { running: true }
  session = await (rt().mining as { start: (o: unknown) => Promise<{ stop: () => Promise<void>; stats: () => unknown }> }).start({
    tracks: ['knowledge'],
    maxCredits: opts?.maxCredits ?? 2000,
    tickIntervalMs: 120_000,
    solveKnowledge,
  })
  return { running: true }
}

export async function stopLoop(): Promise<{ running: boolean }> {
  if (session) { try { await session.stop() } catch { /* ignore */ } session = null }
  return { running: false }
}

export function miningStats(): NookMiningStats {
  const raw = (session?.stats?.() ?? (rt().mining as { stats: () => unknown }).stats()) as Record<string, unknown> | null
  return {
    running: session != null,
    ticks: Number(raw?.ticks ?? 0),
    attempted: Number(raw?.attempted ?? 0),
    submitted: Number(raw?.submitted ?? 0),
    skipped: Number(raw?.skipped ?? 0),
    errors: Number(raw?.errors ?? 0),
    creditsSpent: Number(raw?.creditsSpent ?? 0),
  }
}
