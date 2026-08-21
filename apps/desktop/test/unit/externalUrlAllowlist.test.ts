// Tests for the shell.openExternal hostname allowlist (shell.ipc.ts).
// This single predicate now guards BOTH the shell:open-external IPC route
// and main.ts's setWindowOpenHandler (window.open / target=_blank) — a miss
// here is a drive-by-link hole, so we pin the semantics.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

import { isExternalUrlAllowed } from '../../electron/ipc/shell.ipc'

describe('isExternalUrlAllowed', () => {
  it('allows exact allowlisted hosts (case-insensitive)', () => {
    expect(isExternalUrlAllowed('https://github.com/foo/bar')).toBe(true)
    expect(isExternalUrlAllowed('https://GitHub.com/foo')).toBe(true)
    expect(isExternalUrlAllowed('https://claude.ai/settings')).toBe(true)
    expect(isExternalUrlAllowed('https://openrouter.ai/keys')).toBe(true)
  })

  it('allows subdomains only via the suffix list', () => {
    expect(isExternalUrlAllowed('https://gist.github.com/x')).toBe(true)
    expect(isExternalUrlAllowed('https://raw.githubusercontent.com/a/b')).toBe(true)
    // claude.ai has no suffix entry -> subdomain NOT allowed
    expect(isExternalUrlAllowed('https://evil.claude.ai/')).toBe(false)
  })

  it('blocks non-allowlisted hosts', () => {
    expect(isExternalUrlAllowed('https://example.com/')).toBe(false)
    expect(isExternalUrlAllowed('https://github.com.evil.io/')).toBe(false)
    expect(isExternalUrlAllowed('http://attacker.dev/payload')).toBe(false)
  })

  it('always allows loopback (local sidecars)', () => {
    expect(isExternalUrlAllowed('http://localhost:3000/')).toBe(true)
    expect(isExternalUrlAllowed('http://127.0.0.1:8188/')).toBe(true)
    expect(isExternalUrlAllowed('http://[::1]:8080/')).toBe(true)
    expect(isExternalUrlAllowed('http://app.localhost:5173/')).toBe(true)
  })

  it('allows only the bounded set of custom protocols', () => {
    expect(isExternalUrlAllowed('vscode://file/x.ts')).toBe(true)
    expect(isExternalUrlAllowed('cursor://open')).toBe(true)
    // arbitrary protocol handlers stay blocked
    expect(isExternalUrlAllowed('ms-msdt://exploit')).toBe(false)
    expect(isExternalUrlAllowed('file:///C:/Windows/system32')).toBe(false)
    expect(isExternalUrlAllowed('javascript:alert(1)')).toBe(false)
  })

  it('rejects garbage without throwing', () => {
    expect(isExternalUrlAllowed('not a url')).toBe(false)
    expect(isExternalUrlAllowed('')).toBe(false)
  })
})
