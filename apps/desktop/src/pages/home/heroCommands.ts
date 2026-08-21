// apps/desktop/src/pages/home/heroCommands.ts
//
// HOME hero composer — the slash layer's capability wiring, kept PURE (no React,
// no store, no window) so it is unit-testable in the node env exactly like the
// registry it feeds.
//
// The hero speaks the CHAT surface's vocabulary: the same commands, the same
// popup, the same parser, so a "/" learned on Home is the "/" that works in the
// Chat tab. What differs is that Home has NO OPEN CONVERSATION, so:
//   - conversation-bound commands (/compact, /rewind) are deliberately left
//     UNWIRED — the registry then reports its standard "isn't available here"
//     hint instead of pretending something happened;
//   - /new and /search ROUTE INTO A CHAT through the hero's own send path (a
//     fresh conversation seeded with the text) — the hero already works that
//     way for its quick-action chips.
//
// @module home/heroCommands

import type {
  CommandCaps, CommandSurface, CommandT, CostSummaryLike, MemoryFactLike,
} from '../../lib/commands/registry'

/** The hero composer is the Chat surface (same commands, same hints). */
export const HERO_SURFACE: CommandSurface = 'chat'

/** Everything the hero can honestly back. Injected, so this file stays pure. */
export interface HeroCommandDeps {
  t: CommandT
  /** Open a fresh chat with nothing typed (the "New chat" action). */
  startNewChat:    () => void
  /** Open a fresh chat with `text` waiting in its composer. */
  openChatWith:    (text: string) => void
  /** "provider · model" the next chat will use. */
  describeModel:   () => string
  /** Reveal the global command palette (where models/providers are picked). */
  openModelPicker: () => void
  costSummary:     () => Promise<CostSummaryLike>
  listFacts:       () => Promise<MemoryFactLike[]>
  addFact:         (text: string) => Promise<boolean>
}

/**
 * Bind the hero's capabilities for the shared command registry.
 *
 * Unwired ON PURPOSE (each would need a live conversation or a live send, and
 * the registry's honest answer beats a fake one):
 *   `compact`, `rewind`, `sessionSpend` — nothing is open yet to fold or rewind;
 *   `setModel` — the model is a per-conversation setting, so `/model <name>`
 *   points at the picker instead of silently writing nowhere.
 */
export function buildHeroCaps(deps: HeroCommandDeps): CommandCaps {
  return {
    surface: HERO_SURFACE,
    t: deps.t,
    newConversation: deps.startNewChat,
    describeModel:   deps.describeModel,
    openModelPicker: deps.openModelPicker,
    costSummary:     deps.costSummary,
    listFacts:       deps.listFacts,
    addFact:         deps.addFact,
    // The hero has no send path of its own, so /search hands the WHOLE command
    // to a new chat — the surface that owns web search — instead of dropping it.
    webSearch: async (query: string) => {
      deps.openChatWith(`/search ${query}`)
      return { ok: true }
    },
  }
}
