// apps/desktop/electron/services/surplus-elo.ts
//
// Online incremental Elo / Bradley-Terry global model ranking, layered over the
// surplus-router bandit as a COLD-START-SAFE late prior.
//
// STEAL: .research-tmp/repos/LLMRouter elorouter/trainer.py compute_elo_mle —
// pairwise win/loss battles fit to Elo via logistic-regression MLE (the
// Bradley-Terry model: P(a beats b) = 1 / (1 + 10^((Rb-Ra)/400))). That trainer
// is BATCH (it needs the whole `routing_data_train` frame and sklearn). We record
// outcomes ONE AT A TIME as chats stream, so a batch MLE is the wrong shape.
//
// Adaptation — standard ONLINE Elo against a fixed CATEGORY BASELINE:
//   - We never observe a head-to-head battle between two concrete models; we only
//     observe "model M produced a good (or bad) answer for a request in bucket B".
//   - So the "opponent" for each single outcome is a fixed baseline rating
//     (ELO_DEFAULT, the same value every unseen model starts at). Beating the
//     baseline = a model that consistently delivers in its bucket drifts above
//     1500; failing drifts it below. This is the well-known online-Elo-vs-fixed-
//     anchor scheme (used for solo skill ratings against a constant reference);
//     it preserves the Bradley-Terry expectation/symmetry of the batch trainer
//     while being recordable incrementally and read in O(1).
//   - Update: R += K * (score - expected), score ∈ {1 win, 0 loss},
//     expected = eloExpected(R, baseline). K is bounded so a single outcome can
//     never swing the rating more than K points.
//
// Ratings are per (categoryBucket, modelId) — the same bucket the router's
// bandit uses (`${category}:${tier}`), so Elo is a per-bucket global preference,
// not a single global number that mixes code-TOP with general-SIMPLE.
//
// This store is INDEPENDENT of surplus-router-state.ts (its own file, no import).
// The class is electron-free (path + clock injected) for vitest; the singleton
// accessor does the lazy `require('electron')` so vitest can import the module —
// mirroring CostLedger / the dynamic-import convention in tachi/loop.ts.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Every unseen (bucket, model) starts here — also the fixed Elo "opponent". */
export const ELO_DEFAULT = 1500

/** Logistic scale (Elo's classic 400) + base (10). Matches the trainer's SCALE/BASE. */
const ELO_SCALE = 400

/**
 * K-factor: the MAX points one outcome can move a rating (at the extreme of a
 * fully unexpected result). Deliberately small — Elo here is a LATE tiebreaker,
 * not a primary signal, and we want many consistent outcomes (not one lucky
 * stream) before it overrides the bandit/pattern order. Bounds each |ΔR| ≤ K.
 */
const ELO_K = 16

/**
 * Bradley-Terry expected score for a rating `r` facing `opponent`:
 *   E = 1 / (1 + 10^((opponent - r) / 400))
 * Equal ratings → 0.5; the two sides' expectations sum to 1 (symmetry). This is
 * exactly the win-probability the trainer's logistic-regression MLE estimates,
 * evaluated pointwise for the online update.
 */
export function eloExpected(r: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - r) / ELO_SCALE))
}

// Reserved meta-key in the persisted JSON for the last-write timestamp. The `|`
// makes it impossible to collide with a real `${bucket}|${modelId}` rating key
// (a bucket is `category:tier`, never empty), so load() can skip it cleanly.
const TS_KEY = '|updatedAt'

export class SurplusEloStore {
  // key = `${bucket}|${modelId}` → current Elo rating.
  private ratings = new Map<string, number>()
  private loaded = false
  /** Epoch ms of the last recorded outcome (0 = never written). Persisted. */
  private updatedAt = 0

  constructor(
    private filePath: string,
    private now: () => number = Date.now,  // injected so tests can pin the write timestamp
  ) {}

  private key(bucket: string, modelId: string): string {
    return `${bucket}|${modelId}`
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    try {
      const j = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      if (j && typeof j === 'object') {
        for (const [k, v] of Object.entries(j)) {
          if (typeof v !== 'number' || !Number.isFinite(v)) continue
          if (k === TS_KEY) { this.updatedAt = v; continue }
          this.ratings.set(k, v)
        }
      }
    } catch { /* missing/corrupt file → start fresh; recording still works */ }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // Atomic-ish: write to a temp sibling then rename over the target so a
      // crash mid-write can never leave a half-written (corrupt) ratings file.
      const tmp = `${this.filePath}.tmp`
      const out: Record<string, number> = { ...Object.fromEntries(this.ratings), [TS_KEY]: this.updatedAt }
      writeFileSync(tmp, JSON.stringify(out), 'utf8')
      renameSync(tmp, this.filePath)
    } catch { /* persistence best-effort; in-memory ratings still drive routing */ }
  }

  /** Epoch ms of the most recent recorded outcome (0 = never). */
  lastUpdatedAt(): number {
    this.load()
    return this.updatedAt
  }

  /** Current Elo for a (bucket, model); ELO_DEFAULT (1500) if never recorded. */
  getElo(bucket: string, modelId: string): number {
    this.load()
    return this.ratings.get(this.key(bucket, modelId)) ?? ELO_DEFAULT
  }

  /**
   * Record one outcome for a model in a bucket and update its Elo online against
   * the fixed baseline. `won` = the stream produced a good answer (true) or a
   * quality failure (false). 429s / rate limits should NOT be recorded (a busy
   * provider is not a bad model — same hygiene as the bandit's recordOutcome).
   */
  recordOutcome(bucket: string, modelId: string, won: boolean): void {
    if (!bucket || !modelId) return
    this.load()
    const k = this.key(bucket, modelId)
    const r = this.ratings.get(k) ?? ELO_DEFAULT
    const expected = eloExpected(r, ELO_DEFAULT)
    const score = won ? 1 : 0
    this.ratings.set(k, r + ELO_K * (score - expected))
    this.updatedAt = this.now()
    this.persist()
  }

  /**
   * modelIds sorted by Elo DESC (highest-rated first). Stable: equal ratings
   * keep their input order, so this is a pure tiebreaker that never reorders
   * models the caller already considers equivalent. Does not mutate the input.
   */
  eloRank(bucket: string, modelIds: string[]): string[] {
    this.load()
    return modelIds
      .map((id, i) => ({ id, i, elo: this.getElo(bucket, id) }))
      .sort((a, b) => (b.elo - a.elo) || (a.i - b.i))
      .map(x => x.id)
  }
}

let singleton: SurplusEloStore | null = null

/** Electron-coupled accessor — lazy require so vitest can import this module. */
export function getSurplusEloStore(): SurplusEloStore {
  if (!singleton) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('node:path') as typeof import('node:path')
    singleton = new SurplusEloStore(join(app.getPath('userData'), 'surplus-elo.json'))
  }
  return singleton
}
