// apps/desktop/src/pages/studio/runtime-display.ts
//
// Shared helpers for displaying runtime cards consistently across the
// Studio page and the left Sidebar's "Running Now" list. Centralises
// three concerns:
//   1. Status → sort order: running first, installed next, not_installed last
//   2. Hidden runtimes: what is NOT on this machine (any 'cloud_gateway' card)
//      plus a short list of noise, so the "detected here" list means it
//   3. Click-to-open URLs: per-runtime launch target so a single "Open"
//      button works the same way everywhere

import type { RuntimeCardUpdate } from '@tachi/core'

// ── Status priority ─────────────────────────────────────────────────────────
//
// Lower number = shown first. "running" group at the top, then ready/installed,
// then disabled states, then unknown/error, then not_installed at the bottom.
const STATUS_PRIORITY: Record<string, number> = {
  running:       0,
  healthy:       0,
  connected:     0,
  starting:      1,
  installed:     2,  // CLI tool or app detected on disk, ready to use
  stopped:       3,
  unreachable:   4,
  error:         5,
  not_installed: 6,
}

export function statusOrder(s: string | undefined): number {
  return STATUS_PRIORITY[s ?? ''] ?? 99
}

/** Stable sort: running first, installed next, not installed last. */
export function sortByStatus<T extends { status?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => statusOrder(a.status) - statusOrder(b.status))
}

// ── Hidden runtimes ─────────────────────────────────────────────────────────
//
// TWO SEPARATE REASONS, and only one of them is a list.
//
// 1. NOT ON THIS MACHINE — derived from the detector's own `kind`. A
//    'cloud_gateway' is a remote API with a health probe; it has no process
//    here, no port, and nothing to install. bankr-gateway sat in this list for
//    months, so a card headed "detected on this machine" carried a row whose
//    launch URL is https://bankr.bot/api. Deriving it means the NEXT cloud
//    gateway detector is excluded on the day it is added, rather than the day
//    someone notices. (Aeon is a cloud service too but declares itself a
//    'coding_agent', so it stays in the list below until its detector is
//    reclassified — a hand-written exception is fine; a hand-written RULE is
//    what rots.)
// 2. NOISE — tangential things the owner asked us to drop: LM Studio / Jan are
//    model-shopping GUIs, Bankr Buddy is a Twitter agent, Aeon has its own
//    sidebar tab that handles auth + skills + runs.
const HIDDEN_RUNTIMES = new Set([
  'aeon',
  'lmstudio',
  'jan',
  'bankr-buddy',
])

/** Kinds that describe something running somewhere ELSE. Never listed here. */
const REMOTE_KINDS = new Set<RuntimeCardUpdate['kind']>(['cloud_gateway'])

export function filterDisplayableRuntimes(
  cards: RuntimeCardUpdate[],
): RuntimeCardUpdate[] {
  return cards.filter(c => !REMOTE_KINDS.has(c.kind) && !HIDDEN_RUNTIMES.has(c.runtimeId))
}

// ── Launch targets ──────────────────────────────────────────────────────────
//
// Each entry tells the UI what to open when the user clicks an "Open" button
// on this runtime row. Three patterns:
//   - http/https URL → opens in the user's default browser (most local servers)
//   - protocol URL (vscode://, lmstudio://) → OS hands off to the installed app
//   - github/docs URL → fallback for CLI tools that have no GUI affordance
// NOTE: no 'bankr-gateway' entry. Its card is a 'cloud_gateway', which
// filterDisplayableRuntimes drops from every surface that resolves a launch URL
// (StudioPage's RuntimesCard and the Sidebar both filter before rendering), so
// the row this entry served can no longer exist. It was the last trace of the
// bug where a list headed "detected on this machine" offered to open
// https://bankr.bot/api.
const LAUNCH_URL: Record<string, string> = {
  // Local-server runtimes — point to their own UI/dashboard pages
  'openclaw':       'http://127.0.0.1:18789/',
  'comfyui':        'http://127.0.0.1:8188/',
  'ollama':         'http://127.0.0.1:11434/',
  'n8n':            'http://127.0.0.1:5678/',
  'hermes-agent':   'http://127.0.0.1:8765/',

  // GUI apps that register OS protocol handlers
  'vscode':         'vscode://',
  'lmstudio':       'lmstudio://',
  'jan':            'jan://',

  // CLI tools — point at the docs since there's no GUI to launch
  'claude-code':    'https://docs.claude.com/en/docs/claude-code/',
  'codex':          'https://github.com/openai/codex',
  'opencode':       'https://opencode.ai/',
  'bankr-buddy':    'https://x.com/bankrbot',
}

/**
 * Resolve the URL to open when a user clicks the action button on a runtime
 * card. Prefers the live endpoint when the runtime is actually running (gateway
 * up etc), and falls back to the known launch URL for the runtime id.
 */
export function resolveLaunchUrl(card: RuntimeCardUpdate): string | null {
  const isLive =
    card.status === 'running' || card.status === 'connected' || card.status === 'healthy'
  if (isLive && card.endpoint && /^https?:/i.test(card.endpoint)) {
    return card.endpoint
  }
  return LAUNCH_URL[card.runtimeId] ?? null
}

// Some runtimes have a real web dashboard worth embedding inside the app
// rather than punting the user to an external browser tab — mirrors what
// Aeon does for its Next.js dashboard. Returning a route here tells callers
// "navigate to this in-app instead of calling shell.openExternal".
const IN_APP_ROUTES: Record<string, string> = {
  openclaw:    '/openclaw',
  freellmapi:  '/freellmapi',
}

/**
 * If this runtime has an embedded in-app dashboard view, return the route
 * to navigate to. Otherwise null — caller should fall back to
 * `resolveLaunchUrl` + `shell.openExternal`.
 */
export function resolveInAppRoute(card: RuntimeCardUpdate): string | null {
  return IN_APP_ROUTES[card.runtimeId] ?? null
}

// ── Status explanation ──────────────────────────────────────────────────────
//
// `RuntimeCardUpdate.error` carries the detector's reason for a card's current
// status (e.g. bankr-gateway's degraded branch: "Models endpoint returned
// 429"). It is provider/health-layer text, not UI copy, so it is rendered
// verbatim — same convention as HealthStatus.message in ProviderStep — and
// deliberately not translated. This helper is the one place that decides
// whether there's a note worth showing, so StudioPage and Sidebar don't each
// duplicate the "is this non-empty" gate (and so a future detector that
// starts populating `error` on a different status just works, with no
// per-runtime special-casing).
export function runtimeNote(card: RuntimeCardUpdate): string | undefined {
  return card.error?.trim() || undefined
}

/** Button label that matches the action we'll take when clicked. */
export function actionLabel(card: RuntimeCardUpdate): string {
  if (card.status === 'running' || card.status === 'connected' || card.status === 'healthy') {
    return 'Open ↗'
  }
  if (card.status === 'installed') {
    // We have a launch URL → "Open" (opens dashboard / docs / app)
    return resolveLaunchUrl(card) ? 'Open ↗' : 'Ready'
  }
  if (card.status === 'not_installed') return 'Install'
  if (card.status === 'unreachable' || card.status === 'error') return 'Retry'
  return 'Start'
}
