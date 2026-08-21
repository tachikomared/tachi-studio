// packages/core/src/tachi/model-profiles.ts
//
// Model-tier BEHAVIOR profiles (STEAL 2026-07-07, ZSeven/openpencil
// model-profiles.ts): the app calls a zoo of heterogeneous models — frontier,
// cheap/small, and reasoning-class — with one treatment today. This module maps
// a model id onto how to TREAT it:
//
//   tier              full | standard | basic — how much prompt contract it can
//                     carry (basic ⇒ prefer a simplified contract)
//   reasoning         thinking-class model (R1/QwQ/o-series): thinks silently
//                     server-side, so streams can show ZERO bytes for minutes
//   timeoutMultiplier multiply stream-idle/request timeouts — without this the
//                     120s idle watchdog kills reasoning models mid-think
//   simplifiedPrompt  advisory flag for prompt builders (design/nodes/harness):
//                     small models drown in the full contract
//
// COMPLEMENTARY to ./models.ts resolveCapability, which answers what a model
// CAN do (context window, tool protocol, edit format). This answers how to
// treat it. Distinct from the surplus-router difficulty tiers too — those pick
// a model FOR a task; this adjusts behavior for a model already picked.
//
// Matching: ordered first-match rules (most specific first), then a
// parameter-size heuristic ("…-7b" ⇒ small), then a conservative default.
// Pure + dependency-free.

export type ModelTier = 'full' | 'standard' | 'basic'

export interface ModelProfile {
  tier: ModelTier
  reasoning: boolean
  timeoutMultiplier: number
  simplifiedPrompt: boolean
}

const FULL: ModelProfile      = { tier: 'full',     reasoning: false, timeoutMultiplier: 1, simplifiedPrompt: false }
const STANDARD: ModelProfile  = { tier: 'standard', reasoning: false, timeoutMultiplier: 1, simplifiedPrompt: false }
const BASIC: ModelProfile     = { tier: 'basic',    reasoning: false, timeoutMultiplier: 1, simplifiedPrompt: true }
const REASONING: ModelProfile = { tier: 'full',     reasoning: true,  timeoutMultiplier: 3, simplifiedPrompt: false }

/**
 * Ordered rules — FIRST match wins, so reasoning ids that also contain a size
 * or "mini" marker (deepseek-r1-distill-qwen-7b, o3-mini) resolve as reasoning.
 */
const RULES: Array<{ pattern: RegExp; profile: ModelProfile }> = [
  // Reasoning / thinking-class: silent server-side thinking, long TTFT.
  {
    pattern: /\b(deepseek[-_.]?r1|qwq|o[134](?:-mini|-pro|-preview)?|gpt-5(?:\.\d+)?-thinking|reasoner|think(?:ing)?)\b/i,
    profile: REASONING,
  },
  // Small / cheap — simplified contract. BEFORE frontier so "gpt-5-mini" /
  // "gemini-3-flash" resolve by their cheap-tier marker, not the family name.
  {
    pattern: /\b(haiku|flash|mini|nano|micro|lite|tiny|small|gemma|phi-\d)\b/i,
    profile: BASIC,
  },
  // Frontier — carries the full prompt contract. (Fable/Mythos = Claude 5 tier,
  // above Opus.)
  {
    pattern: /\b(fable|mythos|opus|sonnet|gpt-5(?:\.\d+)?|gemini-\d+(?:\.\d+)?-pro|grok-\d|deepseek-v\d|qwen[-_.]?max|mistral-large|command-a|kimi-k\d)\b/i,
    profile: FULL,
  },
]

/** "…-7b" / "llama-3.1-8b-instruct" — parameter count in billions. */
const PARAM_SIZE_RE = /(?:^|[-_./ ])(\d{1,3})b\b/i

/**
 * Resolve how to treat a model id. Unknown/empty ids get the conservative
 * standard profile (no adjustments) — never a downgrade on a guess.
 */
export function resolveModelProfile(modelId: string | null | undefined): ModelProfile {
  const id = (modelId ?? '').trim()
  if (!id) return STANDARD
  for (const rule of RULES) {
    if (rule.pattern.test(id)) return rule.profile
  }
  const m = id.match(PARAM_SIZE_RE)
  if (m) {
    const sizeB = Number.parseInt(m[1], 10)
    if (sizeB <= 14) return BASIC
    if (sizeB >= 65) return FULL
  }
  return STANDARD
}

/**
 * The stream-idle timeout for a model: base × the profile's multiplier.
 * Reasoning models get 3× so the idle watchdog doesn't kill them mid-think.
 */
export function profiledIdleMs(modelId: string | null | undefined, baseMs: number): number {
  return Math.round(baseMs * resolveModelProfile(modelId).timeoutMultiplier)
}
