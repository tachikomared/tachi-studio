// apps/desktop/src/types/connectors.ts
//
// Generic Connector framework types.
// Architecture mirrors the web-search tool pattern: connectors are registered
// server-side (main process) and surface status + disconnect via IPC.
// More connectors (Notion, Linear, etc.) can be added to the registry without
// touching this interface.

export interface Connector {
  /** Stable machine-readable identifier, e.g. 'github' */
  id: string
  /** Human-readable display name */
  name: string
  /** One-line description shown in the settings card */
  description: string
  /** Connection status */
  authStatus: 'connected' | 'disconnected' | 'error'
  /** Authenticated identity (e.g. '@smolemaru') — only present when connected */
  connectedAs?: string
}
