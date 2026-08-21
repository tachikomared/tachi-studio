// apps/desktop/electron/services/mcp-catalog.ts
//
// The curated MCP marketplace catalog (USER-PAINS T11 — "one-click MCP install,
// zero JSON"). This is STATIC DATA we ship: a hand-vetted list of popular MCP
// servers with the exact launch command, the argument slots the user must fill
// (a folder, a connection string) and the env vars each server needs.
//
// Nothing here installs, downloads or launches anything. The catalog is inert
// data; a server only ever starts after the user clicks INSTALL in
// Settings → MCP Servers and then clicks START (or flips ENABLED).
//
// Field notes
// -----------
// `command`/`args`      exactly what gets spawned (stdio transport). Args may
//                       contain `<slot>` placeholder tokens, resolved from the
//                       user's answers before the config is persisted.
// `env`                 declared env vars. `secret: true` values NEVER touch
//                       mcp-servers.json — they go to the encrypted keychain
//                       (see mcp-manager.persistConfigs / resolveServerEnv).
// `requiresNetwork`     true  → the server reaches the public internet, so it is
//                              refused while PRIVATE MODE is on (egress-policy
//                              checkMcpServerEgress).
//                       false → purely local (a folder, a sqlite file, an
//                              in-memory graph) and therefore allowed in PRIVATE
//                              MODE. Anything ambiguous (a DB connection string
//                              that COULD point at a remote host) is marked
//                              `true` — the paranoid default this codebase uses
//                              everywhere else for egress classification.
// `runner`              which toolchain spawns it — 'npx' (Node) or 'uvx'
//                       (Python/uv). Surfaced in the UI as a caution note: both
//                       fetch and execute third-party code from a public
//                       registry on first run.
//
// `name` and `description` are DATA, not UI chrome: they are proper nouns and
// upstream package blurbs (the same strings npm shows), so they ship in English
// only — exactly like model names/descriptions from the HF catalog. Every piece
// of surrounding UI text (headings, buttons, warnings, tag labels) goes through
// react-i18next in the normal way.
//
// This module is PURE — no electron, no fs — so the renderer, the main process
// and unit tests can all import it directly.

/** A user-supplied value substituted into `args` before launch. */
export interface McpCatalogSlot {
  /** Placeholder token as it literally appears in `args`, e.g. '<path>'. */
  token:     string
  /** Short English hint shown next to the input. */
  label:     string
  /** 'path' renders a folder picker alongside the text field. */
  kind:      'path' | 'text'
  required:  boolean
  /** Prefilled value, if a sane default exists. */
  default?:  string
}

/** An environment variable the server needs to run. */
export interface McpCatalogEnvVar {
  key:       string
  label:     string
  required:  boolean
  /** Secrets are stored in the OS keychain, never in the plaintext config file. */
  secret:    boolean
}

export type McpRunner = 'npx' | 'uvx'

export interface McpCatalogEntry {
  id:              string
  name:            string
  description:     string
  /** npm (or PyPI, for uvx entries) package that gets fetched on first launch. */
  packageName:     string
  runner:          McpRunner
  command:         string
  args:            string[]
  slots?:          McpCatalogSlot[]
  env?:            McpCatalogEnvVar[]
  tags:            string[]
  requiresNetwork: boolean
  homepage:        string
}

/** Tag vocabulary — the UI translates these slugs via `settings:mcp.tags.<slug>`. */
export const MCP_CATALOG_TAGS = [
  'official', 'local', 'files', 'search', 'web', 'browser', 'dev',
  'database', 'productivity', 'memory', 'reasoning', 'design', 'cloud',
] as const

export type McpCatalogTag = (typeof MCP_CATALOG_TAGS)[number]

// ─── The catalog ──────────────────────────────────────────────────────────────
//
// Package names + publishers verified against the npm registry on 2026-07-25.

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // ── Local-only (allowed in PRIVATE MODE) ───────────────────────────────────
  {
    id:          'filesystem',
    name:        'Filesystem',
    description: 'Read, write and search files inside one directory you choose. The single most-used MCP server.',
    packageName: '@modelcontextprotocol/server-filesystem',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-filesystem', '<path>'],
    slots: [
      { token: '<path>', label: 'Directory the server may access', kind: 'path', required: true },
    ],
    tags:            ['official', 'local', 'files'],
    requiresNetwork: false,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id:          'memory',
    name:        'Memory',
    description: 'A persistent knowledge graph the model can write facts into and query back later. Stored locally as JSON.',
    packageName: '@modelcontextprotocol/server-memory',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-memory'],
    env: [
      { key: 'MEMORY_FILE_PATH', label: 'Where to keep the graph file (optional)', required: false, secret: false },
    ],
    tags:            ['official', 'local', 'memory'],
    requiresNetwork: false,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id:          'sequential-thinking',
    name:        'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad. No API key, no network — pure local tool.',
    packageName: '@modelcontextprotocol/server-sequential-thinking',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tags:            ['official', 'local', 'reasoning'],
    requiresNetwork: false,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id:          'sqlite',
    name:        'SQLite',
    description: 'Query and modify a local SQLite database file — list tables, describe schemas, run SQL.',
    packageName: 'mcp-server-sqlite-npx',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', 'mcp-server-sqlite-npx', '<db>'],
    slots: [
      { token: '<db>', label: 'Path to the .db / .sqlite file', kind: 'path', required: true },
    ],
    tags:            ['local', 'database'],
    requiresNetwork: false,
    homepage:        'https://www.npmjs.com/package/mcp-server-sqlite-npx',
  },
  {
    id:          'git',
    name:        'Git',
    description: 'Read and operate a local git repository: status, diff, log, branches, commits.',
    packageName: 'mcp-server-git',
    runner:      'uvx',
    command:     'uvx',
    args:        ['mcp-server-git', '--repository', '<repo>'],
    slots: [
      { token: '<repo>', label: 'Path to the git repository', kind: 'path', required: true },
    ],
    tags:            ['official', 'local', 'dev'],
    requiresNetwork: false,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id:          'everything',
    name:        'Everything (reference)',
    description: 'The reference server exercising every MCP feature — prompts, resources, sampling. Useful for testing your setup.',
    packageName: '@modelcontextprotocol/server-everything',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-everything'],
    tags:            ['official', 'local', 'dev'],
    requiresNetwork: false,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },

  // ── Web / search (network) ─────────────────────────────────────────────────
  {
    id:          'fetch',
    name:        'Fetch',
    description: 'Fetch a URL and convert the page to markdown for the model to read.',
    packageName: 'mcp-server-fetch',
    runner:      'uvx',
    command:     'uvx',
    args:        ['mcp-server-fetch'],
    tags:            ['official', 'web'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id:          'brave-search',
    name:        'Brave Search',
    description: 'Web and local search through the Brave Search API. Free tier available.',
    packageName: '@modelcontextprotocol/server-brave-search',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-brave-search'],
    env: [
      { key: 'BRAVE_API_KEY', label: 'Brave Search API key', required: true, secret: true },
    ],
    tags:            ['official', 'search', 'web'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id:          'tavily',
    name:        'Tavily',
    description: 'Search, extract, map and crawl the web with the Tavily API — built for agent retrieval.',
    packageName: 'tavily-mcp',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', 'tavily-mcp'],
    env: [
      { key: 'TAVILY_API_KEY', label: 'Tavily API key', required: true, secret: true },
    ],
    tags:            ['search', 'web'],
    requiresNetwork: true,
    homepage:        'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id:          'exa',
    name:        'Exa Search',
    description: 'Neural/semantic web search plus company and paper research through the Exa API.',
    packageName: 'exa-mcp-server',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', 'exa-mcp-server'],
    env: [
      { key: 'EXA_API_KEY', label: 'Exa API key', required: true, secret: true },
    ],
    tags:            ['search', 'web'],
    requiresNetwork: true,
    homepage:        'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    id:          'firecrawl',
    name:        'Firecrawl',
    description: 'Scrape, crawl and structure whole websites into clean markdown or JSON.',
    packageName: 'firecrawl-mcp',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', 'firecrawl-mcp'],
    env: [
      { key: 'FIRECRAWL_API_KEY', label: 'Firecrawl API key', required: true, secret: true },
    ],
    tags:            ['web', 'search'],
    requiresNetwork: true,
    homepage:        'https://github.com/firecrawl/firecrawl-mcp-server',
  },
  {
    id:          'context7',
    name:        'Context7',
    description: 'Up-to-date documentation and code examples for thousands of libraries, fetched on demand.',
    packageName: '@upstash/context7-mcp',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@upstash/context7-mcp'],
    env: [
      { key: 'CONTEXT7_API_KEY', label: 'Context7 API key (optional, raises rate limits)', required: false, secret: true },
    ],
    tags:            ['dev', 'search'],
    requiresNetwork: true,
    homepage:        'https://github.com/upstash/context7',
  },

  // ── Browser automation (network) ───────────────────────────────────────────
  {
    id:          'playwright',
    name:        'Playwright',
    description: "Drive a real browser through Playwright's accessibility tree — navigate, click, type, snapshot.",
    packageName: '@playwright/mcp',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@playwright/mcp@latest'],
    tags:            ['browser', 'web'],
    requiresNetwork: true,
    homepage:        'https://github.com/microsoft/playwright-mcp',
  },
  {
    id:          'puppeteer',
    name:        'Puppeteer',
    description: 'Headless Chrome automation: navigate, screenshot, click and evaluate JavaScript on a page.',
    packageName: '@modelcontextprotocol/server-puppeteer',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-puppeteer'],
    tags:            ['official', 'browser', 'web'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },

  // ── Developer platforms (network) ──────────────────────────────────────────
  {
    id:          'github',
    name:        'GitHub',
    description: 'Repositories, issues, pull requests, code search and file commits through the GitHub API.',
    packageName: '@modelcontextprotocol/server-github',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-github'],
    env: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', required: true, secret: true },
    ],
    tags:            ['official', 'dev', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id:          'gitlab',
    name:        'GitLab',
    description: 'Projects, issues, merge requests and file operations against GitLab (SaaS or self-hosted).',
    packageName: '@modelcontextprotocol/server-gitlab',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-gitlab'],
    env: [
      { key: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'GitLab personal access token', required: true,  secret: true  },
      { key: 'GITLAB_API_URL',               label: 'API URL (self-hosted instances)', required: false, secret: false },
    ],
    tags:            ['official', 'dev', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
  },
  {
    id:          'sentry',
    name:        'Sentry',
    description: 'Pull issues, events and stack traces from Sentry so the agent can debug against real errors.',
    packageName: '@sentry/mcp-server',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@sentry/mcp-server'],
    env: [
      { key: 'SENTRY_ACCESS_TOKEN', label: 'Sentry user auth token',            required: true,  secret: true  },
      { key: 'SENTRY_HOST',         label: 'Host (self-hosted Sentry, optional)', required: false, secret: false },
    ],
    tags:            ['dev', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/getsentry/sentry-mcp',
  },
  {
    id:          'figma',
    name:        'Figma',
    description: 'Read Figma files, frames and layout data so the model can implement a design faithfully.',
    packageName: 'figma-developer-mcp',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', 'figma-developer-mcp', '--stdio'],
    env: [
      { key: 'FIGMA_API_KEY', label: 'Figma personal access token', required: true, secret: true },
    ],
    tags:            ['design', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/GLips/Figma-Context-MCP',
  },

  // ── Productivity / SaaS (network) ──────────────────────────────────────────
  {
    id:          'slack',
    name:        'Slack',
    description: 'List channels, read history and post messages in a Slack workspace.',
    packageName: '@modelcontextprotocol/server-slack',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-slack'],
    env: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token (xoxb-…)', required: true, secret: true  },
      { key: 'SLACK_TEAM_ID',   label: 'Slack team ID (T…)',       required: true, secret: false },
    ],
    tags:            ['official', 'productivity', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id:          'notion',
    name:        'Notion',
    description: 'Search, read, create and update Notion pages and databases through the official Notion MCP server.',
    packageName: '@notionhq/notion-mcp-server',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@notionhq/notion-mcp-server'],
    env: [
      { key: 'NOTION_TOKEN', label: 'Notion integration token (ntn_…)', required: true, secret: true },
    ],
    tags:            ['productivity', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id:          'google-drive',
    name:        'Google Drive',
    description: 'Search Drive and read documents, spreadsheets and slides as text.',
    packageName: '@modelcontextprotocol/server-gdrive',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-gdrive'],
    env: [
      { key: 'GDRIVE_CREDENTIALS_PATH', label: 'Path to the saved OAuth credentials file', required: true, secret: false },
    ],
    tags:            ['official', 'productivity', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
  },
  {
    id:          'google-maps',
    name:        'Google Maps',
    description: 'Geocoding, places search, directions and distance matrices from the Google Maps API.',
    packageName: '@modelcontextprotocol/server-google-maps',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-google-maps'],
    env: [
      { key: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API key', required: true, secret: true },
    ],
    tags:            ['official', 'search', 'cloud'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
  },

  // ── Databases (connection string may point anywhere → treated as network) ──
  {
    id:          'postgres',
    name:        'PostgreSQL',
    description: 'Read-only SQL access to a Postgres database, with schema introspection.',
    packageName: '@modelcontextprotocol/server-postgres',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-postgres', '<url>'],
    slots: [
      { token: '<url>', label: 'Connection string', kind: 'text', required: true, default: 'postgresql://localhost/mydb' },
    ],
    tags:            ['official', 'database'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id:          'redis',
    name:        'Redis',
    description: 'Get, set, delete and scan keys in a Redis instance.',
    packageName: '@modelcontextprotocol/server-redis',
    runner:      'npx',
    command:     'npx',
    args:        ['-y', '@modelcontextprotocol/server-redis', '<url>'],
    slots: [
      { token: '<url>', label: 'Redis URL', kind: 'text', required: true, default: 'redis://localhost:6379' },
    ],
    tags:            ['official', 'database'],
    requiresNetwork: true,
    homepage:        'https://github.com/modelcontextprotocol/servers/tree/main/src/redis',
  },
] as const

// ─── Pure helpers (used by the renderer, the IPC layer and the tests) ─────────

/** Look one entry up by id. */
export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find(e => e.id === id)
}

/**
 * Free-text + tag search over the catalog. Matching is case-insensitive across
 * id / name / description / packageName / tags; an empty query matches all.
 * Results keep catalog order (curated, so "official + local" surfaces first).
 */
export function searchCatalog(
  query: string,
  tag?: string | null,
): McpCatalogEntry[] {
  const q = query.trim().toLowerCase()
  return MCP_CATALOG.filter(e => {
    if (tag && !e.tags.includes(tag)) return false
    if (!q) return true
    return (
      e.id.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.packageName.toLowerCase().includes(q) ||
      e.tags.some(t => t.includes(q))
    )
  })
}

/**
 * Substitute the user's slot answers into the entry's args. A missing REQUIRED
 * slot throws (the caller must validate first); a missing optional slot drops
 * the argument entirely so we never spawn a server with a literal '<path>'.
 * Pure — exported for unit tests.
 */
export function resolveCatalogArgs(
  entry: McpCatalogEntry,
  answers: Record<string, string>,
): string[] {
  const out: string[] = []
  for (const arg of entry.args) {
    const slot = entry.slots?.find(s => s.token === arg)
    if (!slot) { out.push(arg); continue }
    const value = (answers[slot.token] ?? slot.default ?? '').trim()
    if (!value) {
      if (slot.required) {
        throw new Error(`MCP catalog entry "${entry.id}" requires a value for ${slot.token} (${slot.label})`)
      }
      continue // optional and unanswered → omit the arg
    }
    out.push(value)
  }
  return out
}

/**
 * Split the user's env answers into the plaintext half (persisted in
 * mcp-servers.json) and the secret half (persisted in the OS keychain).
 * Unknown keys are treated as plaintext; blank values are dropped so an
 * untouched optional field never becomes `KEY=""`. Pure — unit tested.
 */
export function splitCatalogEnv(
  entry: McpCatalogEntry,
  answers: Record<string, string>,
): { env: Record<string, string>; secrets: Record<string, string> } {
  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const [key, raw] of Object.entries(answers)) {
    const value = (raw ?? '').trim()
    if (!value) continue
    const declared = entry.env?.find(v => v.key === key)
    if (declared?.secret) secrets[key] = value
    else env[key] = value
  }
  return { env, secrets }
}

/**
 * Which required inputs are still blank. Returns slot tokens and env keys so the
 * UI can block INSTALL with a precise message. Pure — unit tested.
 */
export function missingRequiredInputs(
  entry: McpCatalogEntry,
  slotAnswers: Record<string, string>,
  envAnswers: Record<string, string>,
): string[] {
  const missing: string[] = []
  for (const slot of entry.slots ?? []) {
    if (!slot.required) continue
    if (!(slotAnswers[slot.token] ?? slot.default ?? '').trim()) missing.push(slot.token)
  }
  for (const v of entry.env ?? []) {
    if (!v.required) continue
    if (!(envAnswers[v.key] ?? '').trim()) missing.push(v.key)
  }
  return missing
}
