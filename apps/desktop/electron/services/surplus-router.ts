// apps/desktop/electron/services/surplus-router.ts
//
// Surplus Smart Router — a local, zero-LLM, sub-millisecond classifier that maps
// a request to a difficulty TIER + a task CATEGORY, then to a concrete Surplus
// model id resolved against the LIVE catalog. PURE (no IO): callers pass the
// catalog ids in (and optionally runtime signals), so the whole module stays
// deterministic and unit-testable.
//
// Design + rationale: notes/SURPLUS-SMART-ROUTER-DESIGN.md  (+ audit in
// notes/SURPLUS-SMART-ROUTER-AUDIT.md)
//
// What it routes on:
//   - DIFFICULTY (SIMPLE / MID / TOP) from a weighted keyword/structural score.
//   - TASK CATEGORY (general / reasoning / code / vision) so the right KIND of
//     model is picked: math/proof → REASONING (deepseek-r1, aion); code/tool →
//     tool-reliable AGENTIC (difficulty-tiered); image input → VISION; else a
//     general flagship.
//   - LANGUAGE: signals across ~10 languages (EN, RU, ZH, ES, PT, FR, DE, JA, KO,
//     AR, HI) so a hard non-English prompt is not mis-classified as trivial.
//   - HIGH-STAKES topics (medical/legal/financial/safety questions → TOP).
//   - MOMENTUM: a terse follow-up blends recent-turn tiers (length-graded) rather
//     than hard-overwriting, so it never clobbers a strong fresh signal.
//
// Runtime signals (cooldown after errors, reliability) are INJECTED via opts so
// this module stays pure; the caller (chat-service) owns the stateful store.
//
// Patterns adapted (all MIT): manifest (config-as-code scorer + sigmoid gate +
// length-graded momentum + categories), bankr-router/ClawRouter (tier sets +
// capability/cooldown fallback chain), ruflo (force-to-top override), cascadeflow
// (high-stakes direct-to-best), LiteLLM (per-error cooldown, typed fallbacks).

// ── Public contract ───────────────────────────────────────────────────────────

export type SurplusTier = 'SIMPLE' | 'MID' | 'TOP'
export type SurplusCategory = 'general' | 'reasoning' | 'code' | 'vision'
export type SurplusModelSet =
  | 'SIMPLE' | 'MID' | 'TOP' | 'REASONING' | 'AGENTIC' | 'AGENTIC_LIGHT' | 'AGENTIC_TOP' | 'VISION'

export interface SurplusRouteInput {
  /** The latest user message (plain text) — the primary scoring surface. */
  message: string
  /** The system prompt, if any (scored lightly, folded into the message text). */
  system?: string
  /** True when the request carries tools / is an agentic (Code) session. */
  tools?: boolean
  /** True when the request includes an image (route to a vision-capable model). */
  hasImage?: boolean
  /** Recent turns' tiers (newest last) — length-graded momentum for short follow-ups. */
  recentTiers?: SurplusTier[]
  /** Deprecated single-tier momentum; folded into recentTiers if present. */
  prevTier?: SurplusTier
  /** Opt-out of the high-stakes (medical/legal/financial) → TOP safety override. */
  disableHighStakes?: boolean
}

/** Difficulty-boundary overrides (score cutoffs). Tunable from the chat UI. */
export interface SurplusBoundaries {
  /** Scores below this are SIMPLE. Default 0.05. */
  simpleMax?: number
  /** Scores below this (and >= simpleMax) are MID; above are TOP. Default 0.35. */
  midMax?: number
}

/** Runtime signals injected by the caller (keeps this module pure). */
export interface SurplusRouteOpts {
  /** Model ids in cooldown after a recent failure — pushed to the END of the chain (not dropped). */
  cooledDown?: Set<string>
  /** Per-id reliability 0..1 (1 = perfect). Lower-reliability ids sink in the chain. */
  reliability?: (id: string) => number
  /**
   * Per-provider tier→model-pattern map override. Defaults to SURPLUS_TIERS
   * (tuned to the Surplus catalog; also fine for Bankr since the families
   * overlap). Pass BANKR_TIERS / VENICE_TIERS to route correctly against those
   * catalogs — Venice especially, whose OSS-only catalog has no cheap
   * claude/gpt/gemini models, so the default map would never pick a SIMPLE tier.
   */
  tierMap?: Record<SurplusModelSet, string[]>
  /**
   * C1 bandit: Beta(α,β) outcome arm for a (bucket, modelId) pair, undefined
   * before any outcome. When provided, the chain is re-ranked by posterior
   * mean blended with a position prior — see the bandit stage in routeSurplus.
   */
  banditArm?: (bucket: string, modelId: string) => { a: number; b: number } | undefined
  /** Difficulty-boundary overrides (user-tunable; defaults B_SIMPLE_MAX/B_MID_MAX). */
  boundaries?: SurplusBoundaries
  /**
   * Per-id latency stability score (0..100, higher = more consistent; -1 = no
   * data). A LATE tiebreaker: ids scoring below STABILITY_SPIKY_THRESHOLD are
   * sunk WITHIN their existing tier (never promoted across tiers, never ahead of
   * the cooldown stage). Cold start (-1) and high scores are no-ops, so omitting
   * this leaves the chain order untouched.
   */
  stability?: (id: string) => number
  /**
   * Elo / Bradley-Terry global model ranking — a COLD-START-SAFE late PRIOR for
   * the bucket. Given the bucket key and the current within-tier candidate ids,
   * return them sorted by Elo DESC (a stable sort: equal ratings keep input
   * order). It runs as the WEAKEST re-ordering stage (a prior), so every
   * stronger signal — bandit, reliability, stability, cooldown — composes on top
   * and overrides it; it only decides order among ids those stages left equal.
   * Inert unless provided, so it never changes existing routing. See
   * surplus-elo.ts (SurplusEloStore.eloRank).
   */
  eloRank?: (bucket: string, modelIds: string[]) => string[]
}

/** Stability scores at/below this are "spiky" — deprioritized within their tier. */
export const STABILITY_SPIKY_THRESHOLD = 40

export interface SurplusRouteDecision {
  tier: SurplusTier
  category: SurplusCategory
  /** Which model-set was actually used. */
  modelSet: SurplusModelSet
  /** Chosen model id (first set-candidate present in the catalog, post runtime sort). */
  primary: string
  /** Ordered failover chain (primary first) of catalog-present ids. */
  chain: string[]
  /** Human-readable why (for an explainability chip / dev log). */
  reasoning: string
  /** 0..1 classifier confidence (sigmoid of distance from the nearest boundary). */
  confidence: number
  /** Continuous difficulty score, roughly [-0.3 .. 1.0]. */
  score: number
  /** Agentic / tool signal, 0..1. */
  agenticScore: number
  /** True iff genuinely hard AND multi-step/agentic — caller still gates on a flag. */
  workflowEligible: boolean
  /** Stable bucket key for outcome telemetry / future bandit tuning. */
  bucket: string
}

/** Universal default — runnable across the catalog, used as the last-resort id. */
export const DEFAULT_SURPLUS_MODEL = 'claude-sonnet-4.5'

// ── Tier → model map (the ENTIRE tunable policy) ──────────────────────────────
//
// Ordered id-SUBSTRING patterns (lowercase). Each pattern is matched against the
// live catalog; among matches the NEWEST (highest version) wins, and the ordered
// survivors become the failover chain. Tuned to the live 177-model Surplus catalog.
export const SURPLUS_TIERS: Record<SurplusModelSet, string[]> = {
  SIMPLE:        ['haiku', 'mini', 'nano', 'flash', 'lite', 'gemma', 'nemotron-3-nano', 'mistral-small', 'qwen3-30b', 'qwen3-5-9b', 'llama-3.2', 'grok-4.1-fast', 'glm-5-turbo', 'gpt-oss-20b'],
  MID:           ['claude-sonnet', 'gemini-2.5-pro', 'gpt-5.2', 'glm-4.7', 'deepseek-v3.2', 'mistral-large', 'minimax-m2.5'],
  TOP:           ['claude-opus', 'gpt-5.5', 'gpt-5.4', 'gemini-3.1-pro', 'grok-4.3', 'glm-5', 'deepseek-v4-pro'],
  REASONING:     ['deepseek-r1', 'aion', 'kimi-k2-thinking', 'qwen3-235b-a22b-thinking', 'trinity-large-thinking', 'glm-5', 'claude-opus', 'gpt-5.5', 'grok-4.3'],
  AGENTIC_LIGHT: ['qwen3-coder', 'gpt-5.4-mini', 'claude-haiku', 'gpt-5-mini', 'glm-4.7-flash'],
  AGENTIC:       ['claude-sonnet', 'codex', 'qwen3-coder', 'gpt-5.4', 'deepseek-v4-pro'],
  AGENTIC_TOP:   ['claude-opus', 'gpt-5.5', 'claude-sonnet', 'codex'],
  // VISION = multimodal/image-input capable, quality-first.
  VISION:        ['claude-opus', 'claude-sonnet', 'gemini-3.1-pro', 'gemini-2.5-pro', 'gpt-5.4', 'gpt-4o', 'qwen3-vl'],
}

// ── Per-provider tier overrides ───────────────────────────────────────────────
//
// The classifier is provider-agnostic; only the tier→model patterns differ per
// catalog. These are matched as id-substrings against the LIVE catalog (newest
// version per pattern wins), with the same walk-down + final-fallback safety as
// SURPLUS_TIERS, so an absent family never breaks routing — it just walks down.

// Bankr LLM Gateway: Claude (opus/sonnet/haiku) · Gemini 3 (pro/flash) · GPT-5.x
// · Llama. Tuned to bankr-service.ts's catalog (e.g. `gemini-3-pro`, not the
// Surplus map's `gemini-3.1-pro`; `gemini-3-flash` is the cheap tier).
// REFRESHED 2026-08-03 against the LIVE 57-model Bankr catalog. The previous
// list had rotted quietly: `gemini-3-pro` (in four of the eight sets),
// `deepseek-r1`, `o3`, `o4`, `llama-3.2`, `llama-3.3-70b` and `gpt-5-mid`
// matched NOTHING the gateway serves. A dead pattern is not an error — it is
// skipped — so each one silently shortened the fallback chain it was in, and
// REASONING was left with two live entries out of six. Meanwhile the catalog
// had grown a whole generation the router could not reach: gpt-5.6 luna/sol/
// terra, gemini-3.6/3.5, grok-4.5, glm-5.1/5.2, qwen3.7, kimi-k3, minimax-m3.
// `routerTierCoverage.test.ts` now fails if this drifts again.
export const BANKR_TIERS: Record<SurplusModelSet, string[]> = {
  SIMPLE:        ['haiku', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gpt-5-nano', 'gpt-5-mini', 'glm-5-turbo', 'flash'],
  MID:           ['claude-sonnet', 'gpt-5.4', 'glm-5.1', 'minimax-m2.7', 'gemini-3.1-pro', 'deepseek-v3.2'],
  TOP:           ['claude-opus', 'gpt-5.6-sol', 'gpt-5.5', 'grok-4.5', 'gemini-3.1-pro', 'glm-5.2', 'kimi-k3', 'deepseek-v4-pro'],
  REASONING:     ['claude-opus', 'gpt-5.6-terra', 'gpt-5.5', 'glm-5.2', 'kimi-k3', 'deepseek-v4-pro', 'minimax-m3'],
  AGENTIC_LIGHT: ['claude-haiku', 'gpt-5-mini', 'gpt-5.4-mini', 'gemini-3.5-flash', 'glm-5-turbo'],
  AGENTIC:       ['claude-sonnet', 'gpt-5.2-codex', 'gpt-5.4', 'kimi-k2.7-code', 'qwen3-coder', 'glm-5.1'],
  AGENTIC_TOP:   ['claude-opus', 'gpt-5.5', 'claude-sonnet', 'gpt-5.2-codex', 'kimi-k3'],
  VISION:        ['claude-opus', 'claude-sonnet', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gpt-5.4', 'gemma-4-31b'],
}

// Venice: privacy-first OSS catalog — GLM (4.x/5) · Qwen (2.5-vl / 3-235b-thinking
// / 3-coder / 3-next) · Mistral (small / 31-24b / large) · Llama 3.x · DeepSeek
// (v3 / v4 / r1) · Kimi · GPT-OSS · venice-uncensored. No cheap claude/gpt here,
// so SIMPLE targets the small OSS models; REASONING targets `*-thinking` / r1.
// REFRESHED 2026-08-03 against the LIVE 106-model Venice catalog. Fourteen
// patterns matched nothing: `qwen3-4b`, `ministral`, `qwen-2.5-7b`,
// `venice-small`, `mistral-31`, `qwen-2.5`, `deepseek-r1`, `qwq`, `devstral`,
// `codestral`, `qwen-2.5-vl`, `qwen2.5-vl`, `mistral-31-24b`, `vision` — and
// FOUR of those six dead ones were in VISION, so an image on Venice was routed
// by a two-entry chain pretending to be six.
//
// Patterns here name their VERSION on purpose (`claude-opus-5`, not
// `claude-opus`): Venice spells versions with dashes, so versionScore reads
// `claude-opus-4-8` as 8 and would rank it above `claude-opus-5`. See the note
// on versionScore.
export const VENICE_TIERS: Record<SurplusModelSet, string[]> = {
  SIMPLE:        ['llama-3.2-3b', 'qwen3-5-9b', 'glm-5-turbo', 'gemini-3-5-flash-lite', 'gemma-3-27b', 'mistral-small'],
  MID:           ['glm-4.7', 'llama-3.3-70b', 'qwen3-next-80b', 'deepseek-v3.2', 'minimax-m25', 'qwen3-6-27b'],
  TOP:           ['claude-opus-5', 'deepseek-v4-pro', 'glm-5-2', 'qwen-3-7-max', 'kimi-k3', 'grok-4-5', 'gpt-55'],
  REASONING:     ['qwen3-235b-a22b-thinking', 'aion-3-0', 'deepseek-v4-pro', 'glm-5-2', 'claude-opus-5', 'gpt-56-terra'],
  AGENTIC_LIGHT: ['glm-4.7-flash', 'qwen3-6-35b-a3b', 'glm-5-turbo', 'mistral-small'],
  AGENTIC:       ['qwen3-coder', 'kimi-k2-7-code', 'gpt-52-codex', 'deepseek-v4-pro', 'claude-sonnet-5'],
  AGENTIC_TOP:   ['claude-opus-5', 'gpt-53-codex', 'deepseek-v4-pro', 'kimi-k3', 'qwen3-coder'],
  VISION:        ['qwen3-vl', 'glm-5v-turbo', 'claude-opus-5', 'gemini-3-1-pro', 'gemma-4-31b'],
}

// NEW 2026-08-03. imgnAI Katana's chat branch shipped with the comment "no
// smart routing / fusion yet — glm-5-2 default", so every request on that
// provider ran one hard-coded model whatever it was. Its catalog is 56 text
// models and it spells versions with dashes and no dots at all
// (`gpt-5-6-sol`, `claude-opus-4-8`, `qwen3-7-max`), which is a THIRD spelling
// convention — hence its own map rather than reuse of Bankr's.
export const IMGNAI_TIERS: Record<SurplusModelSet, string[]> = {
  SIMPLE:        ['claude-haiku', 'gemini-3-5-flash', 'gpt-5-4-mini', 'glm-5-turbo', 'qwen3-6-flash', 'gemma-4-26b'],
  MID:           ['claude-sonnet-4-6', 'gpt-5-4', 'glm-5-1', 'minimax-m2-7', 'gemini-3-1-pro', 'qwen3-6-plus'],
  TOP:           ['claude-opus-4-8', 'gpt-5-6-sol', 'gpt-5-5', 'grok-4-5', 'glm-5-2', 'kimi-k3', 'qwen3-7-max', 'deepseek-v4-pro'],
  REASONING:     ['gpt-5-6-terra', 'claude-opus-4-8', 'glm-5-2', 'kimi-k3', 'deepseek-v4-pro', 'qwen3-6-max-preview'],
  AGENTIC_LIGHT: ['claude-haiku', 'gpt-5-4-mini', 'glm-5-turbo', 'qwen3-6-flash'],
  AGENTIC:       ['claude-sonnet-4-6', 'qwen3-coder-next', 'gpt-5-4', 'glm-5-1', 'deepseek-v4-pro'],
  AGENTIC_TOP:   ['claude-opus-4-8', 'gpt-5-5', 'claude-sonnet-4-6', 'kimi-k3', 'qwen3-coder'],
  VISION:        ['qwen3-vl', 'claude-opus-4-8', 'claude-sonnet-4-6', 'gemini-3-1-pro', 'gemma-4-31b'],
}

// ── Scoring config (config-as-code) ───────────────────────────────────────────

const RE = {
  // Code: a REAL fenced block (lang tag or ≥20-char body), code keywords, language
  // names, OR a file path. Bare inline ``` is NOT enough (avoids JSON tool-envelope
  // false positives on the agentic path — manifest #1767).
  codeFence: /```[a-z0-9+#-]*\s*\n[\s\S]{20,}/i,
  code:      /\bfunction\b|\bclass\b|\bdef\b|=>|\bimport\b|\basync\b|stack ?trace|traceback|diff --git|\bregex\b|\bAPI\b|\bSQL\b|\b(python|javascript|typescript|golang|rust|c\+\+|kotlin|swift|php|ruby|react|node\.?js|html|css)\b|\b(method|script|snippet|endpoint|compile|debug|binary search)\b|write (a |the )?(function|code|script|program|method)/i,
  filePath:  /(\b[\w@./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cpp|cc|h|hpp|cs|sql|sh|bash|json|ya?ml|toml|md|css|scss|html|vue|svelte)\b|(^|\s)(src|lib|app|packages|apps|components|pages)\/[\w./-]+|(^|\s)\.\/[\w./-]+)/i,
  reasoning: /\b(prove|derive|why|trade-?offs?|root cause|step[- ]by[- ]step|reason through|analy[sz]e|in detail|architect|design (a|the|an)|compare and contrast|evaluate|justify)\b/gi,
  proof:     /\b(prove|theorem|proof|lemma|derive|derivative|integral|equation|probability|matrix|eigen|calculus|algebra|geometry)\b/i,
  multiStep: /(first[\s\S]{0,40}then|step\s*\d|^\s*\d+[.)]\s|\bthen\b[\s\S]{0,40}\bfinally\b|after that)/im,
  technical: /\b(algorithm|concurren\w*|distributed|schema|latency|complexit\w*|optimi[sz]e|throughput|race condition|big[- ]?o|scalab\w*|cryptograph\w*|kubernetes|database index)\b/gi,
  agentic:   /\b(read (the )?file|edit (the )?file|run (the )?(command|tests?|build)|npm|pnpm|deploy|iterate|verify|refactor|implement|build (the|a|an)|fix (the )?bug|search the repo|create (a|the) file|commit)\b/gi,
  simple:    /\b(what is|who is|where is|when (is|was)|define|tl;?dr|summari[sz]e|translate|rename|fix (a )?typo|hello|hi|hey|thanks|thank you|good morning)\b/i,
  constraint:/\b(must|ensure|only|exactly|without|constraints?|require[ds]?|do not|don'?t|never|always)\b/gi,
  forceTop:  /\b(use opus|highest quality|best model|think hard(er)?|ultra ?think|deep(ly)? (think|reason)|most capable)\b/i,
  // High-stakes: factual domains where a wrong cheap answer is harmful.
  highStakes:/\b(medical|medicine|diagnos\w*|symptom|disease|dosage|prescription|legal|lawsuit|contract|liability|\btax(es|ation)?\b|invest(ing|ment)?|financial advice|securities|suicide|self[- ]harm|overdose)\b/i,
}

// Multilingual signal sets (RU, ZH, ES, PT, FR, DE, JA, KO, AR, HI). No \b.
const RE_ML = {
  reasoning: /(почему|пошагов|по шагам|подробно|в деталях|проанализир|сравни|обоснуй|рассужд|为什么|逐步|详细|分析|比较|论证|推理|por qué|paso a paso|en detalle|analiza|compara|razona|justifica|por que|passo a passo|raciocine|pourquoi|étape par étape|en détail|analyse|compare|raisonne|warum|schritt für schritt|im detail|analysiere|vergleiche|begründe|なぜ|ステップ|詳しく|分析|比較|推論|왜|단계별|자세히|분석|비교|추론|لماذا|خطوة بخطوة|بالتفصيل|حلل|قارن|استنتج|क्यों|चरण दर चरण|विस्तार से|विश्लेषण|तुलना|तर्क)/gi,
  proof:     /(докаж|теорем|выведи|интеграл|производн|уравнен|вероятност|матриц|证明|定理|推导|积分|方程|概率|demuestra|teorema|deduzca|prove|deduza|théorème|démontre|preuve|beweise|satz|herleite|証明|定理|導出|증명|정리|유도|أثبت|نظرية|اشتقاق|सिद्ध|प्रमेय|समीकरण)/i,
  multiStep: /(сначал[оа][\s\S]{0,40}(затем|потом)|шаг\s*\d|по шагам|首先[\s\S]{0,40}然后|第\s*\d+\s*步|步骤\s*\d|primero[\s\S]{0,40}luego|paso\s*\d|primeiro[\s\S]{0,40}depois|passo\s*\d|d'abord[\s\S]{0,40}ensuite|étape\s*\d|zuerst[\s\S]{0,40}dann|schritt\s*\d|まず[\s\S]{0,40}次に|手順\s*\d|먼저[\s\S]{0,40}그다음|단계\s*\d|أولا[\s\S]{0,40}ثم|خطوة\s*\d|पहले[\s\S]{0,40}फिर|चरण\s*\d)/i,
  technical: /(алгоритм|оптимизир|распределённ|распределенн|параллельн|архитектур|сложност|производительн|масштабир|конкурент|算法|优化|分布式|并发|架构|复杂度|性能|可扩展|algoritmo|optimiza|distribuido|concurrencia|arquitectura|complejidad|rendimiento|escalab|otimize|distribuído|concorrência|desempenho|algorithme|optimise|distribué|concurrence|complexité|performance|évolutiv|algorithmus|optimiere|verteilt|nebenläufig|architektur|komplexität|leistung|skalier|アルゴリズム|最適化|分散|並行|アーキテクチャ|計算量|알고리즘|최적화|분산|동시성|아키텍처|복잡도|확장성|خوارزمية|تحسين|موزع|تزامن|معمارية|أداء|एल्गोरिदम|अनुकूलन|वितरित|आर्किटेक्चर|जटिलता)/gi,
  agentic:   /(прочитай|отредактир|запусти|разверни|итерир|реализуй|исправь|создай файл|закоммить|собери|протестир|почини|внедри|读取文件|运行|构建|实现|修复|部署|迭代|测试|提交|lee el archivo|ejecuta|construye|implementa|arregla|despliega|itera|prueba|leia o arquivo|execute|construa|implemente|conserte|implante|lis le fichier|exécute|construis|implémente|corrige|déploie|itère|lies die datei|führe aus|baue|implementiere|behebe|deploye|iteriere|ファイルを読|実行|ビルド|実装|修正|デプロイ|反復|テスト|파일 읽|실행|빌드|구현|수정|배포|반복|테스트|اقرأ الملف|شغل|نفذ|أصلح|انشر|كرر|اختبر|फ़ाइल पढ़|चलाओ|बनाओ|लागू|ठीक करो|तैनात|दोहराओ|परीक्षण)/gi,
  code:      /(код|функци|программ|скрипт|метод|напиши код|реализ\w*\s*функци|代码|函数|程序|脚本|方法|类|código|función|programa|método|função|fonction|méthode|funktion|programm|skript|methode|コード|関数|プログラム|スクリプト|メソッド|코드|함수|프로그램|스크립트|메서드|كود|دالة|برنامج|سكربت|कोड|फ़ंक्शन|प्रोग्राम|स्क्रिप्ट)/i,
  simple:    /(что такое|кто такой|что значит|определи|переведи|кратко|резюмир|привет|здравствуй|спасибо|переименуй|сколько будет|什么是|是谁|定义|翻译|总结|你好|谢谢|重命名|qué es|quién es|define|traduce|resume|hola|gracias|renombra|o que é|quem é|defina|traduza|resuma|olá|obrigado|qu'est-ce|qui est|définis|traduis|résume|bonjour|merci|was ist|wer ist|definiere|übersetze|fasse zusammen|hallo|danke|とは|誰|定義|翻訳|要約|こんにちは|ありがとう|무엇|누구|정의|번역|요약|안녕|감사|ما هو|من هو|عرف|ترجم|لخص|مرحبا|شكرا|क्या है|कौन है|परिभाषित|अनुवाद|सारांश|नमस्ते|धन्यवाद)/i,
  forceTop:  /(используй opus|лучшую модель|думай глубоко|максимально подробно|самую мощную|очень подробно|用最好的模型|最强模型|深入思考|usa el mejor modelo|piensa profundamente|máxima calidad|use o melhor modelo|pense profundamente|utilise le meilleur modèle|réfléchis profondément|benutze das beste modell|denke gründlich|höchste qualität|最高のモデル|深く考え|最高品質|최고의 모델|깊이 생각|최고 품질|استخدم أفضل نموذج|فكر بعمق|सबसे अच्छा मॉडल|गहराई से सोचो)/i,
  highStakes:/(медицин|диагноз|симптом|лечени|дозиров|юридическ|закон|иск|налог|инвестиц|финансов|医疗|诊断|症状|法律|税务|投资|médico|diagnóstico|legal|impuesto|inversión|síntoma|médical|juridique|impôt|investir|symptôme|medizinisch|rechtlich|steuer|investier|symptom|طبي|قانوني|ضريب|استثمار|चिकित्सा|कानूनी|कर|निवेश)/i,
}

function countMatches(re: RegExp, text: string): number {
  if (!re.global) return re.test(text) ? 1 : 0
  const m = text.match(re)
  return m ? m.length : 0
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

const B_SIMPLE_MAX = 0.05
const B_MID_MAX    = 0.35
const WORKFLOW_THRESHOLD = 0.6
const SIGMOID_K = 10
const CONFIDENCE_FLOOR = 0.55
const TIER_BIAS: Record<SurplusTier, number> = { SIMPLE: -0.15, MID: 0.05, TOP: 0.30 }

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

// ── Classifier ────────────────────────────────────────────────────────────────

export interface SurplusClassification {
  tier: SurplusTier
  category: SurplusCategory
  score: number
  confidence: number
  agenticScore: number
  workflowEligible: boolean
  reasoning: string
}

export function classifySurplus(input: SurplusRouteInput, boundaries?: SurplusBoundaries): SurplusClassification {
  const bSimpleMax = boundaries?.simpleMax ?? B_SIMPLE_MAX
  const bMidMax    = boundaries?.midMax    ?? B_MID_MAX
  const message = (input.message ?? '').trim()
  const text = (message + ' ' + (input.system ?? '')).slice(0, 8000)
  const tokenEst = Math.ceil((message.length + (input.system?.length ?? 0)) / 4)

  const fired: string[] = []
  let score = 0
  const add = (label: string, weight: number, raw: number) => {
    if (raw !== 0) { score += weight * raw; fired.push(`${label}${raw > 0 ? '+' : ''}${(weight * raw).toFixed(2)}`) }
  }

  // Code = a real fenced block, code keywords/lang names, a file path, OR a
  // multilingual code term — NOT a bare inline ``` (JSON tool-envelope guard).
  const hasCode = RE.codeFence.test(text) || RE.code.test(text) || RE.filePath.test(text) || RE_ML.code.test(text)
  const reasoningCount = countMatches(RE.reasoning, text) + countMatches(RE_ML.reasoning, text)
  const technicalCount = countMatches(RE.technical, text) + countMatches(RE_ML.technical, text)
  const agenticCount   = countMatches(RE.agentic, text)   + countMatches(RE_ML.agentic, text)
  const constraintCount = countMatches(RE.constraint, text)
  const questionMarks  = (message.match(/\?/g) || []).length
  const hasSimple      = RE.simple.test(message) || RE_ML.simple.test(message)
  const isProof        = RE.proof.test(text) || RE_ML.proof.test(text)
  const isMultiStep    = RE.multiStep.test(text) || RE_ML.multiStep.test(text)
  const isForceTop     = RE.forceTop.test(text) || RE_ML.forceTop.test(text)
  const isHighStakes   = !input.disableHighStakes && (RE.highStakes.test(text) || RE_ML.highStakes.test(text))

  add('code', 0.18, hasCode ? 1 : 0)
  add('reasoning', 0.18, clamp(reasoningCount / 2, 0, 1))
  add('multiStep', 0.14, isMultiStep ? 1 : 0)
  add('technical', 0.10, clamp(technicalCount / 2, 0, 1))
  add('agentic', 0.10, clamp(agenticCount / 2, 0, 1))
  add('length', 0.08, clamp(-1 + (2 * (tokenEst - 50)) / 450, -1, 1))
  add('questions', 0.07, questionMarks > 3 ? 0.5 : (questionMarks <= 1 && message.length < 80 ? -0.3 : 0))
  add('constraints', 0.05, clamp(constraintCount / 3, 0, 1))
  add('simple', 0.10, hasSimple ? -1 : 0)
  if (isProof) add('proof', 0.20, 1)

  let agenticScore = agenticCount >= 3 ? 1 : agenticCount === 2 ? 0.6 : agenticCount === 1 ? 0.3 : 0
  if (input.tools) agenticScore = Math.max(agenticScore, 0.6)

  const why: string[] = []

  // Momentum (manifest-style, length-graded): for SHORT follow-ups blend a fraction
  // of recent-turn tiers into the score; a long fresh prompt ignores history (w→0).
  //
  // STRONG-SIGNAL GUARD: a fresh message that itself fires a categorical signal
  // (code / proof / multi-step / technical / reasoning / agentic) is NOT an
  // ambiguous follow-up — momentum must not clobber it. Live bug this fixes:
  // "write me snake game in html" (27 chars) after a SIMPLE turn scored
  // code+0.18 → MID territory, but momentum w=0.6 dragged it to -0.01 →
  // SIMPLE → AGENTIC_LIGHT → haiku wrote the game. Length alone is the wrong
  // gate; "yes, do it" (no signals) still gets full momentum.
  const strongFresh = hasCode || isProof || isMultiStep || isForceTop
    || reasoningCount >= 1 || technicalCount >= 1 || agenticCount >= 1
  const recent = (input.recentTiers && input.recentTiers.length > 0)
    ? input.recentTiers : (input.prevTier ? [input.prevTier] : [])
  if (recent.length > 0 && !strongFresh) {
    const tail = recent.slice(-5)
    const histBias = tail.reduce((a, t) => a + TIER_BIAS[t], 0) / tail.length
    const len = message.length
    const w = len >= 100 ? 0 : len < 30 ? 0.6 : 0.6 * (1 - (len - 30) / 70)
    if (w > 0) { score += w * histBias; why.push(`momentum w=${w.toFixed(2)}`) }
  } else if (recent.length > 0 && strongFresh) {
    why.push('momentum skipped (strong fresh signal)')
  }

  why.unshift(`score ${score.toFixed(2)}`)

  // Difficulty tier from boundaries (defaults; overridable via opts.boundaries).
  let tier: SurplusTier = score < bSimpleMax ? 'SIMPLE' : score < bMidMax ? 'MID' : 'TOP'
  const dist = Math.min(Math.abs(score - bSimpleMax), Math.abs(score - bMidMax))
  let confidence = sigmoid(SIGMOID_K * dist)

  if (confidence < CONFIDENCE_FLOOR && tier !== 'MID') {
    tier = 'MID'
    why.push(`ambiguous(conf ${confidence.toFixed(2)})→MID`)
  }

  // Task category (KIND of model). proof/heavy-reasoning → reasoning; code wins
  // for coding tasks; an image input → vision (set in routeSurplus via hasImage).
  let category: SurplusCategory = 'general'
  if (isProof || reasoningCount >= 2) category = 'reasoning'
  if (hasCode) category = 'code'

  // Hard overrides (bypass the score).
  if (input.message && (isForceTop || reasoningCount >= 2 || isProof)) {
    tier = 'TOP'; confidence = 0.9
    why.push(isForceTop ? 'explicit "best/opus"→TOP' : isProof ? 'proof/math→TOP' : `${reasoningCount} reasoning markers→TOP`)
  }
  // High-stakes (cascadeflow): a factual medical/legal/financial QUESTION must not
  // land on a cheap model. Force at least MID, and TOP if it's also a real question.
  if (isHighStakes && message.length > 0) {
    category = 'general'
    if (questionMarks >= 1 || /\b(is|are|can|should|how|what|why|когда|можно|нужно|как)\b/i.test(message)) {
      tier = 'TOP'; confidence = Math.max(confidence, 0.85); why.push('high-stakes topic→TOP')
    } else if (tier === 'SIMPLE') {
      tier = 'MID'; why.push('high-stakes topic→MID')
    }
  }
  if (tokenEst > 8000 && tier !== 'TOP') { tier = 'TOP'; why.push('large context→TOP') }

  const workflowEligible = score >= WORKFLOW_THRESHOLD && agenticScore >= 0.6
  const reasoning = `${tier}/${category} (${why.join('; ')}; signals: ${fired.join(' ') || 'none'}; agentic ${agenticScore.toFixed(1)})`
  return { tier, category, score, confidence, agenticScore, workflowEligible, reasoning }
}

// ── Catalog resolution + routing ──────────────────────────────────────────────

const CHEAP_MARKERS = ['mini', 'nano', 'flash', 'lite', 'haiku', 'small', 'turbo', 'fast']

/**
 * Highest trailing version number in an id (claude-opus-4.8 -> 4.8). 0 if none.
 *
 * KNOWN LIMITATION, documented rather than papered over: this is "largest
 * number anywhere in the string", so it is fooled by two real spellings.
 *   · DASH-SEPARATED VERSIONS. Venice writes `claude-opus-4-8`, which scores 8
 *     and therefore beats `claude-opus-5`, which scores 5. Older model, higher
 *     score.
 *   · PARAMETER COUNTS. `gemma-4-26b-a4b-it` scores 26, `qwen3-235b` scores 235.
 *
 * Fixing it properly means parsing a version out of a naming convention that
 * five gateways do not share, so the tier lists work WITH it instead: patterns
 * for dash-spelling catalogs name the version they mean (`claude-opus-5`, not
 * `claude-opus`) and let this function choose only between true equals. The
 * coverage test pins that every pattern still resolves to something.
 */
function versionScore(id: string): number {
  const nums = id.match(/\d+(?:\.\d+)?/g)
  return nums ? Math.max(...nums.map(Number)) : 0
}

/** Resolve ordered id-substring patterns against the catalog (newest version per pattern). */
function resolveChain(patterns: string[], catalogIds: string[], avoidCheap = false): string[] {
  const out: string[] = []
  for (const pat of patterns) {
    const p = pat.toLowerCase()
    const matches = catalogIds.filter(id => {
      const lid = id.toLowerCase()
      if (!lid.includes(p)) return false
      if (avoidCheap && CHEAP_MARKERS.some(m => lid.includes(m))) return false
      return true
    })
    if (matches.length === 0) continue
    const pick = matches.reduce((best, id) => (versionScore(id) > versionScore(best) ? id : best), matches[0]!)
    if (!out.includes(pick)) out.push(pick)
  }
  return out
}

const isCheapSet = (s: SurplusModelSet) => s === 'SIMPLE' || s === 'AGENTIC_LIGHT'

/** Pick the model-set from category + difficulty + tool/vision signal. */
function selectModelSet(c: SurplusClassification, tools: boolean, hasImage: boolean): SurplusModelSet {
  if (hasImage) return 'VISION'                                // image input → multimodal model
  const codeMode = tools || c.category === 'code' || c.agenticScore >= 0.6
  if (codeMode) {
    if (c.tier === 'SIMPLE') return 'AGENTIC_LIGHT'
    if (c.tier === 'TOP') return 'AGENTIC_TOP'
    return 'AGENTIC'
  }
  if (c.category === 'reasoning') return 'REASONING'
  if (c.tier === 'SIMPLE') return 'SIMPLE'
  return c.tier === 'TOP' ? 'TOP' : 'MID'
}

const WALK: Record<SurplusModelSet, SurplusModelSet[]> = {
  SIMPLE:        ['MID', 'TOP', 'AGENTIC', 'REASONING'],
  MID:           ['TOP', 'AGENTIC', 'REASONING', 'SIMPLE'],
  TOP:           ['REASONING', 'AGENTIC_TOP', 'AGENTIC', 'MID', 'SIMPLE'],
  REASONING:     ['TOP', 'AGENTIC_TOP', 'AGENTIC', 'MID', 'SIMPLE'],
  AGENTIC:       ['AGENTIC_TOP', 'TOP', 'MID', 'SIMPLE'],
  AGENTIC_LIGHT: ['AGENTIC', 'SIMPLE', 'MID', 'TOP'],
  AGENTIC_TOP:   ['AGENTIC', 'TOP', 'REASONING', 'MID', 'SIMPLE'],
  VISION:        ['TOP', 'AGENTIC_TOP', 'MID', 'SIMPLE'],
}

/**
 * Full routing decision: classify → pick model-set → resolve to an ordered chain
 * of catalog ids, with a fail-safe walk-down (catalog drift) and runtime
 * re-ordering (cooled-down ids to the end, low-reliability ids sink).
 */
export function routeSurplus(
  input: SurplusRouteInput,
  catalogIds: string[],
  opts: SurplusRouteOpts = {},
): SurplusRouteDecision {
  const c = classifySurplus(input, opts.boundaries)
  const setName = selectModelSet(c, input.tools === true, input.hasImage === true)
  const category: SurplusCategory = input.hasImage ? 'vision' : c.category

  // Per-provider tier map (default: the Surplus-tuned map). The classifier above
  // is catalog-agnostic; only the tier→model patterns vary by provider.
  const tiers = opts.tierMap ?? SURPLUS_TIERS

  let modelSet = setName
  let chain = resolveChain(tiers[setName], catalogIds, !isCheapSet(setName))
  let reasoning = c.reasoning + ` → set ${setName}`

  if (chain.length === 0) {
    for (const s of WALK[setName]) {
      const resolved = resolveChain(tiers[s], catalogIds, !isCheapSet(s))
      if (resolved.length > 0) { chain = resolved; modelSet = s; reasoning += ` (empty→${s})`; break }
    }
  }
  if (chain.length === 0) {
    chain = catalogIds.length > 0 ? [catalogIds[0]!] : [DEFAULT_SURPLUS_MODEL]
    reasoning += '; no catalog match→default'
  }

  const bucket = `${category}:${c.tier}`

  // ── Runtime re-ordering (injected, keeps this fn pure) ──────────────────────
  // Stable stages, WEAKEST signal first, so later (stronger) stages win:
  //   elo (global prior) < bandit (bucket preference) < reliability (global
  //   health) < stability (consistency) < cooldown (acute).
  //
  // 0. Elo (cold-start-safe late prior): an Elo / Bradley-Terry global ranking
  //    for the bucket breaks ties among the within-tier candidates BEFORE any
  //    other signal runs. Placed first so it is the weakest input — bandit /
  //    reliability / stability / cooldown all re-order on top and override it, so
  //    it can only decide the order of ids those stronger stages leave equal
  //    (e.g. before there is any bandit/reliability evidence at all). Inert
  //    unless opts.eloRank is supplied, so existing routing is unchanged.
  if (opts.eloRank && chain.length > 1) {
    const ranked = opts.eloRank(bucket, chain)
    // Defensive: only adopt a same-membership permutation (the store returns the
    // ids we passed, sorted) so a buggy/foreign ranker can never drop or inject
    // a candidate.
    if (
      Array.isArray(ranked) && ranked.length === chain.length
      && ranked.every(id => chain.includes(id))
    ) {
      if (ranked[0] !== chain[0]) reasoning += `; elo→${ranked[0]}`
      chain = ranked
    }
  }
  // 1. Bandit (C1): deterministic posterior-mean re-rank over (bucket|model)
  //    Beta arms, blended with a POSITION PRIOR worth K pseudo-observations.
  //    Cold start (no arms recorded) reproduces the pattern order EXACTLY
  //    (post = prior mean, strictly decreasing by position); with evidence the
  //    observed successes/failures shift the posterior and can promote a model
  //    that keeps doing better than its slot, or demote a disappointing one.
  //    This is the posterior-MEAN flavor of Thompson sampling — deterministic,
  //    so identical prompts route identically (testable, predictable for the
  //    user). Swap mean → Beta draw later if exploration is ever needed.
  if (opts.banditArm && chain.length > 1) {
    const K = 6
    const priorMean = (i: number) => clamp(0.8 - 0.08 * i, 0.4, 0.8)
    const ranked = chain
      .map((id, i) => {
        const arm = opts.banditArm!(bucket, id)
        const aObs = arm ? arm.a - 1 : 0  // strip the Beta(1,1) init
        const bObs = arm ? arm.b - 1 : 0
        const post = (aObs + K * priorMean(i)) / (aObs + bObs + K)
        return { id, i, post }
      })
      .sort((x, y) => (y.post - x.post) || (x.i - y.i))
    if (ranked[0]!.id !== chain[0]) reasoning += `; bandit→${ranked[0]!.id}`
    chain = ranked.map(x => x.id)
  }
  // 2. Reliability: sink low-reliability ids (stable; cold-start reliability=1 → no-op).
  if (opts.reliability && chain.length > 1) {
    chain = chain
      .map((id, i) => ({ id, i, r: opts.reliability!(id) }))
      .sort((a, b) => (b.r - a.r) || (a.i - b.i))
      .map(x => x.id)
  }
  // 2b. Stability (router-intel): a LATE within-tier tiebreaker. Ids whose
  //     latency score is below STABILITY_SPIKY_THRESHOLD (consistently spiky tail
  //     latency) sink behind their non-spiky peers — a stable partition, so it
  //     never reorders two spiky (or two healthy) ids, never promotes a model the
  //     pattern/bandit/reliability stages didn't, and runs BEFORE cooldown so an
  //     acute failure still wins. Cold start (-1) is treated as not-spiky (no-op).
  if (opts.stability && chain.length > 1) {
    const isSpiky = (id: string): boolean => {
      const s = opts.stability!(id)
      return s >= 0 && s < STABILITY_SPIKY_THRESHOLD
    }
    const healthy = chain.filter(id => !isSpiky(id))
    const spiky = chain.filter(id => isSpiky(id))
    if (spiky.length > 0 && healthy.length > 0) {
      chain = [...healthy, ...spiky]
      reasoning += `; spiky→back(${spiky.length})`
    }
  }
  // 3. Cooldown: push recently-failed ids to the END (never drop — last resort).
  if (opts.cooledDown && opts.cooledDown.size > 0 && chain.length > 1) {
    const live = chain.filter(id => !opts.cooledDown!.has(id))
    const cooled = chain.filter(id => opts.cooledDown!.has(id))
    if (live.length > 0) { chain = [...live, ...cooled]; if (cooled.length) reasoning += `; cooled→end(${cooled.length})` }
  }

  return {
    tier: c.tier,
    category,
    modelSet,
    primary: chain[0]!,
    chain,
    reasoning,
    confidence: c.confidence,
    score: c.score,
    agenticScore: c.agenticScore,
    workflowEligible: c.workflowEligible,
    bucket,
  }
}

/**
 * Provider-neutral alias for routeSurplus. The router resolves generic model-
 * family patterns (claude / gpt / gemini / haiku / …) against ANY OpenAI-
 * compatible catalog passed via `catalogIds`, so it is NOT Surplus-specific.
 * New call sites for other gateways (Bankr, OpenGateway, …) should prefer this
 * name and pass that provider's catalog ids.
 */
export const routeModel = routeSurplus

/**
 * Whether a decision should run the agent-kit WORKFLOW instead of a single model.
 * Conservative: hard AND multi-step/agentic AND the caller opted in.
 */
export function shouldEscalateToWorkflow(decision: SurplusRouteDecision, allow: boolean): boolean {
  return allow === true && decision.workflowEligible
}
