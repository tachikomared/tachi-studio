// Pure helpers for per-message EDIT / RE-RUN / FORK (UX #5).
//
// The version stepper is a RENDER-TIME grouping: regenerate has always
// appended sibling assistant messages ("multiple alternatives, like Claude
// Desktop"), so consecutive assistant messages answering the same user turn
// ARE the versions — no store migration, no pipeline change. These helpers
// stay pure so vitest covers them without zustand/electron scaffolding.
import type { ChatMessage } from '../../store/chat.store'

export interface MessageGroup {
  /** Stable key — the id of the group's FIRST message. */
  anchorId: string
  /** All versions in arrival order; render versions[selected] (default last). */
  versions: ChatMessage[]
}

/**
 * Group a conversation's messages for rendering: every user message is its
 * own group; runs of CONSECUTIVE assistant messages collapse into one group
 * whose members are versions (regenerations) of the same answer. A streaming
 * tail message still joins its run — the renderer pins selection to the last
 * version while any member is streaming.
 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  // Only plain-text answers stack as versions: media parts (images/audio
  // appended as their own assistant messages) and COMPARE panel messages are
  // distinct content, not regenerations — hiding them behind a stepper would
  // swallow real output.
  const versionable = (m: ChatMessage): boolean =>
    typeof m.content === 'string' && !(m as { panelMembers?: unknown }).panelMembers
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (
      m.role === 'assistant' && versionable(m) &&
      last && last.versions[0].role === 'assistant' && versionable(last.versions[0])
    ) {
      last.versions.push(m)
    } else {
      groups.push({ anchorId: m.id, versions: [m] })
    }
  }
  return groups
}

/**
 * Deep-copy the messages up to AND INCLUDING `uptoId` for a forked
 * conversation. Fresh message ids (the FTS index + JSON mirror key per id —
 * reusing ids across conversations would cross-contaminate them). Returns
 * null when the id isn't found (caller shows nothing).
 */
export function sliceForFork(
  messages: ChatMessage[],
  uptoId: string,
  newId: () => string,
): ChatMessage[] | null {
  const idx = messages.findIndex(m => m.id === uptoId)
  if (idx < 0) return null
  return messages.slice(0, idx + 1).map(m => ({
    ...JSON.parse(JSON.stringify(m)) as ChatMessage,
    id: newId(),
    streaming: false,
  }))
}
