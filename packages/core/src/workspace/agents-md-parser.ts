import type { AgentsMdFile, AgentsMdMeta } from './types.js'

/**
 * Hard cap for AGENTS.md size. Generous — typical files are <20KB — but
 * prevents OOM if someone drops a binary or a giant log file named AGENTS.md.
 * 5 MB also matches the cap opencode and Cursor use for the same file.
 */
export const AGENTS_MD_MAX_BYTES = 5 * 1024 * 1024

// Non-greedy (`*?`) on the YAML block so a literal `---` line in the markdown
// body doesn't get swallowed as a second frontmatter terminator. We match the
// FIRST closing `---` after the opening one.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Parse the raw contents of an AGENTS.md file at the given path.
 *
 * Accepts plain markdown or markdown prefixed with a minimal YAML-ish frontmatter
 * block delimited by `---` lines. Only four flat keys are recognised:
 *   - `profile`
 *   - `model`
 *   - `providerId`
 *   - `permissions.mode` (value must be `full` or `read-only`)
 *
 * Anything else in the frontmatter is silently ignored. Malformed frontmatter
 * (missing closing delimiter, a line without `:`, invalid enum value) falls
 * back to "treat whole file as instructions" where appropriate and accumulates
 * messages in `warnings`. A leading UTF-8 BOM is stripped before parsing.
 *
 * @throws Error if `raw.length` exceeds {@link AGENTS_MD_MAX_BYTES}.
 */
export function parseAgentsMd(path: string, raw: string): AgentsMdFile {
  if (raw.length > AGENTS_MD_MAX_BYTES) {
    throw new Error(`AGENTS.md too large: ${raw.length} bytes`)
  }

  // Strip leading UTF-8 BOM if present so frontmatter detection works.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  const warnings: string[] = []

  // No frontmatter delimiter at the very start → whole file is body.
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { path, raw, instructions: raw.trim(), meta: undefined, warnings }
  }

  const match = FRONTMATTER_RE.exec(raw)
  if (!match) {
    // Opening `---` present but no closing delimiter — treat as body, warn.
    warnings.push(
      'AGENTS.md frontmatter is missing closing --- delimiter; entire file treated as instructions.',
    )
    return { path, raw, instructions: raw.trim(), meta: undefined, warnings }
  }

  const [, yamlBlock, body] = match
  const meta: AgentsMdMeta = {}

  const lines = yamlBlock.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) {
      warnings.push(`AGENTS.md frontmatter line ignored: ${trimmed}`)
      continue
    }

    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()
    // Strip matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }

    switch (key) {
      case 'profile':
        meta.profile = value
        break
      case 'model':
        meta.model = value
        break
      case 'providerId':
        meta.providerId = value
        break
      case 'permissions.mode':
        if (value === 'full' || value === 'read-only') {
          meta.permissions = { mode: value }
        } else {
          warnings.push(
            `AGENTS.md frontmatter has invalid permissions.mode: ${value}`,
          )
        }
        break
      default:
        // Unknown key — silently ignore.
        break
    }
  }

  const hasMeta = Object.keys(meta).length > 0
  return {
    path,
    raw,
    instructions: body.trim(),
    meta: hasMeta ? meta : undefined,
    warnings,
  }
}
