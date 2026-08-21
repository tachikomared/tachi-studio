// Unit tests for the PURE Codex-worker helpers (no electron imports).
import { describe, it, expect } from 'vitest'
import { buildExecArgs, extractSessionId, summarizeEvent, parseEventLine } from '../../electron/services/codex-worker-core'

describe('buildExecArgs', () => {
  it('builds a read-only headless exec by default', () => {
    const args = buildExecArgs({ task: 'audit the auth flow', lastMessageFile: 'C:/tmp/last.txt' })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    expect(args.join(' ')).toContain('--sandbox read-only')
    // --ask-for-approval was REMOVED from `codex exec` in 0.144.x — passing it
    // makes the CLI parse the prompt as a subcommand (live-verified).
    expect(args.join(' ')).not.toContain('--ask-for-approval')
    expect(args.join(' ')).toContain('--output-last-message C:/tmp/last.txt')
    expect(args[args.length - 1]).toBe('-') // prompt goes via stdin now
    expect(args).not.toContain('--model')
  })

  it('write=true flips the sandbox to workspace-write, never full access', () => {
    const args = buildExecArgs({ task: 't', write: true, lastMessageFile: 'f' })
    expect(args.join(' ')).toContain('--sandbox workspace-write')
    expect(args.join(' ')).not.toContain('danger-full-access')
  })

  it('resume inserts exec resume <id> and carries the sandbox as a -c override', () => {
    const args = buildExecArgs({ task: 'continue', resumeSessionId: 'sess-123', lastMessageFile: 'f' })
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'sess-123'])
    // `exec resume` REJECTS --sandbox (clap error, live-verified 0.144.5) —
    // the mode must ride in via a config override instead.
    expect(args).not.toContain('--sandbox')
    expect(args.join(' ')).toContain('-c sandbox_mode=read-only')
    expect(args[args.length - 1]).toBe('-') // prompt via stdin
  })

  it('resume + write=true overrides to workspace-write', () => {
    const args = buildExecArgs({ task: 'c', resumeSessionId: 's1', write: true, lastMessageFile: 'f' })
    expect(args.join(' ')).toContain('-c sandbox_mode=workspace-write')
    expect(args).not.toContain('--sandbox')
  })

  it('model is passed through trimmed', () => {
    const args = buildExecArgs({ task: 't', model: '  gpt-5.3-codex-spark ', lastMessageFile: 'f' })
    const i = args.indexOf('--model')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('gpt-5.3-codex-spark')
  })
})

describe('extractSessionId', () => {
  it('finds direct snake/camel ids', () => {
    expect(extractSessionId({ session_id: 'a1' })).toBe('a1')
    expect(extractSessionId({ threadId: 'b2' })).toBe('b2')
  })
  it('finds ids nested under session/thread/msg/payload', () => {
    expect(extractSessionId({ type: 'session.created', session: { session_id: 'c3' } })).toBe('c3')
    expect(extractSessionId({ msg: { thread_id: 'd4' } })).toBe('d4')
  })
  it('returns null for noise', () => {
    expect(extractSessionId({ type: 'item.completed' })).toBeNull()
    expect(extractSessionId('nope')).toBeNull()
    expect(extractSessionId(null)).toBeNull()
  })
})

describe('summarizeEvent', () => {
  it('summarizes commands and file changes, drops deltas', () => {
    expect(summarizeEvent({ type: 'item.completed', item: { command: 'pnpm test' } })).toBe('$ pnpm test') // content-first: command found regardless of type tag
    expect(summarizeEvent({ type: 'exec_command_begin', command: 'pnpm test' })).toBe('$ pnpm test')
    expect(summarizeEvent({ type: 'command', command: ['git', 'status'] })).toBe('$ git status')
    expect(summarizeEvent({ type: 'file_change', path: 'src/a.ts' })).toBe('edit src/a.ts')
    expect(summarizeEvent({ type: 'agent_message_delta', delta: 'x' })).toBeNull()
  })
  it('surfaces errors with their message', () => {
    expect(summarizeEvent({ type: 'error', message: 'boom' })).toBe('error: boom')
  })
})

describe('parseEventLine', () => {
  it('parses JSON object lines and rejects everything else', () => {
    expect(parseEventLine('{"type":"x"}')).toEqual({ type: 'x' })
    expect(parseEventLine('not json')).toBeNull()
    expect(parseEventLine('{broken')).toBeNull()
    expect(parseEventLine('')).toBeNull()
  })
})
