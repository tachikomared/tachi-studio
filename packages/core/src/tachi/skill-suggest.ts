// packages/core/src/tachi/skill-suggest.ts
//
// Suggested skills v1 — map a cheap workspace scan to "skills worth having
// here". The electron side walks the top two directory levels of the open
// workspace and hands us three marker lists (relative paths, package.json dep
// names, file extensions); this module answers with skill ids + human reasons.
//
// The detection table below is ORIGINAL to this project: stacks were chosen
// from what the TACHI harness is actually asked to work on, and every rule /
// title / reason is our own wording. (The idea of suggesting skills from a
// declarative workspace scan is common in the ecosystem; no third-party table
// was copied.)
//
// Semantics, deliberately simple:
//   - A rule fires when ANY of its signals hits (a dep name, a path regex, or
//     a file extension). Rules are independent — several may fire at once.
//   - Output order = table order (roughly "most workspaces first").
//   - Matching is case-insensitive; paths are normalized to forward slashes.
//   - Pure function, no fs / no electron — trivially unit-testable.

/** What the workspace scan hands us. All lists may be empty, never undefined. */
export interface WorkspaceMarkers {
  /** Relative paths (files AND directories) from the top two levels of the workspace. */
  files: string[]
  /** Dependency names from package.json (dependencies + devDependencies), if present. */
  deps: string[]
  /** File extensions seen in the scan, without the leading dot (e.g. "ts", "py"). */
  languages: string[]
}

/** One suggestion the UI can show next to the installed-skills list. */
export interface SkillSuggestion {
  /** Skill id the suggestion points at (matches a bundled or registry skill id). */
  skillId: string
  /** Short human title for the suggestion row. */
  title: string
  /** Why this fired, in plain words ("Dockerfile found", "react in package.json"). */
  reason: string
  /** Always 'suggested' — distinguishes these rows from installed SkillMeta layers. */
  layer: 'suggested'
}

/** One row of the detection table. A rule fires when ANY listed signal hits. */
interface DetectRule {
  skillId: string
  title: string
  reason: string
  /** package.json dependency names, matched exactly (case-insensitive). */
  anyDep?: string[]
  /** Regexes tested against normalized (lowercased, forward-slash) relative paths. */
  anyFile?: RegExp[]
  /** File extensions without the dot (case-insensitive). */
  anyLang?: string[]
}

// ── The detection table (ours) ────────────────────────────────────────────────
// 15 rules. Keep reasons SHORT — they render as one muted line in Settings.

const DETECT_TABLE: DetectRule[] = [
  {
    skillId: 'react-review',
    title: 'React review checklist',
    reason: 'React is in package.json',
    anyDep: ['react', 'react-dom', 'preact'],
    anyLang: ['jsx', 'tsx'],
  },
  {
    skillId: 'nextjs-helper',
    title: 'Next.js conventions',
    reason: 'Next.js config or dependency detected',
    anyDep: ['next'],
    anyFile: [/(^|\/)next\.config\.(js|cjs|mjs|ts)$/],
  },
  {
    skillId: 'test-writer',
    title: 'Test authoring guide',
    reason: 'A test runner is configured (vitest / jest / playwright / mocha)',
    anyDep: ['vitest', 'jest', 'mocha', 'ava', '@playwright/test', 'cypress'],
    anyFile: [/(^|\/)(vitest|jest|playwright|cypress)\.config\.[a-z]+$/, /(^|\/)karma\.conf\.js$/],
  },
  {
    skillId: 'ci-doctor',
    title: 'CI pipeline doctor',
    reason: 'CI workflow files present',
    anyFile: [/^\.github\/workflows(\/|$)/, /(^|\/)\.gitlab-ci\.yml$/, /(^|\/)azure-pipelines\.yml$/, /(^|\/)jenkinsfile$/],
  },
  {
    skillId: 'docker-helper',
    title: 'Docker build & compose helper',
    reason: 'Dockerfile or compose file found',
    anyFile: [/(^|\/)dockerfile$/, /(^|\/)(docker-)?compose\.ya?ml$/, /(^|\/)\.dockerignore$/],
  },
  {
    skillId: 'python-review',
    title: 'Python review checklist',
    reason: 'Python project files present',
    anyFile: [/(^|\/)pyproject\.toml$/, /(^|\/)requirements[^/]*\.txt$/, /(^|\/)setup\.(py|cfg)$/, /(^|\/)pipfile$/],
    anyLang: ['py'],
  },
  {
    skillId: 'rust-review',
    title: 'Rust review checklist',
    reason: 'Cargo project detected',
    anyFile: [/(^|\/)cargo\.toml$/],
    anyLang: ['rs'],
  },
  {
    skillId: 'go-review',
    title: 'Go review checklist',
    reason: 'Go module detected',
    anyFile: [/(^|\/)go\.mod$/],
    anyLang: ['go'],
  },
  {
    skillId: 'db-migrations',
    title: 'Database migration safety',
    reason: 'An ORM / migration layout is present',
    anyDep: ['prisma', '@prisma/client', 'drizzle-orm', 'drizzle-kit', 'knex', 'typeorm', 'sequelize', 'kysely', 'mongoose'],
    anyFile: [/(^|\/)schema\.prisma$/, /(^|\/)migrations(\/|$)/, /(^|\/)alembic\.ini$/],
  },
  {
    skillId: 'electron-review',
    title: 'Electron main/renderer boundaries',
    reason: 'Electron is in package.json',
    anyDep: ['electron', 'electron-builder', 'electron-vite'],
  },
  {
    skillId: 'tailwind-helper',
    title: 'Tailwind styling conventions',
    reason: 'Tailwind config or dependency detected',
    anyDep: ['tailwindcss'],
    anyFile: [/(^|\/)tailwind\.config\.[a-z]+$/],
  },
  {
    skillId: 'api-designer',
    title: 'HTTP API design review',
    reason: 'An OpenAPI / Swagger spec is present',
    anyFile: [/(^|\/)(openapi|swagger)\.(ya?ml|json)$/],
  },
  {
    skillId: 'i18n-checker',
    title: 'i18n key hygiene',
    reason: 'A translation setup is present',
    anyDep: ['i18next', 'react-i18next', 'vue-i18n', 'next-intl'],
    anyFile: [/(^|\/)(locales|i18n)(\/|$)/],
  },
  {
    skillId: 'vue-review',
    title: 'Vue review checklist',
    reason: 'Vue is in package.json',
    anyDep: ['vue', 'nuxt'],
    anyLang: ['vue'],
  },
  {
    skillId: 'monorepo-navigator',
    title: 'Monorepo navigation',
    reason: 'Workspace/monorepo tooling detected',
    anyFile: [/(^|\/)pnpm-workspace\.yaml$/, /(^|\/)(lerna|turbo|nx)\.json$/],
  },
]

// ── Matching ──────────────────────────────────────────────────────────────────

/** Lowercase + forward slashes + no leading "./" — one canonical path shape. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/**
 * Run the detection table over the markers. Unknown / missing marker arrays are
 * treated as empty (never throws on sloppy input). Each rule contributes at
 * most one suggestion; output order follows the table.
 */
export function suggestSkills(markers: WorkspaceMarkers): SkillSuggestion[] {
  const files = Array.isArray(markers?.files) ? markers.files.filter(f => typeof f === 'string').map(normalizePath) : []
  const deps = new Set(
    Array.isArray(markers?.deps) ? markers.deps.filter(d => typeof d === 'string').map(d => d.toLowerCase()) : [],
  )
  const langs = new Set(
    Array.isArray(markers?.languages)
      ? markers.languages.filter(l => typeof l === 'string').map(l => l.toLowerCase().replace(/^\./, ''))
      : [],
  )

  const out: SkillSuggestion[] = []
  for (const rule of DETECT_TABLE) {
    const depHit = rule.anyDep?.some(d => deps.has(d)) ?? false
    const langHit = rule.anyLang?.some(l => langs.has(l)) ?? false
    const fileHit = rule.anyFile?.some(re => files.some(f => re.test(f))) ?? false
    if (depHit || langHit || fileHit) {
      out.push({ skillId: rule.skillId, title: rule.title, reason: rule.reason, layer: 'suggested' })
    }
  }
  return out
}
