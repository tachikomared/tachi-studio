// apps/desktop/src/pages/chat/folder-settings.ts
//
// F16 — per-folder (project) settings resolution. PURE logic, no store/react
// imports, so the precedence rules are unit-testable in isolation.
//
// Precedence everywhere: explicit (per-conversation / per-send) > folder
// settings > global default. Absent settings are a strict no-op — a
// conversation outside any folder (or in a folder with nothing configured)
// behaves exactly as before this feature existed.

/** Normalized view of a folder's send-affecting settings. */
export interface FolderSendSettings {
  /** Folder instructions — PREPENDED to the outgoing system message. */
  instructions?: string
  /** Default provider adopted by NEW conversations created in this folder. */
  providerId?: string
  /** Default model (only meaningful when providerId is set). */
  model?: string
  /** Default knowledge folder (chat RAG) when the conversation attached none. */
  ragFolder?: string
}

/**
 * Structural view of a chat.store ChatFolder — kept import-free so tests (and
 * this module) never pull the zustand store / electron shims transitively.
 */
export interface FolderLike {
  systemPrompt?: string
  ragFolder?: string
  defaultProviderId?: string
  defaultModel?: string
}

/** Map a ChatFolder(-shaped) object onto FolderSendSettings. Null-safe. */
export function toFolderSendSettings(f: FolderLike | null | undefined): FolderSendSettings | null {
  if (!f) return null
  return {
    instructions: f.systemPrompt,
    providerId:   f.defaultProviderId,
    model:        f.defaultModel,
    ragFolder:    f.ragFolder,
  }
}

/**
 * Compose the outgoing system message: folder instructions FIRST, then any
 * additional parts (e.g. a slash-skill system prompt). Whitespace-only parts
 * are dropped; returns undefined when nothing survives (send payloads treat
 * undefined as "no system message" — the pre-F16 behavior).
 */
export function composeSystemMessage(
  folder: FolderSendSettings | null | undefined,
  ...parts: Array<string | null | undefined>
): string | undefined {
  const all = [folder?.instructions, ...parts]
    .map(p => p?.trim())
    .filter((p): p is string => !!p && p.length > 0)
  return all.length > 0 ? all.join('\n\n') : undefined
}

/**
 * Effective knowledge folder for a send: an explicitly attached folder always
 * wins; otherwise the folder default; otherwise none.
 */
export function effectiveRagFolder(
  explicit: string | null | undefined,
  folder?: FolderSendSettings | null,
): string | undefined {
  return explicit || folder?.ragFolder || undefined
}

export interface NewConversationTarget {
  providerId: string
  model: string
}

/**
 * Provider/model a NEW conversation should adopt when created inside a folder.
 * Rules:
 *  - No folder / no folder providerId → the caller's fallback, unchanged.
 *    (A stray folder `model` WITHOUT a provider is ignored — a bare model id
 *    is ambiguous across providers.)
 *  - Folder providerId set → that provider; the folder model if set, else
 *    'auto' (the app-wide "let the provider route" sentinel).
 */
export function effectiveNewConversationTarget(
  folder: FolderSendSettings | null | undefined,
  fallback: NewConversationTarget,
): NewConversationTarget {
  if (!folder?.providerId?.trim()) return fallback
  return {
    providerId: folder.providerId,
    model:      folder.model?.trim() || 'auto',
  }
}
