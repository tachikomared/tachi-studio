// apps/desktop/electron/services/settings-schema.ts
//
// The settings:save validation schema, extracted from settings.ipc.ts so it can
// be unit-tested without importing electron. This schema is the write-side
// allowlist for tachi-settings.json: unknown keys are deliberately stripped
// (no .passthrough()), so every key of AppSettings MUST be listed here or
// renderer saves of that key silently no-op. That exact bug shipped three
// times (userMemory, mcpMode, routerSimpleMax/routerMidMax) — the drift guards
// at the bottom turn the next occurrence into a compile error, and
// test/unit/settings-schema.test.ts asserts the full round-trip at runtime.

import { z } from 'zod'
import { BUILT_IN_THEMES, coerceStoredTheme, type AppSettings, type CustomThemeId } from '@tachi/core'

/** Must match MEMORY_LIMIT in src/pages/settings/MemorySection.tsx. */
const USER_MEMORY_MAX_CHARS = 4000

/** Mirrors slugifyThemeId() in packages/core/src/design/theme-extract.ts. */
const CUSTOM_THEME_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/

/**
 * The active theme: one of the built-ins, or a `custom:<slug>` pointer into
 * `customThemes`. The built-in ENUM is deliberately NOT extended with user ids
 * (they are dynamic); the second branch is a template-literal type validated by
 * pattern, so the drift guards below still see the real `ThemeId` and a bad
 * value is still rejected rather than stripped.
 *
 * RETIRED IDS ARE COERCED, NOT REJECTED. A deleted theme's id can still arrive
 * here — it is in the user's own settings file and the renderer echoes settings
 * back on the next save — and `settings:save` parses with `.parse()`, so a
 * rejection would THROW on an ordinary save of an unrelated key. The preprocess
 * maps a retired id to its replacement before the union sees it (the same table
 * the renderer's initTheme uses), so the write self-heals the file instead of
 * failing. Genuinely bogus ids still fail the union.
 */
const themeIdSchema = z.preprocess(
  (v) => (typeof v === 'string' ? coerceStoredTheme(v) : v),
  z.union([
    z.enum(BUILT_IN_THEMES),
    z.custom<CustomThemeId>(
      (v) => typeof v === 'string' && v.startsWith('custom:') && CUSTOM_THEME_SLUG.test(v.slice('custom:'.length)),
      { message: 'invalid theme id' },
    ),
  ]),
)

export const appSettingsSaveSchema = z.object({
  theme: themeIdSchema.optional(),
  customThemes: z.array(z.object({
    id: z.string().regex(CUSTOM_THEME_SLUG),
    label: z.string().min(1).max(64),
    // Generated palette blocks are ~1.5 KB; the cap is a sanity bound on what
    // a renderer may push into the settings file, not a design constraint.
    css: z.string().min(1).max(32_000),
    // Rescoped structure layer from a Claude-Design handoff pair; cap matches
    // MAX_STRUCTURE_CSS_CHARS in core theme-extract. Absent on palette-only
    // imports and on every legacy entry — zod strips unknown keys, so without
    // this line the layer survives the session but vanishes on the next boot.
    structureCss: z.string().max(200_000).optional(),
  })).max(32).optional(),
  activeProviderId: z.string().optional(),
  consoleDockOpen: z.boolean().optional(),
  consoleDockHeight: z.number().optional(),
  onboardingComplete: z.boolean().optional(),
  followProviderTheme: z.boolean().optional(),
  bankrBuddyPort: z.number().optional(),
  webSearchEnabled: z.boolean().optional(),
  userMemory: z.string().max(USER_MEMORY_MAX_CHARS).optional(),
  notificationsEnabled: z.boolean().optional(),
  strictPrivacyMode: z.boolean().optional(),
  scrubSecretsOutbound: z.boolean().optional(),
  hotkeys: z.record(z.string(), z.string()).optional(),
  routerSimpleMax: z.number().optional(),
  routerMidMax: z.number().optional(),
  mcpMode: z.enum(['locked', 'read_only', 'read_write', 'full']).optional(),
  mcpServerEnabled: z.boolean().optional(),
  apiServerEnabled: z.boolean().optional(),
  llmBudgetUsd30d: z.number().min(0).optional(),
  fusionPanel: z.array(z.string()).optional(),
  fusionJudge: z.string().optional(),
  storageRoot: z.string().max(1024).optional(),
  // Every storage root this install has previously used, newest first. Model
  // weights are located by CONVENTION (`<root>/Models/<engine>/<id>`), not by a
  // path stored per model — so the moment `storageRoot` changes, weights that
  // were relocated under the OLD root stop being found by every resolver and a
  // 7.7 GB download silently reads as "not installed". Remembering the old
  // roots keeps them resolvable, and lets the dashboard offer to move them to
  // the new one. Capped so it can never grow without bound.
  modelRootHistory: z.array(z.string().max(1024)).max(8).optional(),
  appRepoPath: z.string().max(1024).optional(),
  telegramEnabled: z.boolean().optional(),
  telegramChatId: z.string().max(64).optional(),
  telegramWorkspace: z.string().max(1024).optional(),
  codexWorkerEnabled: z.boolean().optional(),
  codexAppServerEnabled: z.boolean().optional(),
  tachiRecallEnabled: z.boolean().optional(),
  // Bounded rather than free: the value becomes a prompt budget, and a typo'd
  // 1200000 would hand the packer a budget larger than any context window.
  // 0 = off (same as the toggle); 32k is above every shipped model's history
  // share, so the ceiling can never be the binding constraint in practice.
  tachiRecallBudgetTokens: z.number().min(0).max(32_000).optional(),
  // A CLOSED SET, not a string: this value reaches the llama-server spawn argv,
  // and the write side is the right place to refuse anything else. The main
  // process validates it a second time when it reads it (isLlamaCacheType) —
  // belt and braces, because a hand-edited tachi-settings.json never passes
  // through here at all.
  llamaKvCache: z.enum(['f16', 'q8_0', 'q4_0']).optional(),
  // CIVITAI 18+. Both keys MUST be listed here or the renderer's save silently
  // no-ops (this schema is the write-side allowlist — the bug the header
  // records, shipped three times already). The pair is deliberately two keys
  // rather than one: `civitaiAdultMode` is the switch, `civitaiAdultAcceptedAt`
  // is the affirmation it rests on, and main requires BOTH plus a stored key
  // before a single request leaves for civitai.red.
  civitaiAdultMode: z.boolean().optional(),
  // Non-negative epoch ms. A negative or fractional value is not a moment in
  // time; 0 is the honest "never affirmed" that turns the unlock back off.
  civitaiAdultAcceptedAt: z.number().min(0).optional(),
  providers: z.array(z.object({
    id: z.string(),
    kind: z.enum(['bankr', 'gitlawb', 'custom-openai', 'custom-anthropic', 'ollama', 'lmstudio', 'jan']),
    displayName: z.string(),
    baseUrl: z.string(),
    selectedModel: z.string().optional(),
    enabled: z.boolean(),
  })).optional(),
})

// ── Compile-time drift guards ─────────────────────────────────────────────────
// If a key is added to AppSettings without being added here (or vice versa),
// or a field's value type stops matching, `pnpm typecheck` fails on these lines.

type SchemaShape = z.infer<typeof appSettingsSaveSchema>
type AssertNever<T extends never> = T
type AssertTrue<T extends true> = T

/** AppSettings keys the schema forgot — must be `never`. */
export type _SettingsKeysMissingFromSchema = AssertNever<Exclude<keyof AppSettings, keyof SchemaShape>>
/** Schema keys that don't exist on AppSettings — must be `never`. */
export type _SchemaKeysUnknownToSettings = AssertNever<Exclude<keyof SchemaShape, keyof AppSettings>>
/** Every schema field's value type must be assignable to its AppSettings type. */
export type _SchemaValuesMatchSettings = AssertTrue<SchemaShape extends Partial<AppSettings> ? true : false>
