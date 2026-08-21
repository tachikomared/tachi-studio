// apps/desktop/src/skills/skills.ts
//
// Lightweight skills system: a known set of "/<name>" commands the user can
// type in the chat composer. Each skill maps to a system-prompt prefix that
// gets injected when the message is sent.
//
// Future: load these from SKILL.md files in user's workspace.

export interface Skill {
  id: string
  name: string
  hint: string
  /** System-prompt prefix that primes the model for this skill. */
  systemPrompt: string
  /**
   * Optional mode tag. 'github-tools' signals the chat service to attach
   * GitHub tool schemas and execute any tool_use responses from the model
   * against the github-tools service.
   */
  mode?: 'github-tools'
}

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'tdd',
    name: 'TDD',
    hint: 'Write a failing test, then implement minimally',
    systemPrompt:
      'You follow strict Test-Driven Development. Always: 1) write the failing test first, 2) run it to confirm failure, 3) implement the minimum code to pass, 4) refactor. Show each step explicitly.',
  },
  {
    id: 'diagnose',
    name: 'Diagnose',
    hint: 'Root-cause a bug methodically',
    systemPrompt:
      'You are diagnosing a bug. Do NOT propose fixes until you state: 1) the observed symptom, 2) the smallest reproduction, 3) the actual root cause (with file:line evidence), 4) why prior assumptions failed. Only then suggest a fix.',
  },
  {
    id: 'review',
    name: 'Code Review',
    hint: 'Critical code review with severity tiers',
    systemPrompt:
      'You are doing a code review. Group feedback by severity: BLOCKER, IMPORTANT, NIT. For each finding, cite file:line, explain why it matters, and propose the specific fix. Do not nitpick style.',
  },
  {
    id: 'brainstorm',
    name: 'Brainstorm',
    hint: 'Explore 3 distinct approaches with trade-offs',
    systemPrompt:
      'You are brainstorming. Generate 3 distinctly different approaches. For each: name, one-paragraph description, key trade-offs, and when it is the right choice. End with your recommendation and why.',
  },
  {
    id: 'explain',
    name: 'Explain',
    hint: 'Explain a concept clearly with examples',
    systemPrompt:
      'Explain the concept clearly. Use plain language, then a concrete example, then where it commonly trips people up. Avoid jargon unless it earns its keep.',
  },
  {
    id: 'refactor',
    name: 'Refactor',
    hint: 'Improve code while preserving behavior',
    systemPrompt:
      'Refactor for clarity and maintainability. Preserve observable behavior. Show the before/after diff, explain each material change, and note any subtle behavior risks.',
  },
  {
    id: 'web',
    name: 'Web search',
    hint: 'Use web search tool when relevant',
    systemPrompt:
      'You have access to a web search tool. Use it when the answer depends on recent or specific information. Cite sources.',
  },
  {
    id: 'gh',
    name: 'GitHub',
    hint: 'Use GitHub tools — list repos, issues, search code, read files',
    mode: 'github-tools',
    systemPrompt:
      'You have access to GitHub tools. Use github_list_repos to see the user\'s repositories, github_list_open_issues(owner, repo) to read issues, github_search_code(query, language?) to search code, and github_get_file(owner, repo, path) to read file contents. Always call a tool when the user asks about their GitHub repos, issues, or code.',
  },
]

export function listSkills(): Skill[] { return BUILTIN_SKILLS }

export function findSkill(id: string): Skill | null {
  return BUILTIN_SKILLS.find(s => s.id === id) ?? null
}

/**
 * Parse a leading "/<skillId>" token from the message text. Returns
 * { skill, body } if matched, else null. Whitespace after the slash command
 * is consumed.
 */
export function parseSlashCommand(text: string): { skill: Skill; body: string } | null {
  const m = text.match(/^\/([a-z][a-z0-9-]{0,30})(\s+|$)/i)
  if (!m) return null
  const skill = findSkill(m[1].toLowerCase())
  if (!skill) return null
  return { skill, body: text.slice(m[0].length) }
}
