import type { ProfilePermissions } from '../profiles/schema.js'

/** Parsed YAML frontmatter from an AGENTS.md file — selects a base profile and/or overrides provider/model/permissions. */
export interface AgentsMdMeta {
  profile?: string                    // name of a Profile to use as base
  model?: string                      // override model only
  providerId?: string                 // override provider only
  permissions?: ProfilePermissions
}

/** A parsed AGENTS.md file: absolute path, raw text, optional frontmatter meta, and the markdown body used as prompt overlay. */
export interface AgentsMdFile {
  path: string                        // absolute path to AGENTS.md
  raw: string                         // full file content
  /** Parsed YAML frontmatter, if any. */
  meta?: AgentsMdMeta
  /** Markdown body, becomes the prompt overlay. */
  instructions: string
  /** Non-fatal parse issues (missing closing delimiter, malformed lines, invalid enum values). Always present; empty when parse was clean. */
  warnings: string[]
}

/** A workspace root the user has opened, with an optional AGENTS.md detected at its root. */
export interface Workspace {
  rootPath: string
  agentsMd?: AgentsMdFile             // present iff AGENTS.md exists at rootPath
}
