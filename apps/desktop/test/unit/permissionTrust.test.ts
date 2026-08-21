// UX #8: SAFE/STANDARD/AUTO trust presets in checkAutoApproval + the wired
// allow_30m decision path (recordDecision → approveForSession).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkAutoApproval,
  recordDecision,
  clearSessionApprovals,
  type PermissionRequest,
} from '../../electron/services/permission-service'

const CTX = { workingDir: 'C:/work/proj', actor: 'tachi' as const }

beforeEach(() => {
  clearSessionApprovals()
})

describe('trust presets', () => {
  it('standard (default) keeps today behavior: reads auto, in-workspace writes auto, bash asks', () => {
    expect(checkAutoApproval('read_file', { path: 'C:/work/proj/a.ts' }, CTX)).toBe('auto-allow')
    expect(checkAutoApproval('write', { path: 'C:/work/proj/a.ts', content: 'x' }, CTX)).toBe('auto-allow')
    expect(checkAutoApproval('bash', { command: 'git status' }, CTX)).toBe('needs-prompt')
  })

  it('safe asks for every mutation, even in-workspace writes — reads stay free', () => {
    const ctx = { ...CTX, trust: 'safe' as const }
    expect(checkAutoApproval('read_file', { path: 'C:/work/proj/a.ts' }, ctx)).toBe('auto-allow')
    expect(checkAutoApproval('write', { path: 'C:/work/proj/a.ts', content: 'x' }, ctx)).toBe('needs-prompt')
    expect(checkAutoApproval('bash', { command: 'git status' }, ctx)).toBe('needs-prompt')
    expect(checkAutoApproval('codex_worker', { task: 't' }, ctx)).toBe('needs-prompt')
  })

  it('auto runs NON-destructive bash free; destructive still asks; no command = fail-closed', () => {
    const ctx = { ...CTX, trust: 'auto' as const }
    expect(checkAutoApproval('bash', { command: 'git status' }, ctx)).toBe('auto-allow')
    expect(checkAutoApproval('bash', { command: 'rm -rf /' }, ctx)).toBe('needs-prompt')
    expect(checkAutoApproval('bash', {}, ctx)).toBe('needs-prompt')
  })

  it('auto still asks for MCP tools and protected-path writes', () => {
    const ctx = { ...CTX, trust: 'auto' as const }
    // Bridged MCP tools are namespaced `mcp__<server>__<tool>` (mcp-bridge.ts);
    // the rule keys off the `mcp_` prefix, so both shapes must always ask.
    expect(checkAutoApproval('mcp__github__create_issue', {}, ctx)).toBe('needs-prompt')
    expect(checkAutoApproval('mcp_github_create_issue', {}, ctx)).toBe('needs-prompt')
    expect(checkAutoApproval('write', { path: 'C:/Windows/system32/x', content: '' }, ctx)).toBe('needs-prompt')
  })
})

describe('allow_30m decision wiring', () => {
  it('recordDecision(allow_30m) grants a TTL pass that checkAutoApproval honors', () => {
    const req: PermissionRequest = {
      id: '1', toolName: 'bash', toolInput: { command: 'pnpm test' },
      reason: 'r', recommendedDecision: 'allow',
    }
    expect(checkAutoApproval('bash', { command: 'pnpm test' }, CTX)).toBe('needs-prompt')
    recordDecision(req, 'allow_30m', 'tachi')
    expect(checkAutoApproval('bash', { command: 'pnpm test' }, CTX)).toBe('auto-allow')
    // Even in SAFE the explicit grant wins (user carved the exception).
    expect(checkAutoApproval('bash', { command: 'pnpm test' }, { ...CTX, trust: 'safe' })).toBe('auto-allow')
  })
})
