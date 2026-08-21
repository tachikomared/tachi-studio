export * from './chat/backend.js'
export { scrubSecrets, hasSecrets, newRedactionMap, type RedactionMap, type ScrubResult, type SecretCategory } from './chat/scrub.js'
export { extractReasoningDelta, createThinkWrapper } from './chat/reasoning-stream.js'
export { budgetHistory, type HistoryTurn, type BudgetHistoryOptions } from './chat/budget-history.js'
export { classifyProviderError, type ProviderErrorKind } from './chat/classify-error.js'
export {
  planLlmCompaction,
  buildCompactionPrompt,
  applyCompactionSummary,
  type PlanLlmCompactionOptions,
  type CompactionPlan,
} from './chat/compaction-plan.js'
export { repairToolMessages, type ToolishMessage, type ToolCallish } from './chat/repair-tool-messages.js'
export {
  runFusion,
  collectStream,
  rerunFusionMember,
  buildJudgeSystem,
  fusionLabel,
  FUSION_JUDGE_SYSTEM,
  type FusionOptions,
  type FusionPanelMember,
} from './chat/fusion.js'
export * from './runtime/types.js'
export * from './logging/types.js'
export * from './commands/types.js'
export * from './settings/types.js'
export { BankrProvider } from './providers/bankr/bankr-provider.js'
export { OpenAiCompatBackend, type OpenAiCompatConfig } from './providers/openai-compat/openai-compat-provider.js'
// Unified provider/model registry — the single source of truth for which
// inference providers exist (consumed by chat, agents, and nodes). Pure data;
// the renderer imports it via the subpath `@tachi/core/src/providers/registry`
// to bypass this Node-only barrel.
export * from './providers/registry.js'
// Agent-harness OpenGateway model pin + the 'default' provider ladder policy.
// Pure; the renderer imports it via `@tachi/core/src/providers/agent-route`.
export * from './providers/agent-route.js'
// User-added "custom OpenAI-compatible" endpoints (LM Studio / Ollama / vLLM on
// the LAN). Pure helpers — provider-id scheme, base-URL normalization, hostname
// locality (PRIVATE MODE egress rule). See providers/custom-endpoint.ts.
export {
  CUSTOM_PROVIDER_PREFIX,
  customProviderId,
  parseCustomProviderId,
  isCustomProviderId,
  customEndpointKeychainId,
  normalizeBaseUrl,
  classifyHostLocality,
  endpointLocality,
  isLocalCustomEndpoint,
  type NormalizeBaseUrlResult,
  type EndpointLocality,
} from './providers/custom-endpoint.js'
export { isVisionModel } from './providers/vision.js'
// Design tab (TACHI Design): pure prompt/spec helpers + curated brand presets.
// Renderer imports these via the `@tachi/core/src/design/...` subpath.
export type { DesignSpec, BrandPreset, RadiusScale, Density, Motion } from './design/types.js'
export { BRAND_PRESETS, getPreset } from './design/presets.js'
export { buildDesignSystemPrompt, extractHtmlDocument, renderSpec, buildBriefSystemPrompt, buildClarifySystemPrompt, parseClarifyReply, clarifyQuestionsToText } from './design/prompt.js'
export { DESIGN_TASTE, PALETTE_DIRECTIVE } from './design/skills.js'
export type { DesignPromptOptions, ClarifyQuestion } from './design/prompt.js'
export { buildAnimationSystemPrompt, extractCompositionCode, sanitizeComposition, buildRemotionHtml, buildRemotionHtmlFromJs, buildRemotionEntry, REMOTION_GLOBALS } from './design/remotion.js'
export { buildHyperframesSystemPrompt, extractHyperframesHtml, buildHyperframesPreviewHtml, buildHyperframesCaptureHtml, extractHyperframesMeta, HYPERFRAMES_COMPOSITION_ID } from './design/hyperframes.js'
export { DESIGN_SCAFFOLD_VERSION, DESIGN_SCAFFOLD_MARK } from './design/scaffold.js'
export type { HyperframesMeta } from './design/hyperframes.js'
// Theme pipeline: design mockup -> scoped custom-property block -> validation.
export { extractTheme, slugifyThemeId, collectRootVariables, THEME_VAR_NAMES } from './design/theme-extract.js'
export type { ExtractedTheme, ThemeExtractReport, ThemeVarName } from './design/theme-extract.js'
export { validateThemeCss, TEXT_CONTRAST_PAIRS, LARGE_CONTRAST_PAIRS } from './design/theme-validate.js'
export type { ThemeValidation, ThemeIssue, ThemeIssueLevel, ThemeIssueRule } from './design/theme-validate.js'
export { contrastRatio, parseColor, relativeLuminance, toHex } from './design/theme-color.js'
export { buildRegistry } from './runtime/registry.js'
export type { RegistryConfig } from './runtime/registry.js'
export type { BinaryExecutor } from './runtime/detectors/codex.js'
export { createCodexDetector } from './runtime/detectors/codex.js'
export { createClaudeCodeDetector } from './runtime/detectors/claude-code.js'
export { createOpenClaudeDetector } from './runtime/detectors/openclaude.js'
export { createOpenClawDetector } from './runtime/detectors/openclaw.js'
export { createOpenCodeDetector } from './runtime/detectors/opencode.js'
export { createHermesAgentDetector } from './runtime/detectors/hermes-agent.js'
export { createAeonDetector } from './runtime/detectors/aeon.js'
export { createComfyUIDetector } from './runtime/detectors/comfyui.js'
export { createN8nDetector } from './runtime/detectors/n8n.js'
export { createVSCodeDetector } from './runtime/detectors/vscode.js'
export { makeLogEvent } from './logging/format.js'

// Profiles
export type { Profile, ProfilePermissions } from './profiles/schema.js'
export { ProfileSchema, ProfilePermissionsSchema, parseProfile } from './profiles/schema.js'
export { DEFAULT_PROFILES } from './profiles/types.js'
export type {
  ProfilesFileV1, ProfilesStorageAdapter, ProfilesStore,
} from './profiles/profiles-store.js'
export { createProfilesStore } from './profiles/profiles-store.js'
export type { ResolvedPrompt } from './profiles/prompt-resolver.js'
export { resolvePrompt } from './profiles/prompt-resolver.js'

// Workspace
export type { Workspace, AgentsMdFile, AgentsMdMeta } from './workspace/types.js'
export { parseAgentsMd, AGENTS_MD_MAX_BYTES } from './workspace/agents-md-parser.js'

// Utils
export { findFreePort } from './utils/port-finder.js'

// Pricing — single source of truth for the model $/M-token table, shared by the
// main-process cost ledger AND the renderer's per-conversation estimates.
export {
  MODEL_RATES, ratesFor, costUsd, costUsdFromRates, isVerifiedFreeModel, expiredFreeModelIds,
  RETIRED_MODELS, retirementOf,
  type ModelRates, type RetiredModel,
} from './pricing.js'

// Memory (recall scorer + context packer — shared by renderer AND main process)
export * from './memory/context-packer.js'
export * from './memory/recall.js'
// Structured persistent-memory facts (T16) — migration, budget join, and the
// zero-LLM auto-capture heuristic. Pure; renderer imports via the subpath.
export * from './memory/facts.js'

// RAG core (pure: chunker + flat-cosine vector store + Embedder interface).
// The real in-process embedder is wired in the Electron main behind Embedder.
export * from './rag/types.js'
export * from './rag/cosine.js'
export * from './rag/vector-store.js'
export * from './rag/chunk.js'
// RAG source citations (T20): the pure hits → persisted-provenance mapping
// shared by main (produces), the chat store (persists) and the bubble (renders).
export * from './rag/citations.js'

// Code-dependency graph (pure: import edges + reverse-BFS blast radius). Powers
// the harness's read-only blast_radius tool (code uses agentic search + a fresh
// import graph, not a stale vector index — see RAG decision REVISIT 2026-06-22).
export * from './codegraph/parse.js'
export * from './codegraph/graph.js'

// Catalog
export * from './catalog/types.js'
export * from './catalog/fit.js'
export * from './catalog/hf.js'

// Agent
export type {
  AgentEvent,
  ParsedSlashCommand,
  SlashCommand,
  // Deprecated alias — retained for backward compatibility.
  AgentParsedSlashCommand,
} from './agent/types.js'
export { parseDarksolEvent } from './agent/darksol-events.js'
export { buildSlashCommandInstruction } from './agent/slash-instruction.js'
export { buildAgentHistory, type AgentHistoryTurn } from './agent/history.js'

// Wallet
export * from './chains.js'
export * from './wallet-math.js'

// TACHI harness — pure logic modules (the loop + tools live in apps/desktop).
export type {
  TachiToolName, TachiToolCall, EditResult, EditStrategy, EditFailureReason,
  SalvagedCall, StallVerdict, EstimableMessage, TruncateOptions, TruncateResult,
  ToolProtocol, EditFormat, ModelCapability, CommandSafety,
} from './tachi/contract.js'
export { applyEdit } from './tachi/tools/edit-core.js'
export { truncateOutput } from './tachi/tools/truncate.js'
export { signalCompact, scoreLine } from './tachi/tools/signal-compact.js'
export type { SignalCompactOptions } from './tachi/tools/signal-compact.js'
export { CompactedStore, readCompactedSlice, compactionReceipt, elisionNotice, queryCompacted, unknownCompactedId } from './tachi/tools/compacted-store.js'
export type { CcrQueryMode, CcrQuery } from './tachi/tools/compacted-store.js'
export { salvageToolCalls } from './tachi/salvage.js'
export { parseSkillFrontmatter, stripSkillFrontmatter, buildAvailableSkillsBlock, isValidSkillName } from './tachi/skills.js'
export type { SkillMeta } from './tachi/skills.js'
export { suggestSkills } from './tachi/skill-suggest.js'
export type { WorkspaceMarkers, SkillSuggestion } from './tachi/skill-suggest.js'
export { fingerprint, detectStall } from './tachi/loop/stall.js'
export { errorSignature, detectErrorLoop, buildRepeatedErrorNudge } from './tachi/loop/error-breaker.js'
export { classifyTask, type TaskType } from './tachi/task-classify.js'
export { planGpuLayers, planServe, kvCacheMB, ALL_LAYERS, MIN_SERVE_CONTEXT_TOKENS, type ServeProfile, type GpuLayerInput, type GpuLayerPlan, type ServePlan } from './tachi/serve-profile.js'
export { repairToolName, validateCompletionSummary, editDistance } from './tachi/loop/guards.js'
export { compactAgentMessages, agentHistoryBudgetChars, totalMessageChars } from './tachi/loop/compact.js'
export type { AgentMessageLike, CompactAgentOptions } from './tachi/loop/compact.js'
export { renderTodoLedger, hasOpenTodos, openTodoCount, summarizeTodos } from './tachi/loop/todo.js'
export type { TodoItem, TodoStatus } from './tachi/loop/todo.js'
export { estimateTokens, estimateMessageTokens } from './tachi/estimate-tokens.js'
export { resolveCapability, resolveContextWindow, parseLiveContextTokens, pickLiveContextTokens, ASSUMED_CONTEXT_WINDOW, TACHI_MODEL_CAPABILITIES } from './tachi/models.js'
export type { ContextWindowSource, ResolvedContextWindow } from './tachi/models.js'
export { resolveModelProfile, profiledIdleMs } from './tachi/model-profiles.js'
export type { ModelProfile, ModelTier } from './tachi/model-profiles.js'
export { classifyCommand } from './tachi/safety.js'

// Deep-research loop (pure orchestrator; search/fetch/ask injected by the host).
export {
  parseResearchVerdict,
  runDeepResearch,
  type DeepResearchDeps,
  type DeepResearchOptions,
  type DeepResearchResult,
  type ResearchFinding,
  type SearchHit,
} from './tools/deep-research.js'
export * from './prompts/template.js'

// Beginner-legible model chooser: the task taxonomy (coding / agentic /
// everyday / long documents / images / free), the pure id→tags resolver, and
// the recommendation helper. Every tag is derived from a fact we hold or
// curated with a source AND a date; an unknown model gets no tags.
// The renderer imports these via the subpaths
// `@tachi/core/src/models/task-tags` and `@tachi/core/src/models/resolve-task-tags`
// to bypass this Node-only barrel (same reason as providers/registry).
export {
  TASK_TAGS,
  TASK_TAG_COPY,
  REJECTED_TAGS,
  IMAGE_INPUT_MODELS,
  CURATED_MODEL_NOTES,
  CURATION_MAX_AGE_DAYS,
  LONG_CONTEXT_MIN_TOKENS,
  EVERYDAY_MAX_INPUT_USD_PER_M,
  EVERYDAY_MAX_OUTPUT_USD_PER_M,
  isTaskTag,
  taskTagI18nKey,
  isCurationFresh,
  staleCuratedModelIds,
  type TaskTag,
  type TaskTagCopy,
  type CuratedModelNote,
  type ImageInputFact,
  type LiveModelFacts,
} from './models/task-tags.js'
export {
  resolveTaskTags,
  hasTaskTag,
  recommendModels,
  isOfferableFor,
  type TaskTagResult,
  type ResolveTaskTagsInput,
  type ModelCandidate,
  type UserAvailability,
  type Recommendation,
  type RecommendOptions,
} from './models/resolve-task-tags.js'
