// apps/desktop/electron/services/aeon-service.ts
//
// Native GitHub OAuth Device Flow + REST API.
// No gh CLI dependency — works out of the box for non-technical users.
//
// GitHub OAuth Device Flow client_id.
// Default uses the gh CLI's well-known PUBLIC client_id (documented at
// https://github.com/cli/cli/blob/trunk/internal/authflow/flow.go) so the
// Aeon tab works out of the box without users registering their own OAuth app.
// On the OAuth consent screen GitHub will show "GitHub CLI" as the app name.
// To brand the consent screen as TachiDesk instead, register an OAuth app at
// https://github.com/settings/applications/new and set process.env.TACHI_GITHUB_CLIENT_ID
// to your app's Client ID. Device flow doesn't require a client secret.
const TACHI_GITHUB_CLIENT_ID =
  process.env.TACHI_GITHUB_CLIENT_ID ?? '178c6fc778ccc68e1d6a'

const GITHUB_SCOPE = 'repo,workflow'
const UPSTREAM_REPO = 'aaronjmars/aeon'

// ── Validation helpers ────────────────────────────────────────────────────────
const OWNER_RE      = /^[\w.-]+$/
const WORKFLOW_RE   = /^[\w./-]+$/
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

function validateOwner(owner: string): string {
  if (!OWNER_RE.test(owner)) throw new Error(`Invalid owner: ${owner}`)
  return owner
}
function validateWorkflowPath(path: string): string {
  if (!WORKFLOW_RE.test(path)) throw new Error(`Invalid workflowPath: ${path}`)
  return path
}
function validateSecretName(name: string): string {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`)
  return name
}

// ── Keychain import ───────────────────────────────────────────────────────────
import { storeKey, retrieveKey } from './keychain'

// ── YAML (for parsing workflow_dispatch inputs) ───────────────────────────────
//
// R8b: `yaml` is loaded on first parse, not at boot — 13.8 ms of the 1317 ms
// pre-STARTUP_T0 prelude, shared with role-registry.ts / provider-registry.ts
// (whichever parses first pays; all three defer, so none does at boot). Bare
// specifier ⇒ `require()` is allowed (noRuntimeRelativeRequire.test.ts) and
// keeps every parse call site synchronous.
function parseYaml(text: string): unknown {
  const { parse } = require('yaml') as typeof import('yaml')
  return parse(text)
}

// ── Sodium (lazy init) ────────────────────────────────────────────────────────
//
// R8b: `libsodium-wrappers` costs 12.4 ms at boot for a module used by exactly
// one function (setSecret). ensureSodium() was ALREADY the mandatory async gate
// in front of every sodium call, so the dynamic import slots straight into it
// and now returns the namespace instead of leaving it to a module binding.
type Sodium = typeof import('libsodium-wrappers')['default']
let sodiumInstance: Sodium | null = null
async function ensureSodium(): Promise<Sodium> {
  if (!sodiumInstance) {
    const mod = await import('libsodium-wrappers')
    const s = mod.default
    await s.ready
    sodiumInstance = s
  }
  return sodiumInstance
}

// ── GitHub auth token helpers ─────────────────────────────────────────────────
function getStoredToken(): string | null {
  return retrieveKey('github')
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken()
  if (!token) throw new Error('Not authenticated with GitHub')
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function ghFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status}: ${body || res.statusText}`)
  }
  return res
}

// ── Public types ──────────────────────────────────────────────────────────────
export interface GhStatus {
  installed:     boolean
  authenticated: boolean
  username?:     string
  ghVersion?:    string
}

export interface ForkStatus {
  forked:         boolean
  owner?:         string
  cloneUrl?:      string
  localPath?:     string
  defaultBranch?: string
}

export interface WorkflowSummary {
  id:    number
  name:  string
  path:  string
  state: 'active' | 'disabled_inactivity' | 'disabled_manually'
}

export interface RunSummary {
  id:          number
  name:        string
  status:      'queued' | 'in_progress' | 'completed' | string
  conclusion?: 'success' | 'failure' | 'cancelled' | null
  created_at:  string
  updated_at:  string
  html_url:    string
  workflow_id: number
}

// ── ghStatus ──────────────────────────────────────────────────────────────────
/**
 * Check whether a GitHub token is stored and still valid.
 * Returns { installed: true } always (gh CLI no longer needed).
 */
export async function ghStatus(): Promise<GhStatus> {
  const token = getStoredToken()
  if (!token) return { installed: true, authenticated: false, ghVersion: 'native-oauth' }

  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) return { installed: true, authenticated: false, ghVersion: 'native-oauth' }
    const data = await res.json() as { login: string }
    return { installed: true, authenticated: true, username: data.login, ghVersion: 'native-oauth' }
  } catch {
    return { installed: true, authenticated: false, ghVersion: 'native-oauth' }
  }
}

// ── Device Flow ───────────────────────────────────────────────────────────────
export interface DeviceCodePayload {
  code:            string   // user_code, e.g. "ABCD-1234"
  verificationUri: string   // https://github.com/activate
}

/**
 * Start the GitHub Device Flow.
 * - Calls onCode with the user_code + verification URL so AuthCard can display them.
 * - Polls until the user approves or the signal fires / expires_in elapses.
 * - On success stores the token via storeKey('github', ...).
 */
export async function ghLogin(
  onCode: (payload: DeviceCodePayload) => void,
  signal:  AbortSignal,
): Promise<void> {
  // Step 1 — request device + user codes
  const codeRes = await fetch('https://github.com/login/device/code', {
    method:  'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: TACHI_GITHUB_CLIENT_ID, scope: GITHUB_SCOPE }),
  })
  if (!codeRes.ok) {
    const body = await codeRes.text().catch(() => '')
    throw new Error(`Device code request failed (${codeRes.status}): ${body}`)
  }
  const codeData = await codeRes.json() as {
    device_code:      string
    user_code:        string
    verification_uri: string
    interval:         number   // seconds
    expires_in:       number   // seconds
  }

  const { device_code, user_code, verification_uri, interval, expires_in } = codeData

  // Notify the renderer
  onCode({ code: user_code, verificationUri: verification_uri })

  // Step 2 — poll for access token
  let pollIntervalSecs = interval ?? 5
  const expiresAt = Date.now() + (expires_in ?? 900) * 1000

  while (true) {
    if (signal.aborted) throw new Error('Login cancelled')
    if (Date.now() > expiresAt) throw new Error('Device flow expired — please try again')

    // Wait the required interval
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, pollIntervalSecs * 1000)
      signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Login cancelled')) }, { once: true })
    })

    if (signal.aborted) throw new Error('Login cancelled')

    const pollRes = await fetch('https://github.com/login/oauth/access_token', {
      method:  'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:   TACHI_GITHUB_CLIENT_ID,
        device_code: device_code,
        grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    if (!pollRes.ok) continue   // transient network issue — retry

    const pollData = await pollRes.json() as {
      access_token?: string
      error?:        string
      interval?:     number
    }

    if (pollData.access_token) {
      storeKey('github', pollData.access_token)
      return
    }

    switch (pollData.error) {
      case 'authorization_pending':
        // Normal — keep polling at current interval
        break
      case 'slow_down':
        // GitHub asking us to slow down — add 5 seconds as per spec
        pollIntervalSecs = (pollData.interval ?? pollIntervalSecs) + 5
        break
      case 'expired_token':
        throw new Error('Device code expired — please try again')
      case 'access_denied':
        throw new Error('Access denied — you declined the GitHub authorization request')
      default:
        throw new Error(`GitHub OAuth error: ${pollData.error ?? JSON.stringify(pollData)}`)
    }
  }
}

// ── Fork detection & creation ─────────────────────────────────────────────────
export async function detectFork(): Promise<ForkStatus> {
  const res = await ghFetch('/user')
  const user = await res.json() as { login: string }
  const owner = user.login
  if (!owner) return { forked: false }

  try {
    const repoRes = await ghFetch(`/repos/${validateOwner(owner)}/aeon`)
    const data = await repoRes.json() as { clone_url: string; default_branch: string }
    return {
      forked: true,
      owner,
      cloneUrl: data.clone_url,
      defaultBranch: data.default_branch,
    }
  } catch {
    return { forked: false, owner }
  }
}

/**
 * Fork aaronjmars/aeon to the user's account (idempotent).
 */
export async function forkAeon(): Promise<ForkStatus> {
  await ghFetch(`/repos/${UPSTREAM_REPO}/forks`, {
    method: 'POST',
    body: JSON.stringify({ default_branch_only: false }),
  })
  // GitHub forks are async — wait a moment then detect
  await new Promise(r => setTimeout(r, 3000))
  return detectFork()
}

// ── Workflows ─────────────────────────────────────────────────────────────────
export async function listWorkflows(owner: string): Promise<WorkflowSummary[]> {
  const res  = await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/workflows?per_page=100`)
  const data = await res.json() as { workflows: WorkflowSummary[] }
  return data.workflows.map(w => ({
    id:    w.id,
    name:  w.name,
    path:  w.path,
    state: w.state,
  }))
}

// ── Workflow dispatch inputs schema ───────────────────────────────────────────
export type WorkflowInputType = 'string' | 'choice' | 'boolean' | 'environment' | 'number'

export interface WorkflowInputSpec {
  name:         string
  type:         WorkflowInputType
  description?: string
  required?:    boolean
  default?:     string
  options?:     string[]   // for type === 'choice'
}

/**
 * Fetch a workflow's `workflow_dispatch.inputs` schema by downloading the
 * raw YAML via the contents API and parsing it. GitHub's
 * `/actions/workflows/:id` endpoint does NOT return input definitions, so
 * we have to read the source file ourselves.
 *
 * Used by AeonTaskComposer to render a dynamic form matching whatever
 * inputs the selected skill workflow declares (otherwise dispatching with
 * the wrong set causes a 422 "Required input X not provided").
 */
export async function getWorkflowInputs(
  owner: string,
  workflowPath: string,
): Promise<WorkflowInputSpec[]> {
  const path = validateWorkflowPath(workflowPath)
  const res = await ghFetch(`/repos/${validateOwner(owner)}/aeon/contents/${encodeURIComponent(path)}`)
  const data = await res.json() as { content?: string; encoding?: string }
  if (!data.content) return []
  // GitHub returns base64 with newlines every 60 chars
  const yamlText = Buffer.from(data.content, 'base64').toString('utf-8')
  const doc = parseYaml(yamlText) as
    | { on?: { workflow_dispatch?: { inputs?: Record<string, Partial<WorkflowInputSpec> & { options?: string[] }> } } }
    | null

  // The `on:` key is sometimes parsed as a boolean (`true`) because YAML
  // historically aliases "on" to true. Tolerate both shapes.
  const onBlock =
    (doc as any)?.on ??
    (doc as any)?.['on'] ??
    (doc as any)?.True ??
    (doc as any)?.[true as unknown as string]
  const inputs = onBlock?.workflow_dispatch?.inputs
  if (!inputs || typeof inputs !== 'object') return []

  return Object.entries(inputs).map(([name, def]) => {
    const rawType = (def as any)?.type
    const type: WorkflowInputType =
      rawType === 'choice'      ? 'choice'
      : rawType === 'boolean'    ? 'boolean'
      : rawType === 'environment'? 'environment'
      : rawType === 'number'     ? 'number'
      :                            'string'
    return {
      name,
      type,
      description: (def as any)?.description,
      required:    (def as any)?.required === true,
      default:     (def as any)?.default != null ? String((def as any).default) : undefined,
      options:     Array.isArray((def as any)?.options) ? (def as any).options.map(String) : undefined,
    }
  })
}

/**
 * List the subdirectories under `skills/` in the user's fork. Aeon's
 * convention is that each subdirectory is a callable skill, and the
 * `aeon.yml` workflow takes a `skill` input naming one of them. We surface
 * the list as a dropdown so users don't have to guess names.
 */
export async function listSkillDirs(owner: string): Promise<string[]> {
  try {
    const res = await ghFetch(`/repos/${validateOwner(owner)}/aeon/contents/skills`)
    const items = await res.json() as Array<{ name: string; type: 'dir' | 'file' | 'symlink' | 'submodule' }>
    if (!Array.isArray(items)) return []
    return items
      .filter(it => it.type === 'dir')
      .map(it => it.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (err: any) {
    // 404 → no skills/ directory in this fork (older Aeon variants). Return empty.
    if (String(err?.message ?? '').includes('404')) return []
    throw err
  }
}

// ── Actions permissions ───────────────────────────────────────────────────────
export interface ActionsPermissions {
  enabled: boolean
  allowed_actions?: 'all' | 'local_only' | 'selected'
}

/**
 * Read the current Actions permissions for the fork. GitHub disables Actions
 * on freshly created forks for security reasons, which is why
 * `listWorkflows` comes back empty even though .github/workflows/*.yml exist
 * in the fork's filesystem.
 */
export async function getActionsPermissions(owner: string): Promise<ActionsPermissions> {
  const res = await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/permissions`)
  return await res.json() as ActionsPermissions
}

/**
 * Enable GitHub Actions on the fork and allow all actions. This is what the
 * green "I understand my workflows, go ahead and enable them" button does on
 * github.com — without this, the /actions/workflows endpoint returns an
 * empty list even though the yml files exist in the repo.
 *
 * Endpoint: PUT /repos/{owner}/{repo}/actions/permissions
 */
export async function enableActions(owner: string): Promise<void> {
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, allowed_actions: 'all' }),
  })
}

/**
 * Sync the fork's default branch from upstream `aaronjmars/aeon`. Pulls any
 * new skills that have been added to the upstream repo since the fork was
 * created. Idempotent — returns 200 with merge_type='none' if already up to
 * date.
 *
 * Endpoint: POST /repos/{owner}/{repo}/merge-upstream
 */
export async function syncFork(owner: string, branch?: string): Promise<{
  message:     string
  merge_type:  'merge' | 'fast-forward' | 'none'
  base_branch: string
}> {
  // Resolve default branch if caller didn't pass one
  let targetBranch = branch
  if (!targetBranch) {
    const repoRes = await ghFetch(`/repos/${validateOwner(owner)}/aeon`)
    const repo = await repoRes.json() as { default_branch: string }
    targetBranch = repo.default_branch || 'main'
  }
  const res = await ghFetch(`/repos/${validateOwner(owner)}/aeon/merge-upstream`, {
    method: 'POST',
    body: JSON.stringify({ branch: targetBranch }),
  })
  return await res.json() as { message: string; merge_type: 'merge' | 'fast-forward' | 'none'; base_branch: string }
}

// ── Runs ──────────────────────────────────────────────────────────────────────
export async function listRuns(owner: string, limit = 20): Promise<RunSummary[]> {
  const res  = await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/runs?per_page=${limit}`)
  const data = await res.json() as { workflow_runs: RunSummary[] }
  return data.workflow_runs.map(r => ({
    id:          r.id,
    name:        r.name,
    status:      r.status,
    conclusion:  r.conclusion,
    created_at:  r.created_at,
    updated_at:  r.updated_at,
    html_url:    r.html_url,
    workflow_id: r.workflow_id,
  }))
}

// ── Trigger ───────────────────────────────────────────────────────────────────
/**
 * Dispatch a workflow_dispatch event.
 *
 * `inputs` is the flat key/value object documented at
 *   POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
 * GitHub caps it at 25 properties. Values must be strings (the dispatches
 * endpoint coerces but we keep typing strict). Aeon's convention is a single
 * `var` key holding the task description / topic.
 */
export async function triggerWorkflow(
  owner: string,
  workflowPath: string,
  ref = 'main',
  inputs?: Record<string, string>,
): Promise<void> {
  const fileName = validateWorkflowPath(workflowPath).replace(/^.*\//, '')
  const body: { ref: string; inputs?: Record<string, string> } = { ref }
  if (inputs && Object.keys(inputs).length > 0) {
    if (Object.keys(inputs).length > 25) {
      throw new Error('workflow_dispatch inputs capped at 25 keys')
    }
    body.inputs = inputs
  }
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/workflows/${encodeURIComponent(fileName)}/dispatches`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ── Secrets ───────────────────────────────────────────────────────────────────
/**
 * Encrypt a secret using the repo's public key (libsodium crypto_box_seal)
 * and PUT it to GitHub Actions secrets.
 */
export async function setSecret(owner: string, name: string, value: string): Promise<void> {
  const sodium = await ensureSodium()

  // 1. Get repo public key
  const keyRes = await ghFetch(
    `/repos/${validateOwner(owner)}/aeon/actions/secrets/public-key`,
  )
  const { key: publicKeyB64, key_id } = await keyRes.json() as { key: string; key_id: string }

  // 2. Encrypt with libsodium crypto_box_seal
  const publicKeyBytes  = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL)
  const secretBytes     = sodium.from_string(value)
  const encryptedBytes  = sodium.crypto_box_seal(secretBytes, publicKeyBytes)
  const encryptedValue  = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL)

  // 3. PUT encrypted secret
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/secrets/${validateSecretName(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
  })
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
export interface JobStep {
  name:          string
  status:        'queued' | 'in_progress' | 'completed'
  conclusion?:   'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | null
  number:        number
  started_at?:   string | null
  completed_at?: string | null
}

export interface JobSummary {
  id:           number
  name:         string
  status:       'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'
  conclusion?:  'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | null
  started_at?:  string | null
  completed_at?: string | null
  html_url?:    string | null
  steps:        JobStep[]
}

/**
 * List the jobs (and their steps) for a workflow run. Polled every few
 * seconds while a run is in_progress to power the live "what is it doing"
 * timeline in RunDetailDrawer.
 */
export async function listJobs(owner: string, runId: number): Promise<JobSummary[]> {
  const res = await ghFetch(
    `/repos/${validateOwner(owner)}/aeon/actions/runs/${runId}/jobs?per_page=100&filter=latest`,
  )
  const data = await res.json() as { jobs: JobSummary[] }
  return data.jobs.map(j => ({
    id:           j.id,
    name:         j.name,
    status:       j.status,
    conclusion:   j.conclusion,
    started_at:   j.started_at,
    completed_at: j.completed_at,
    html_url:     j.html_url,
    steps:        (j.steps ?? []).map(s => ({
      name:         s.name,
      status:       s.status,
      conclusion:   s.conclusion,
      number:       s.number,
      started_at:   s.started_at,
      completed_at: s.completed_at,
    })),
  }))
}

/**
 * Fetch plain-text logs for a single job. GitHub returns a 302 redirect to a
 * pre-signed S3 URL (the link is only valid for ~1 minute, hence why polling
 * has to refetch each time). For in-progress jobs the body contains whatever
 * has been logged so far — that's what powers the live tail.
 */
export async function getJobLogs(owner: string, jobId: number): Promise<string> {
  const token = getStoredToken()
  if (!token) throw new Error('Not authenticated')
  const res = await fetch(
    `https://api.github.com/repos/${validateOwner(owner)}/aeon/actions/jobs/${jobId}/logs`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'follow',
    },
  )
  if (!res.ok) {
    // 404 commonly means the job hasn't produced any logs yet — surface a
    // friendly placeholder so the UI can render "Waiting for first output…"
    if (res.status === 404) return ''
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status}: ${body || res.statusText}`)
  }
  return await res.text()
}

// ── OpenGateway workflow patch ────────────────────────────────────────────────
/**
 * Marker comment used to detect / locate / remove our injected patch without
 * re-parsing YAML. v1 (deprecated) was a job-level env block that hijacked
 * direct mode by leaking ANTHROPIC_BASE_URL into every step. v2 is a guarded
 * step that only exports those env vars when aeon.yml says
 * `gateway.provider: opengateway` — safe in all gateway modes.
 */
const OPENGATEWAY_PATCH_MARKER_V1 = '# tachi-opengateway-patch'
const OPENGATEWAY_PATCH_MARKER    = '# tachi-opengateway-patch-v2'

/**
 * Step injected after `- name: Configure git identity` (which always runs
 * post-checkout when `steps.work.outputs.mode != ''`). Reads aeon.yml's
 * `gateway.provider` value and conditionally exports OpenGateway secrets to
 * $GITHUB_ENV. If aeon.yml says anything other than 'opengateway', the step
 * is a no-op — direct and bankr modes work unchanged.
 */
const OPENGATEWAY_PATCH_BLOCK_V2 = `      - name: Resolve OpenGateway env  ${OPENGATEWAY_PATCH_MARKER}
        if: steps.work.outputs.mode != ''
        run: |
          GW=$(grep -A1 '^gateway:' aeon.yml 2>/dev/null | grep 'provider:' | sed 's/.*provider: *//' | tr -d ' "'"'"'' || true)
          if [ "$GW" = "opengateway" ]; then
            echo "ANTHROPIC_BASE_URL=\${{ secrets.ANTHROPIC_BASE_URL }}" >> "$GITHUB_ENV"
            echo "ANTHROPIC_AUTH_TOKEN=\${{ secrets.ANTHROPIC_AUTH_TOKEN }}" >> "$GITHUB_ENV"
            echo "::notice::OpenGateway env exported (TachiDesk patch v2)"
          else
            echo "::notice::OpenGateway patch present but aeon.yml gateway.provider is '\${GW:-unset}' — skipping (direct/bankr route)"
          fi

`

async function fetchWorkflowFile(owner: string): Promise<{ content: string; sha: string }> {
  const path = '.github/workflows/aeon.yml'
  const res = await ghFetch(`/repos/${validateOwner(owner)}/aeon/contents/${encodeURIComponent(path)}`)
  const data = await res.json() as { content: string; sha: string }
  const text = Buffer.from(data.content, 'base64').toString('utf-8')
  return { content: text, sha: data.sha }
}

/**
 * Read the user's fork's top-level aeon.yml config (the runtime config Aeon
 * skills check — distinct from `.github/workflows/aeon.yml` which is the
 * workflow definition).
 */
// ── Dashboard data ────────────────────────────────────────────────────────────
//
// Aeon natively writes structured skill outputs to `dashboard/outputs/*.json`
// (one file per skill run when JSONRENDER_ENABLED=true). It also keeps quality
// scores in `memory/skill-health/*.json` and run aggregates in
// `memory/cron-state.json`. We surface all three so the TachiDesk dashboard
// tab can mirror what Aeon's own Next.js dashboard at localhost:5555 shows —
// without requiring the user to clone+run that sidecar app.

export interface AeonDashboardOutput {
  filename:   string  // raw filename in dashboard/outputs/, e.g. "article-2026-05-24T23-21-15Z.json"
  skill:      string  // parsed from the filename prefix (everything before the timestamp)
  timestamp:  string  // ISO 8601, parsed from the trailing portion of the filename
  size:       number  // bytes
  htmlUrl:    string  // GitHub blob URL — opens the JSON on github.com
  apiUrl:     string  // GitHub contents API URL — used to fetch content with auth
}

export interface AeonSkillHealth {
  skill:           string
  lastAnalyzed?:   string
  qualityScore?:   number   // 1–5
  avgScore?:       number   // rolling average
  assessment?:     string
  flags?:          string[]
  history?:        Array<{ date: string; score: number }>
}

export interface AeonCronState {
  [skill: string]: {
    last_status?:           'success' | 'failed'
    last_success?:          string
    last_failed?:           string
    total_runs?:            number
    total_successes?:       number
    total_failures?:        number
    consecutive_failures?:  number
    success_rate?:          number
    last_error?:            string
    last_quality_score?:    number
  }
}

/**
 * List structured outputs under `dashboard/outputs/` on the fork's main branch.
 * Returns the most-recent files first (sorted by parsed timestamp).
 *
 * Filename convention from Aeon's `notify-jsonrender` step:
 *   `<skill>-YYYY-MM-DDTHH-MM-SSZ.json`
 * We split on the last `-YYYY-MM-DD` to recover the skill prefix. Older Aeon
 * forks may have used a different shape; in those cases the whole basename
 * shows up as `skill` and timestamp is empty (best-effort, never throws).
 */
export async function listDashboardOutputs(owner: string): Promise<AeonDashboardOutput[]> {
  const o = validateOwner(owner)
  let res: Response
  try {
    res = await ghFetch(`/repos/${o}/aeon/contents/${encodeURIComponent('dashboard/outputs')}`)
  } catch (err) {
    // Directory might not exist yet on a fresh fork — surface an empty list
    // rather than a hard error so the dashboard renders cleanly.
    if (err instanceof Error && /404/.test(err.message)) return []
    throw err
  }
  const data = await res.json() as Array<{
    name: string; size: number; type: string; html_url: string; url: string
  }>
  return data
    .filter(f => f.type === 'file' && f.name.endsWith('.json'))
    .map(f => {
      // Parse "<skill>-2026-05-24T23-21-15Z.json"
      const base  = f.name.replace(/\.json$/, '')
      const match = base.match(/^(.+?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)$/)
      const skill     = match?.[1] ?? base
      const tsToken   = match?.[2] ?? ''
      // Convert Aeon's "2026-05-24T23-21-15Z" → real ISO "2026-05-24T23:21:15Z"
      const timestamp = tsToken
        ? tsToken.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z')
        : ''
      return {
        filename:  f.name,
        skill,
        timestamp,
        size:      f.size,
        htmlUrl:   f.html_url,
        apiUrl:    f.url,
      }
    })
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
}

/**
 * Fetch the parsed JSON content of a single dashboard output. Returns the
 * decoded object (whatever shape Aeon's json-render channel emitted) or null
 * on error / non-JSON payload.
 */
export async function getDashboardOutput(owner: string, filename: string): Promise<unknown | null> {
  // Reject anything other than a plain filename to keep this endpoint scoped
  // to `dashboard/outputs/*` only — the IPC layer also Zod-validates this.
  if (!/^[\w.\-]+\.json$/.test(filename)) {
    throw new Error(`Invalid dashboard output filename: ${filename}`)
  }
  const o = validateOwner(owner)
  const res = await ghFetch(`/repos/${o}/aeon/contents/${encodeURIComponent(`dashboard/outputs/${filename}`)}`)
  const data = await res.json() as { content: string; encoding: string }
  if (data.encoding !== 'base64') return null
  try {
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

/**
 * Fetch the cron-state aggregates Aeon's skills maintain in
 * `memory/cron-state.json`. Used to render per-skill success rates and
 * consecutive-failure indicators in the dashboard's health overview.
 */
export async function getCronState(owner: string): Promise<AeonCronState> {
  const o = validateOwner(owner)
  try {
    const res = await ghFetch(`/repos/${o}/aeon/contents/${encodeURIComponent('memory/cron-state.json')}`)
    const data = await res.json() as { content: string; encoding: string }
    if (data.encoding !== 'base64') return {}
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'))
  } catch (err) {
    if (err instanceof Error && /404/.test(err.message)) return {}
    throw err
  }
}

/**
 * Probe Aeon's native Next.js dashboard. The user runs `./aeon` (or
 * `cd <fork>/dashboard && npm run dev`) and it listens on 5555 by default.
 * We only need to know whether it's reachable so the renderer can decide
 * between iframing it and showing setup instructions.
 *
 * The probe sends a HEAD-style GET to root with a short timeout — Next.js
 * always answers /, even if every API route requires auth.
 */
export async function probeAeonDashboard(port = 5555): Promise<{ running: boolean; port: number }> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1500) as AbortSignal,
    })
    // Any response under 600 means something is bound on the port —
    // typically 200 OK from the index route, but 30x/40x also indicate the
    // dashboard is up.
    return { running: res.status < 600, port }
  } catch {
    return { running: false, port }
  }
}

/**
 * List all skill-health records in `memory/skill-health/*.json`. Each file is
 * one skill's rolling quality history (last 30 runs scored 1–5 by the
 * built-in analyzer). Returns parsed records keyed by skill name.
 */
export async function listSkillHealth(owner: string): Promise<AeonSkillHealth[]> {
  const o = validateOwner(owner)
  let res: Response
  try {
    res = await ghFetch(`/repos/${o}/aeon/contents/${encodeURIComponent('memory/skill-health')}`)
  } catch (err) {
    if (err instanceof Error && /404/.test(err.message)) return []
    throw err
  }
  const files = await res.json() as Array<{ name: string; type: string; url: string }>
  const jsons = files.filter(f => f.type === 'file' && f.name.endsWith('.json'))
  const results = await Promise.all(jsons.map(async f => {
    try {
      const r = await ghFetch(f.url.replace('https://api.github.com', ''))
      const data = await r.json() as { content: string; encoding: string }
      if (data.encoding !== 'base64') return null
      const raw = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'))
      return {
        skill:        raw.skill,
        lastAnalyzed: raw.last_analyzed,
        qualityScore: raw.quality_score,
        avgScore:     raw.avg_score,
        assessment:   raw.assessment,
        flags:        raw.flags,
        history:      raw.history,
      } as AeonSkillHealth
    } catch {
      return null
    }
  }))
  return results.filter((r): r is AeonSkillHealth => r !== null)
}

async function fetchAeonConfig(owner: string): Promise<{ content: string; sha: string }> {
  const res = await ghFetch(`/repos/${validateOwner(owner)}/aeon/contents/${encodeURIComponent('aeon.yml')}`)
  const data = await res.json() as { content: string; sha: string }
  const text = Buffer.from(data.content, 'base64').toString('utf-8')
  return { content: text, sha: data.sha }
}

async function putAeonConfig(owner: string, content: string, sha: string, message: string): Promise<void> {
  const encoded = Buffer.from(content, 'utf-8').toString('base64')
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/contents/${encodeURIComponent('aeon.yml')}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: encoded, sha }),
  })
}

/** Valid values for aeon.yml's gateway.provider field. */
export type AeonGateway = 'direct' | 'bankr' | 'opengateway'

/**
 * Read the current value of `gateway.provider` from the fork's aeon.yml.
 * Returns 'direct' as a sensible default when no gateway block exists.
 */
export async function getAeonGateway(owner: string): Promise<AeonGateway> {
  const { content } = await fetchAeonConfig(owner)
  const match = content.match(/^gateway:\s*\n[ \t]+provider:\s*['"]?([a-zA-Z_-]+)['"]?\s*$/m)
  const value = match?.[1] ?? 'direct'
  return (value === 'bankr' || value === 'opengateway') ? value : 'direct'
}

/**
 * Set `gateway.provider` in the fork's aeon.yml. Idempotent: editing an
 * existing block in place, or inserting a new block right after the top-
 * level `model:` line when none exists. Text-level edit to preserve all
 * surrounding comments and ordering.
 */
export async function setAeonGateway(owner: string, provider: AeonGateway): Promise<{ changed: boolean }> {
  const { content, sha } = await fetchAeonConfig(owner)

  // Case 1: existing `gateway:` block with a `provider:` line — replace in place.
  const inPlaceRegex = /^(gateway:\s*\n[ \t]+provider:\s*['"]?)([a-zA-Z_-]+)(['"]?\s*)$/m
  const inPlaceMatch = content.match(inPlaceRegex)
  if (inPlaceMatch) {
    if (inPlaceMatch[2] === provider) return { changed: false }
    const newContent = content.replace(inPlaceRegex, `$1${provider}$3`)
    await putAeonConfig(
      owner,
      newContent,
      sha,
      `chore(aeon): set gateway.provider to ${provider} (via Tachi Studio)`,
    )
    return { changed: true }
  }

  // Case 2: `gateway:` block exists but no provider line — inject as first child.
  const headerRegex = /^(gateway:\s*\n)/m
  if (headerRegex.test(content)) {
    const newContent = content.replace(headerRegex, `$1  provider: ${provider}\n`)
    await putAeonConfig(
      owner,
      newContent,
      sha,
      `chore(aeon): set gateway.provider to ${provider} (via Tachi Studio)`,
    )
    return { changed: true }
  }

  // Case 3: no gateway block — insert one after the top-level `model:` line,
  // or at the end of file if `model:` is also missing.
  const block = `\n# AI Gateway — route Claude Code requests through an LLM gateway (TachiDesk).\ngateway:\n  provider: ${provider}\n`
  const modelLineRegex = /^model:\s*[^\n]+\n/m
  const newContent = modelLineRegex.test(content)
    ? content.replace(modelLineRegex, m => `${m}${block}`)
    : `${content}\n${block}`

  await putAeonConfig(
    owner,
    newContent,
    sha,
    `chore(aeon): add gateway.provider=${provider} (via Tachi Studio)`,
  )
  return { changed: true }
}

async function putWorkflowFile(owner: string, content: string, sha: string, message: string): Promise<void> {
  const path = '.github/workflows/aeon.yml'
  const encoded = Buffer.from(content, 'utf-8').toString('base64')
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: encoded, sha }),
  })
}

/**
 * Strip any version of the TachiDesk OpenGateway patch out of a workflow
 * source. Returns the cleaned text — caller decides whether to push it back.
 * Idempotent: handles both v1 (job-level env block) and v2 (conditional step).
 */
function stripOpenGatewayPatch(content: string): string {
  let out = content

  // v2: conditional step. Block spans from "      - name: Resolve OpenGateway env"
  // through the trailing blank line after the `fi` / inner script.
  if (out.includes(OPENGATEWAY_PATCH_MARKER)) {
    const v2Regex = new RegExp(
      `[ \\t]*- name: Resolve OpenGateway env\\s+${OPENGATEWAY_PATCH_MARKER}[\\s\\S]*?\\n\\n`,
      '',
    )
    out = out.replace(v2Regex, '')
  }

  // v1: job-level env block — starts with leading whitespace + marker comment,
  // ends with trailing blank line after the ANTHROPIC_AUTH_TOKEN line.
  if (out.includes(OPENGATEWAY_PATCH_MARKER_V1)) {
    const v1Regex = new RegExp(
      `[ \\t]+${OPENGATEWAY_PATCH_MARKER_V1}[\\s\\S]*?ANTHROPIC_AUTH_TOKEN: \\$\\{\\{ secrets\\.ANTHROPIC_AUTH_TOKEN \\}\\}\\n\\n?`,
      '',
    )
    out = out.replace(v1Regex, '')
  }

  return out
}

/**
 * Detect whether the user's fork has been patched. Returns true for v1 OR v2.
 * Drives the APPLIED badge in ProviderCard.
 */
export async function isWorkflowPatchedForOpenGateway(owner: string): Promise<boolean> {
  const { content } = await fetchWorkflowFile(owner)
  return content.includes(OPENGATEWAY_PATCH_MARKER) || content.includes(OPENGATEWAY_PATCH_MARKER_V1)
}

/**
 * Inject a guarded step into the run job that exports OpenGateway env vars
 * to $GITHUB_ENV only when aeon.yml's `gateway.provider` is `opengateway`.
 *
 * The step lives between "Configure git identity" and "Setup Node.js" in the
 * upstream workflow shape (after checkout, before Claude install). Step-level
 * conditionality means direct + bankr modes are unaffected when the user
 * leaves the patch applied while not using OpenGateway.
 *
 * If a v1 patch (job-level env block) is found, it is removed first so the
 * fork ends up with only v2 — a clean upgrade path.
 *
 * Text-level edit (regex injection) rather than YAML round-trip so we don't
 * disturb the file's comments or formatting.
 */
export async function patchWorkflowForOpenGateway(owner: string): Promise<{
  patched: boolean
  alreadyPatched?: boolean
}> {
  const { content, sha } = await fetchWorkflowFile(owner)

  if (content.includes(OPENGATEWAY_PATCH_MARKER)) {
    return { patched: false, alreadyPatched: true }
  }

  // Strip v1 first (if present) so we never leave both versions in the file.
  const cleaned = stripOpenGatewayPatch(content)

  // Inject AFTER the `Configure git identity` step. That step runs only when
  // `steps.work.outputs.mode != ''`, so by the time our patch step runs,
  // aeon.yml is on disk (checked-out by the prior step) and we know there's
  // work to do. The injection point is the blank line that follows the step.
  const anchor = /(- name: Configure git identity[\s\S]*?\n)(\n)( {6}- name: )/
  const match = cleaned.match(anchor)
  if (!match || match.index === undefined) {
    throw new Error(
      "Couldn't find the `Configure git identity` step — upstream workflow shape may have changed. " +
      'Run "Sync from upstream" first or open an issue.',
    )
  }

  const head = cleaned.slice(0, match.index + match[1].length)
  const tail = cleaned.slice(match.index + match[1].length + match[2].length)  // skip the blank line — patch ends with one
  const newContent = head + '\n' + OPENGATEWAY_PATCH_BLOCK_V2 + tail

  await putWorkflowFile(
    owner,
    newContent,
    sha,
    content.includes(OPENGATEWAY_PATCH_MARKER_V1)
      ? 'fix(workflow): upgrade OpenGateway patch v1 → v2 (conditional, via TachiDesk)'
      : 'feat(workflow): inject conditional OpenGateway step (via Tachi Studio)',
  )

  return { patched: true }
}

/**
 * Reverse the OpenGateway patch (v1 or v2) — restores the upstream workflow
 * shape so direct/bankr modes route normally.
 */
export async function unpatchWorkflowForOpenGateway(owner: string): Promise<{ unpatched: boolean }> {
  const { content, sha } = await fetchWorkflowFile(owner)

  const hasV1 = content.includes(OPENGATEWAY_PATCH_MARKER_V1)
  const hasV2 = content.includes(OPENGATEWAY_PATCH_MARKER)
  if (!hasV1 && !hasV2) {
    return { unpatched: false }
  }

  const newContent = stripOpenGatewayPatch(content)
  if (newContent === content) {
    throw new Error('Found patch marker but block boundaries did not match. Edit manually on GitHub.')
  }

  await putWorkflowFile(
    owner,
    newContent,
    sha,
    'fix(workflow): remove OpenGateway patch (via Tachi Studio)',
  )

  return { unpatched: true }
}

// ── Run actions: delete / rerun ───────────────────────────────────────────────
/**
 * Delete a workflow run from history. Used by the × button on each kanban
 * card. The run record itself is removed; logs are no longer accessible
 * through the GitHub API afterwards.
 *
 * Endpoint: DELETE /repos/{owner}/{repo}/actions/runs/{run_id}
 */
export async function deleteRun(owner: string, runId: number): Promise<void> {
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/runs/${runId}`, {
    method: 'DELETE',
  })
}

/**
 * Re-run a completed workflow run. GitHub creates a new attempt on the same
 * run_id, so the kanban card just slides from Failed/Done back into Running
 * on the next poll cycle. Used by the ▶ button and the drag-to-Queued
 * gesture on the kanban.
 *
 * Endpoint: POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun
 */
export async function rerunRun(owner: string, runId: number): Promise<void> {
  await ghFetch(`/repos/${validateOwner(owner)}/aeon/actions/runs/${runId}/rerun`, {
    method: 'POST',
  })
}

// ── Run logs ──────────────────────────────────────────────────────────────────
/**
 * Fetch the first ~10 KB of plain-text log content for a workflow run.
 * GitHub returns a zip archive redirect — we follow it and stream the raw bytes.
 * For MVP we return the first 10 KB of the zip body as a hint; the caller can
 * surface a "View on GitHub" link for the full log.
 */
export async function getRunLogs(owner: string, runId: number): Promise<string> {
  try {
    const token = getStoredToken()
    if (!token) throw new Error('Not authenticated')

    // GitHub redirects to a pre-signed S3 URL — follow it
    const logsRes = await fetch(
      `https://api.github.com/repos/${validateOwner(owner)}/aeon/actions/runs/${runId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
      },
    )

    // The response is a zip archive. Return a helpful message rather than
    // trying to parse binary data — full logs are available on GitHub.
    const contentType = logsRes.headers.get('content-type') ?? ''
    if (contentType.includes('zip') || contentType.includes('octet-stream')) {
      const url = logsRes.url  // final redirect URL
      return `[Logs are a zip archive. Download at: ${url}]\n\nTip: click "View on GitHub" to see formatted logs in your browser.`
    }

    // If somehow text was returned (shouldn't happen normally), grab first 10 KB
    const text = await logsRes.text()
    return text.slice(0, 10 * 1024)
  } catch (err: any) {
    return `Failed to fetch logs: ${err.message ?? err}`
  }
}
