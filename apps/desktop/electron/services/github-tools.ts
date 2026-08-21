// apps/desktop/electron/services/github-tools.ts
//
// Thin GitHub REST API wrapper for chat-side tool calls.
// Uses the same keychain token as the Aeon tab (key: 'github') so both
// sides share a single OAuth token without separate auth flows.
//
// All functions throw Error with user-friendly messages on failure.
// Tokens are never included in error messages.

import { retrieveKey } from './keychain'

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getToken(): string {
  const t = retrieveKey('github')
  if (!t) throw new Error('Not connected to GitHub. Go to Settings → Connectors and connect GitHub first.')
  return t
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
  }
}

async function ghFetch(path: string): Promise<Response> {
  const token = getToken()
  const url   = path.startsWith('http') ? path : `https://api.github.com${path}`
  const res   = await fetch(url, { headers: ghHeaders(token) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // Strip any potential token echoes from the body before surfacing
    const safe = body.replace(/ghp_[A-Za-z0-9]{36}/g, '[REDACTED]').slice(0, 300)
    throw new Error(`GitHub API error (${res.status}): ${safe || res.statusText}`)
  }
  return res
}

// ── Tool: list my repos ───────────────────────────────────────────────────────

export interface GhRepo {
  full_name:   string
  description: string | null
  stars:       number
  language:    string | null
}

/**
 * List the authenticated user's 30 most recently pushed repos.
 * Maps to GET /user/repos?per_page=30&sort=updated
 */
export async function githubListMyRepos(): Promise<GhRepo[]> {
  const res  = await ghFetch('/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator')
  const data = await res.json() as Array<{
    full_name:         string
    description:       string | null
    stargazers_count:  number
    language:          string | null
  }>
  return data.map(r => ({
    full_name:   r.full_name,
    description: r.description,
    stars:       r.stargazers_count,
    language:    r.language,
  }))
}

// ── Tool: list open issues ────────────────────────────────────────────────────

export interface GhIssue {
  number: number
  title:  string
  body:   string | null
  author: string
  labels: string[]
}

/**
 * List open issues for an owner/repo.
 * Maps to GET /repos/:owner/:repo/issues?state=open
 */
export async function githubListOpenIssues(owner: string, repo: string): Promise<GhIssue[]> {
  if (!/^[\w.-]+$/.test(owner)) throw new Error(`Invalid owner: ${owner}`)
  if (!/^[\w.-]+$/.test(repo))  throw new Error(`Invalid repo: ${repo}`)

  const res  = await ghFetch(`/repos/${owner}/${repo}/issues?state=open&per_page=30`)
  const data = await res.json() as Array<{
    number:  number
    title:   string
    body:    string | null
    user:    { login: string } | null
    labels:  Array<{ name: string }>
    pull_request?: unknown  // exclude PRs
  }>
  return data
    .filter(i => !i.pull_request)  // GitHub issues endpoint includes PRs; skip them
    .map(i => ({
      number: i.number,
      title:  i.title,
      body:   i.body,
      author: i.user?.login ?? 'unknown',
      labels: i.labels.map(l => l.name),
    }))
}

// ── Tool: search code ─────────────────────────────────────────────────────────

export interface GhCodeResult {
  path:    string
  repo:    string
  snippet: string
}

/**
 * Search code across GitHub.
 * Maps to GET /search/code?q=...
 */
export async function githubSearchCode(query: string, language?: string): Promise<GhCodeResult[]> {
  if (!query.trim()) throw new Error('Search query must not be empty.')
  let q = query.trim()
  if (language) q += ` language:${language}`
  const url = `/search/code?q=${encodeURIComponent(q)}&per_page=10`
  const res  = await ghFetch(url)
  const data = await res.json() as {
    items: Array<{
      path: string
      repository: { full_name: string }
      text_matches?: Array<{ fragment?: string }>
    }>
  }
  return (data.items ?? []).map(item => ({
    path:    item.path,
    repo:    item.repository.full_name,
    snippet: item.text_matches?.[0]?.fragment ?? '',
  }))
}

// ── Tool: get file ────────────────────────────────────────────────────────────

export interface GhFile {
  content: string
  sha:     string
}

/**
 * Fetch and base64-decode a file from a GitHub repo.
 * Maps to GET /repos/:owner/:repo/contents/:path
 */
export async function githubGetFile(owner: string, repo: string, path: string): Promise<GhFile> {
  if (!/^[\w.-]+$/.test(owner)) throw new Error(`Invalid owner: ${owner}`)
  if (!/^[\w.-]+$/.test(repo))  throw new Error(`Invalid repo: ${repo}`)
  const safePath = path.replace(/\.\./g, '')  // block path traversal attempts
  const res  = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath)}`)
  const data = await res.json() as { content: string; sha: string; encoding?: string }
  if (data.encoding === 'base64') {
    const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8')
    return { content: decoded, sha: data.sha }
  }
  return { content: data.content, sha: data.sha }
}

// ── Tool schema definitions (OpenAI function-calling format) ──────────────────
// Used by the chat tool-loop to expose these tools to the model.

export const GITHUB_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: 'List the authenticated GitHub user\'s repositories, sorted by most recently updated.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_open_issues',
      description: 'List open issues for a GitHub repository (pull requests excluded).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (user or org name)' },
          repo:  { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_search_code',
      description: 'Search code across GitHub. Optionally filter by programming language.',
      parameters: {
        type: 'object',
        properties: {
          query:    { type: 'string', description: 'Search query, e.g. "useState hook"' },
          language: { type: 'string', description: 'Optional programming language filter, e.g. "typescript"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_file',
      description: 'Fetch and read the contents of a file from a GitHub repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo:  { type: 'string', description: 'Repository name' },
          path:  { type: 'string', description: 'File path within the repository, e.g. "src/index.ts"' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
  },
]

// ── Tool dispatcher ───────────────────────────────────────────────────────────
// Dispatches a tool call by name to the corresponding function.

export async function dispatchGithubTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  switch (name) {
    case 'github_list_repos': {
      const repos = await githubListMyRepos()
      return JSON.stringify(repos, null, 2)
    }
    case 'github_list_open_issues': {
      const issues = await githubListOpenIssues(args.owner, args.repo)
      return JSON.stringify(issues, null, 2)
    }
    case 'github_search_code': {
      const results = await githubSearchCode(args.query, args.language)
      return JSON.stringify(results, null, 2)
    }
    case 'github_get_file': {
      const file = await githubGetFile(args.owner, args.repo, args.path)
      return JSON.stringify(file, null, 2)
    }
    default:
      throw new Error(`Unknown GitHub tool: ${name}`)
  }
}
