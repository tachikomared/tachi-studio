// apps/desktop/electron/ipc/aeon.ipc.ts
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import * as aeon from '../services/aeon-service'
import * as dashboard from '../services/aeon-dashboard-service'
import { retrieveKey } from '../services/keychain'

let loginAbort: AbortController | null = null

export function registerAeonIpc(win: BrowserWindow): void {
  ipcMain.handle('aeon:gh-status',  () => aeon.ghStatus())
  ipcMain.handle('aeon:detect-fork', () => aeon.detectFork())
  ipcMain.handle('aeon:fork',        () => aeon.forkAeon())

  ipcMain.handle('aeon:list-workflows', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.listWorkflows(owner)
  })

  ipcMain.handle('aeon:list-runs', (_e, payload) => {
    const { owner, limit } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      limit: z.number().int().positive().max(100).optional(),
    }).parse(payload)
    return aeon.listRuns(owner, limit)
  })

  ipcMain.handle('aeon:trigger', (_e, payload) => {
    const { owner, workflowPath, ref, inputs } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      workflowPath: z.string().min(1).regex(/^[\w./-]+$/),
      ref: z.string().min(1).optional(),
      // workflow_dispatch inputs: flat key/value, max 25 keys, string values.
      // Keys must be valid YAML identifiers per GitHub Actions.
      inputs: z.record(z.string().regex(/^[A-Za-z_][\w-]*$/), z.string()).optional(),
    }).parse(payload)
    return aeon.triggerWorkflow(owner, workflowPath, ref, inputs)
  })

  ipcMain.handle('aeon:set-secret', (_e, payload) => {
    const { owner, name, value } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      name:  z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/),  // GitHub secrets must be UPPER_SNAKE
      value: z.string().min(1),
    }).parse(payload)
    return aeon.setSecret(owner, name, value)
  })

  /**
   * Push a locally-stored provider key (from the chat-side keychain) up to
   * the user's Aeon fork as GitHub Actions secrets, using the EXACT secret
   * names the upstream Aeon workflow expects. Otherwise the workflow falls
   * back to direct-Anthropic mode with an empty key and Claude CLI fails
   * with "Not logged in · Please run /login".
   *
   * Aeon's workflow env block (verified against aaronjmars/aeon@main):
   *   - ANTHROPIC_API_KEY            ← direct Anthropic API
   *   - CLAUDE_CODE_OAUTH_TOKEN      ← Claude OAuth refresh token
   *   - BANKR_LLM_KEY                ← routed through Bankr gateway when
   *                                    aeon.yml sets gateway.provider: bankr
   *
   * Notably the workflow does NOT pass ANTHROPIC_AUTH_TOKEN or
   * ANTHROPIC_BASE_URL through from secrets, so pushing those did nothing.
   */
  ipcMain.handle('aeon:push-local-provider-secret', async (_e, payload) => {
    const { owner, provider } = z.object({
      owner:    z.string().min(1).regex(/^[\w.-]+$/),
      provider: z.enum([
        'opengateway',
        'bankr-gateway',
        'anthropic-oauth',
        'anthropic',           // direct Anthropic API key
      ]),
    }).parse(payload)
    const localKey = retrieveKey(provider)
    if (!localKey) {
      throw new Error(`No local key found for ${provider}. Add it in Settings first.`)
    }

    // OpenGateway needs TWO secrets (BASE_URL + AUTH_TOKEN) because Claude
    // Code uses proxy mode when BASE_URL is set, reading AUTH_TOKEN as a
    // Bearer credential. The fork's workflow YAML also needs patching to
    // inject these secrets into the job env (see patchWorkflowForOpenGateway).
    // All other providers push a single secret read directly by the workflow.
    if (provider === 'opengateway') {
      await aeon.setSecret(owner, 'ANTHROPIC_BASE_URL',  'https://opengateway.gitlawb.com/v1')
      await aeon.setSecret(owner, 'ANTHROPIC_AUTH_TOKEN', localKey)
      return { ok: true, provider, owner, secretName: 'ANTHROPIC_BASE_URL+AUTH_TOKEN' }
    }

    let secretName: string
    switch (provider) {
      case 'bankr-gateway':
        // Bankr gateway is natively supported: BANKR_LLM_KEY is read by the
        // workflow's gateway routing when aeon.yml has gateway.provider: bankr.
        secretName = 'BANKR_LLM_KEY'
        break
      case 'anthropic-oauth':
        // Anthropic OAuth refresh token — Claude Code CLI auto-detects.
        secretName = 'CLAUDE_CODE_OAUTH_TOKEN'
        break
      case 'anthropic':
        // Direct Anthropic API key (sk-ant-…).
        secretName = 'ANTHROPIC_API_KEY'
        break
    }
    await aeon.setSecret(owner, secretName, localKey)
    return { ok: true, provider, owner, secretName }
  })

  /**
   * Fresh forks of `aaronjmars/aeon` arrive with Actions disabled (GitHub's
   * default for security). This endpoint mirrors the green "Enable Actions"
   * button on github.com so non-technical users don't need to leave the app.
   */
  ipcMain.handle('aeon:enable-actions', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.enableActions(owner)
  })

  ipcMain.handle('aeon:actions-status', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.getActionsPermissions(owner)
  })

  /**
   * Pulls new skills from upstream into the user's fork. Optional `branch`
   * defaults to the fork's default branch.
   */
  ipcMain.handle('aeon:sync-fork', (_e, payload) => {
    const { owner, branch } = z.object({
      owner:  z.string().min(1).regex(/^[\w.-]+$/),
      branch: z.string().min(1).max(255).optional(),
    }).parse(payload)
    return aeon.syncFork(owner, branch)
  })

  ipcMain.handle('aeon:run-logs', (_e, payload) => {
    const { owner, runId } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      runId: z.number().int().positive(),
    }).parse(payload)
    return aeon.getRunLogs(owner, runId)
  })

  ipcMain.handle('aeon:workflow-inputs', (_e, payload) => {
    const { owner, workflowPath } = z.object({
      owner:        z.string().min(1).regex(/^[\w.-]+$/),
      workflowPath: z.string().min(1).regex(/^[\w./-]+$/),
    }).parse(payload)
    return aeon.getWorkflowInputs(owner, workflowPath)
  })

  ipcMain.handle('aeon:list-skill-dirs', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.listSkillDirs(owner)
  })

  ipcMain.handle('aeon:patch-workflow-opengateway', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.patchWorkflowForOpenGateway(owner)
  })

  ipcMain.handle('aeon:unpatch-workflow-opengateway', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.unpatchWorkflowForOpenGateway(owner)
  })

  ipcMain.handle('aeon:workflow-patch-status', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.isWorkflowPatchedForOpenGateway(owner)
  })

  ipcMain.handle('aeon:get-gateway', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.getAeonGateway(owner)
  })

  ipcMain.handle('aeon:set-gateway', (_e, payload) => {
    const { owner, provider } = z.object({
      owner:    z.string().min(1).regex(/^[\w.-]+$/),
      provider: z.enum(['direct', 'bankr', 'opengateway']),
    }).parse(payload)
    return aeon.setAeonGateway(owner, provider)
  })

  // ── Dashboard data ─────────────────────────────────────────────────────────
  ipcMain.handle('aeon:list-dashboard-outputs', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.listDashboardOutputs(owner)
  })

  ipcMain.handle('aeon:get-dashboard-output', (_e, payload) => {
    const { owner, filename } = z.object({
      owner:    z.string().min(1).regex(/^[\w.-]+$/),
      // Bounded character class — must match the same shape aeon-service enforces.
      filename: z.string().min(1).regex(/^[\w.\-]+\.json$/),
    }).parse(payload)
    return aeon.getDashboardOutput(owner, filename)
  })

  ipcMain.handle('aeon:cron-state', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.getCronState(owner)
  })

  ipcMain.handle('aeon:skill-health', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return aeon.listSkillHealth(owner)
  })

  // Probe Aeon's native Next.js dashboard. Allows the renderer to decide
  // whether to iframe it or show setup instructions.
  ipcMain.handle('aeon:probe-dashboard', (_e, payload) => {
    const { port } = z.object({ port: z.number().int().min(1).max(65535).optional() }).parse(payload ?? {})
    return aeon.probeAeonDashboard(port)
  })

  // ── Auto-spawn the dashboard (zero-terminal flow) ─────────────────────────
  ipcMain.handle('aeon:dashboard-prereqs', () => dashboard.checkPrerequisites())
  ipcMain.handle('aeon:dashboard-status',  () => dashboard.dashboardStatus())

  ipcMain.handle('aeon:dashboard-install-and-launch', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return dashboard.installAndLaunchDashboard(owner)
  })

  ipcMain.handle('aeon:dashboard-stop',  () => { dashboard.stopDashboard(); return { ok: true } })
  ipcMain.handle('aeon:dashboard-reset', () => { dashboard.resetDashboardCache(); return { ok: true } })

  // Subscribe the renderer window to dashboard progress events. Returns an
  // off-handle the renderer can call to unsubscribe. We push events via a
  // dedicated channel so the renderer can mount a live spinner during
  // download/install/start without polling.
  dashboard.onDashboardProgress(event => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('aeon:dashboard-progress', event)
    }
  })

  ipcMain.handle('aeon:get-skill-analytics', (_e, payload) => {
    const { owner } = z.object({ owner: z.string().min(1).regex(/^[\w.-]+$/) }).parse(payload)
    return dashboard.getSkillAnalytics(owner)
  })

  // E2: fork-behind indicator — no owner arg needed; fetches from running dashboard
  ipcMain.handle('aeon:get-sync-status', () => dashboard.getSyncStatus())

  // E4: memory search — query forwarded to running dashboard's /api/memory/search
  ipcMain.handle('aeon:search-memory', (_e, payload) => {
    const { query } = z.object({ query: z.string().min(1).max(500) }).parse(payload)
    return dashboard.searchMemory(query)
  })

  ipcMain.handle('aeon:delete-run', (_e, payload) => {
    const { owner, runId } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      runId: z.number().int().positive(),
    }).parse(payload)
    return aeon.deleteRun(owner, runId)
  })

  ipcMain.handle('aeon:rerun-run', (_e, payload) => {
    const { owner, runId } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      runId: z.number().int().positive(),
    }).parse(payload)
    return aeon.rerunRun(owner, runId)
  })

  ipcMain.handle('aeon:list-jobs', (_e, payload) => {
    const { owner, runId } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      runId: z.number().int().positive(),
    }).parse(payload)
    return aeon.listJobs(owner, runId)
  })

  ipcMain.handle('aeon:job-logs', (_e, payload) => {
    const { owner, jobId } = z.object({
      owner: z.string().min(1).regex(/^[\w.-]+$/),
      jobId: z.number().int().positive(),
    }).parse(payload)
    return aeon.getJobLogs(owner, jobId)
  })

  ipcMain.handle('aeon:login-start', () => {
    if (loginAbort) loginAbort.abort()
    loginAbort = new AbortController()
    aeon.ghLogin(
      ({ code, verificationUri }) => {
        if (!win.isDestroyed()) win.webContents.send('aeon:login-code', { code, verificationUri })
      },
      loginAbort.signal,
    ).then(() => {
      if (!win.isDestroyed()) win.webContents.send('aeon:login-done', { ok: true })
    }).catch((err) => {
      if (!win.isDestroyed()) win.webContents.send('aeon:login-done', { ok: false, error: String(err) })
    }).finally(() => { loginAbort = null })
  })

  ipcMain.handle('aeon:login-cancel', () => {
    loginAbort?.abort()
    loginAbort = null
  })
}
