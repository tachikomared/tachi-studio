export interface ProviderSettings {
  id: string
  kind: 'bankr' | 'gitlawb' | 'custom-openai' | 'custom-anthropic' | 'ollama' | 'lmstudio' | 'jan'
  displayName: string
  baseUrl: string
  selectedModel?: string
  enabled: boolean
}

/** Themes that ship as a CSS sheet in the bundle (src/themes/<id>.css). */
export const BUILT_IN_THEMES = [
  'bankr', 'tachi-dark', 'tachi-neon', 'comic',
  'tachi-opus5', 'tachikoma-red',
] as const
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number]

/**
 * Theme ids that shipped once and have since been deleted, mapped to what a
 * settings file (or a localStorage key) holding them should be read AS.
 *
 * A retired id is NOT a validation error: it is a value the app itself wrote to
 * the user's disk, so rejecting it would mean a boot crash or an unstyled window
 * for anyone who happened to be on that theme when they updated. Every read path
 * coerces through here instead — the settings save schema
 * (electron/services/settings-schema.ts) and the renderer's boot stamp
 * (src/store/theme.store.ts initTheme), which also rewrites the stored value so
 * the coercion happens exactly once per install.
 *
 *   tachi-crab — CRAB HIGH-TECH, removed 2026-07-26 (owner's call). Its claw
 *     art survives in src/assets/crab/ as the OPUS-5 engraving mask; the theme,
 *     its structure layer and CrabChrome.tsx do not.
 */
export const RETIRED_THEMES: Readonly<Record<string, BuiltInTheme>> = {
  'tachi-crab': 'tachi-dark',
}

/**
 * Read a stored theme id. Retired ids fall back to their replacement; anything
 * else (including a `custom:` pointer and an id this build has never heard of)
 * is returned untouched, because only the caller knows whether an unknown id is
 * a custom theme it can still inject.
 */
export function coerceStoredTheme(stored: string): string {
  return RETIRED_THEMES[stored] ?? stored
}

/**
 * A theme imported from a design mockup. Its id is a slug; the ACTIVE-theme
 * value is the prefixed `custom:<id>` (see ThemeId) — the prefix is what keeps
 * user ids from ever colliding with a built-in.
 */
export interface CustomTheme {
  /** Slug, `[a-z0-9-]{1,48}`. NOT prefixed. */
  id: string
  /** Human label shown in Settings. */
  label: string
  /** One `:root[data-theme="custom:<id>"] { … }` block, produced by extractTheme. */
  css: string
  /**
   * OPTIONAL structure layer: the chassis (geometry, texture, keyframes) the
   * import carried beyond the palette, every selector rescoped to the same
   * `custom:<id>` and every keyframe name prefixed — see extractStructureCss in
   * packages/core/src/design/theme-extract.ts. Injected right after `css`.
   *
   * Absent on every theme imported before this existed, and absent on any
   * import whose source was palette-only: those stay pure recolours and keep
   * working untouched.
   */
  structureCss?: string
}

/**
 * The value of AppSettings.theme / the `data-theme` attribute.
 *
 * A TEMPLATE-LITERAL member, deliberately: extending the built-in enum with a
 * dynamic id would mean touching five compile-time unions and a zod enum every
 * time a user imports a theme (see docs/app/DESIGN-VERTICAL-RESEARCH-2026-07-26.md).
 * Custom themes live in their own `customThemes` key instead, and this type
 * widens just enough to carry the pointer.
 */
export type CustomThemeId = `custom:${string}`
export type ThemeId = BuiltInTheme | CustomThemeId

export interface AppSettings {
  onboardingComplete: boolean
  theme: ThemeId
  activeProviderId?: string
  providers: ProviderSettings[]
  consoleDockOpen: boolean
  consoleDockHeight: number
  bankrBuddyPort: number
  followProviderTheme: boolean
  webSearchEnabled: boolean
  userMemory: string
  /** Whether to show native desktop notifications. Defaults to true. */
  notificationsEnabled: boolean
  /** When true: hides cloud providers, disables web search, hides Aeon tab. Defaults to false. */
  strictPrivacyMode: boolean
  /** When true: scrub detected secrets/PII (emails, keys, cards) from outbound CLOUD requests, replacing them with stable placeholders. Defaults to false. */
  scrubSecretsOutbound: boolean
  /**
   * User-customised keyboard accelerators keyed by HotkeyAction.id.
   * Missing keys fall back to the action's defaultAccelerator.
   */
  hotkeys: Record<string, string>
  /**
   * Smart-router difficulty boundaries (classifier score cutoffs): scores below
   * routerSimpleMax route SIMPLE, below routerMidMax route MID, above TOP.
   * Tuned from the chat SMART chip popover (no settings panel by design).
   */
  routerSimpleMax: number
  routerMidMax: number
  /**
   * Permission mode for the in-process MCP server's tools (Claude-style modes,
   * user-selected in Settings): locked = no tools; read_only = inspect only;
   * read_write = + local fs/git mutations; full = + network egress (legacy
   * behavior — the default so existing setups keep working until the user
   * chooses a stricter scope).
   */
  mcpMode: 'locked' | 'read_only' | 'read_write' | 'full'
  /**
   * Whether the in-app MCP server auto-starts with the app (localhost-only,
   * token-gated; it exists so external agents — Claude Desktop, Cline, Codex,
   * darksol — can use Tachi's fs/git/llm tools). Toggle in Settings -> MCP.
   */
  mcpServerEnabled: boolean
  /**
   * Whether the local OpenAI-compatible API server auto-starts with the app
   * (127.0.0.1:11435, Bearer-gated). Lets external tools use Tachi Studio as a
   * drop-in OpenAI/Ollama endpoint serving FreeLLM + llama.cpp. Toggle in
   * Settings -> Connections -> OPENAI API row.
   */
  apiServerEnabled: boolean
  /**
   * Rolling 30-day USD spend cap for LLM usage recorded by the cost ledger.
   * 0 = unlimited (default). When the priced 30-day spend reaches this value,
   * chat-service and the TACHI harness refuse to start new requests.
   */
  llmBudgetUsd30d: number
  /**
   * Fusion PANEL model patterns (substring-matched against the active fusion
   * provider's live catalog). Empty = use the per-provider preset. Lets the user
   * choose which models the panel (consult_panel / fuse_plan / chat Fusion) runs.
   */
  fusionPanel: string[]
  /** Fusion JUDGE/arbiter model pattern. Empty = use the provider preset. */
  fusionJudge: string
  /**
   * USER-VISIBLE folder where the app saves user content (generated media,
   * designs, renders, flows) AND where local model weights are downloaded to
   * (`<root>/Models/<engine>/`). Empty = default Documents/Tachi Studio, which
   * on a stock Windows install is on the SAME drive as %APPDATA% — so pointing
   * this at another drive is the only thing that actually gets tens of GB of
   * weights off the system drive. App internals (keys, caches, logs, sidecar
   * binaries) stay in userData regardless.
   */
  storageRoot: string
  /**
   * Storage roots this install has previously used, newest first. Weights are
   * located by convention (`<root>/Models/...`) rather than by a stored path,
   * so without this a change of `storageRoot` would make every already-relocated
   * weight read as "not installed" while still filling the disk. Kept so those
   * files stay resolvable and can be migrated to the new root.
   */
  modelRootHistory: string[]
  /**
   * Telegram remote channel into the TACHI agent. Off by default; needs a bot
   * token (keychain 'telegram-bot') + one paired chat. Never runs in private
   * mode (long-polls api.telegram.org).
   */
  telegramEnabled: boolean
  /** The single paired Telegram chat id ('' = unpaired; pairing code flow). */
  telegramChatId: string
  /** Workspace the Telegram agent works in ('' = the storage root). */
  telegramWorkspace: string
  /** Whether the TACHI harness may delegate to the Codex worker (codex_worker
   *  tool). Toggled by the CODE-tab chip; default on (when installed+logged in). */
  codexWorkerEnabled: boolean
  /** Prefer the persistent `codex app-server` JSON-RPC transport (one warm
   *  process reused across runs) over spawning `codex exec` per task. Default
   *  ON; on ANY app-server transport failure the worker falls back to exec, so
   *  turning this off only forces the exec path. */
  codexAppServerEnabled: boolean
  /**
   * Where Tachi Studio's OWN source checkout lives, for the TACHIAPP
   * self-improvement chat (the surface that edits this app). Empty = resolve
   * automatically (dev walk-up from the app path, then known-install
   * candidates). Written once when the user answers the LOCATE APP SOURCE
   * card, and never asked again.
   */
  appRepoPath: string
  /**
   * Themes imported from design mockups (Settings -> Appearance -> Custom
   * themes). Applied by injecting their `css` into one <style> element at
   * runtime — no rebuild, no new CSS file. Empty by default.
   */
  customThemes: CustomTheme[]
  /**
   * TACHI harness CONTEXT RECALL (batch33). When on, a run's context assembly
   * gets two extra passes, both bounded by `tachiRecallBudgetTokens`:
   *   1. the session's older history is score-ranked against the current task
   *      and packed into one recap turn (the recent tail stays verbatim);
   *   2. the top lexically-reranked excerpts from the saved-chat FTS5 index are
   *      injected ahead of the task, sandbox-wrapped as untrusted data.
   * Default ON. Off = the assembly path is byte-identical to the pre-batch33
   * behaviour (pinned in test/unit/tachiContextPack.test.ts).
   */
  tachiRecallEnabled: boolean
  /**
   * Token budget for the recall surface above. Caps the history recap; the
   * injected chat excerpts get half of it. 0 disables the whole surface exactly
   * like `tachiRecallEnabled: false`.
   */
  tachiRecallBudgetTokens: number
  /**
   * CIVITAI 18+ — the user's explicit adult-content opt-in. DEFAULT OFF, and it
   * is only half of the unlock: the effective mode is adult ONLY when this is
   * true AND `civitaiAdultAcceptedAt > 0` AND the user's OWN Civitai API key is
   * in the keychain. Any one missing ⇒ SFW. The decision is made in exactly one
   * place (civitaiAdultUnlocked in electron/services/civitai-gate.ts).
   *
   * This flag widens LAYER 1 only. Layer 0 (poi / minor / TakenDown / the
   * Blocked bit / the minor-adjacent denylist) takes no parameters at all and
   * cannot be reached by any value of this setting.
   */
  civitaiAdultMode: boolean
  /**
   * Epoch ms when the user affirmed the 18+ dialog. 0 = never affirmed.
   *
   * It is a TIMESTAMP rather than a second boolean on purpose: a boolean pair
   * would be indistinguishable from a default, while a time says which
   * affirmation is being relied on. Turning the mode off resets it to 0, so
   * re-enabling always goes back through the dialog — the setting can be
   * written by nothing else that a user can reach.
   */
  civitaiAdultAcceptedAt: number
  /**
   * LOCAL ENGINE — KV-CACHE PRECISION for llama.cpp (`--cache-type-k`).
   *
   * The KV cache is the second-largest thing in VRAM after the weights, and at
   * a long context it can be the LARGER of the two. Storing the keys at 8 bits
   * instead of 16 halves that term, which is the difference between a model
   * that fits on the card and one that spills to system RAM.
   *
   * 'f16' is the default and means "pass nothing" — llama.cpp keeps its own
   * default, whatever that build chose. It is not a claim that f16 IS the
   * build's default; it is a refusal to make one.
   *
   * K ONLY, deliberately: quantising V without flash attention makes llama.cpp
   * dequantise on every attention step, which costs more time than the memory
   * is worth. The reasoning lives beside the flag in llama-cpp-client.ts.
   */
  llamaKvCache: 'f16' | 'q8_0' | 'q4_0'
}

export const DEFAULT_SETTINGS: AppSettings = {
  onboardingComplete: false,
  theme: 'tachi-dark',
  activeProviderId: undefined,
  providers: [],
  consoleDockOpen: false,
  consoleDockHeight: 240,
  bankrBuddyPort: 23444,
  followProviderTheme: false,
  webSearchEnabled: false,
  userMemory: '',
  notificationsEnabled: true,
  strictPrivacyMode: false,
  scrubSecretsOutbound: false,
  hotkeys: {},
  routerSimpleMax: 0.05,
  routerMidMax: 0.35,
  // Default to read_only (audit S5): a fresh install exposes only inspect-tier
  // tools to connected external agents. The user widens it in Settings -> MCP
  // (existing installs keep whatever they already persisted).
  mcpMode: 'read_only',
  mcpServerEnabled: true,
  apiServerEnabled: true,
  llmBudgetUsd30d: 0,
  fusionPanel: [],
  fusionJudge: '',
  storageRoot: '',
  modelRootHistory: [],
  telegramEnabled: false,
  telegramChatId: '',
  telegramWorkspace: '',
  codexWorkerEnabled: true,
  codexAppServerEnabled: true,
  appRepoPath: '',
  customThemes: [],
  tachiRecallEnabled: true,
  // ~4.8k chars of ASCII: the same order as the playbook read-back cap (6000
  // chars, shipped and known not to crowd out real work) and ~2% of the
  // smallest agent-capable context window. Big enough that a long session's
  // recap stays useful, small enough that it can never be the reason a run
  // runs out of room.
  tachiRecallBudgetTokens: 1200,
  // 18+ is OFF on a fresh install and after every reset. Never bundled into
  // another toggle, never a migration default.
  civitaiAdultMode: false,
  civitaiAdultAcceptedAt: 0,
  // f16 = pass no flag at all and let the installed build decide. A default
  // that quantised would be us changing the numerics of everyone's local model
  // on an upgrade, without being asked.
  llamaKvCache: 'f16',
}
