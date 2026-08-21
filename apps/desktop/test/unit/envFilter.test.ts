// test/unit/envFilter.test.ts — allowlist-by-prefix env filter for untrusted
// child processes (user-configured MCP servers). STEAL 2026-07-08.
import { describe, it, expect } from 'vitest'
import { filterEnv } from '../../electron/services/util/env-filter'

describe('filterEnv', () => {
  it('drops ambient secrets but keeps OS essentials', () => {
    const out = filterEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      OPENAI_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'ghp_x',
      RANDOM_USER_SECRET: 'nope',
    })
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/u')
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(out.GITHUB_TOKEN).toBeUndefined()
    expect(out.RANDOM_USER_SECRET).toBeUndefined()
  })

  it('keeps Windows essentials case-insensitively', () => {
    const out = filterEnv({
      SystemRoot: 'C:\\Windows',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      SOME_CORP_TOKEN: 'leak',
    })
    expect(out.SystemRoot).toBe('C:\\Windows')
    expect(out.APPDATA).toContain('AppData')
    expect(out.ComSpec).toContain('cmd.exe')
    expect(out.PATHEXT).toBe('.COM;.EXE')
    expect(out.SOME_CORP_TOKEN).toBeUndefined()
  })

  it('passes through our own TACHI_* namespace', () => {
    const out = filterEnv({ TACHI_MCP_TOKEN: 't', tachi_lower: 'l', NOTTACHI: 'x' })
    expect(out.TACHI_MCP_TOKEN).toBe('t')
    expect(out.tachi_lower).toBe('l')
    expect(out.NOTTACHI).toBeUndefined()
  })

  it('lets the explicit server config win on collision and adds its own keys', () => {
    const out = filterEnv({ PATH: '/usr/bin', SECRET: 'ambient' }, { PATH: '/custom', MY_SERVER_KEY: 'ok' })
    expect(out.PATH).toBe('/custom')       // config overrides
    expect(out.MY_SERVER_KEY).toBe('ok')   // config-added key present
    expect(out.SECRET).toBeUndefined()     // ambient still dropped
  })

  it('ignores undefined env values', () => {
    const out = filterEnv({ PATH: undefined, HOME: '/h' } as NodeJS.ProcessEnv)
    expect('PATH' in out).toBe(false)
    expect(out.HOME).toBe('/h')
  })
})
