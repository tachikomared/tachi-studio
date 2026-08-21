import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import {
  buildRegistry,
  createCodexDetector,
  createClaudeCodeDetector,
  createOpenClaudeDetector,
  createOpenClawDetector,
  createOpenCodeDetector,
  createHermesAgentDetector,
  createAeonDetector,
  createComfyUIDetector,
  createN8nDetector,
  createVSCodeDetector,
  RuntimeDetector,
  BinaryExecutor,
} from '@tachi/core'
import { retrieveKey } from './keychain'
import { loadSettings } from './settings-store'

const execFileAsync = promisify(execFile)

const ALLOWED_COMMANDS: Record<string, { allowedArgv: (string | RegExp)[][]; timeoutMs: number }> = {
  which:         { allowedArgv: [[/^[a-z0-9_.-]+$/i]], timeoutMs: 3000 },
  'where.exe':   { allowedArgv: [[/^[a-z0-9_.-]+$/i]], timeoutMs: 3000 },
  npm:           { allowedArgv: [['root', '-g']], timeoutMs: 5000 },
  'npm.cmd':     { allowedArgv: [['root', '-g']], timeoutMs: 5000 },
  // wsl.exe: shapes used by wsl-probe — `-l -q` (list distros), `-d <distro> -- which <bin>`, `-d <distro> -- <bin> --version`
  'wsl.exe':     {
    allowedArgv: [
      ['-l', '-q'],
      ['-d', /^[a-zA-Z0-9_. -]+$/, '--', 'which', /^[a-zA-Z0-9_.-]+$/],
      ['-d', /^[a-zA-Z0-9_. -]+$/, '--', /^[a-zA-Z0-9_.-]+$/, '--version'],
    ],
    timeoutMs: 5000,
  },
  gh:            { allowedArgv: [['--version']], timeoutMs: 5000 },
  ollama:        { allowedArgv: [['list'], ['--version']], timeoutMs: 5000 },
  codex:         { allowedArgv: [['--version']], timeoutMs: 5000 },
  claude:        { allowedArgv: [['--version']], timeoutMs: 5000 },
  openclaude:    { allowedArgv: [['--version']], timeoutMs: 5000 },
  openclaw:      { allowedArgv: [['--version'], ['gateway', 'status', '--json']], timeoutMs: 5000 },
  // SD3 new binaries
  opencode:      { allowedArgv: [['--version']], timeoutMs: 5000 },
  hermes:        { allowedArgv: [['--version']], timeoutMs: 5000 },
  aeon:          { allowedArgv: [['--version']], timeoutMs: 5000 },
  n8n:           { allowedArgv: [['--version']], timeoutMs: 5000 },
  code:          { allowedArgv: [['--version']], timeoutMs: 5000 },
}

function argvAllowed(binary: string, argv: string[]): boolean {
  const entry = ALLOWED_COMMANDS[binary]
  if (!entry) return false
  return entry.allowedArgv.some(allowed =>
    allowed.length === argv.length &&
    allowed.every((a, i) => typeof a === 'string' ? a === argv[i] : a.test(argv[i]))
  )
}

// Cache npm global root so we don't call `npm root -g` on every scan
let _npmGlobalRootCache: string | undefined
let _npmGlobalRootFetched = false

const executor: BinaryExecutor = {
  async probe(binary, args, timeoutMs = 5000) {
    if (!argvAllowed(binary, args)) {
      throw new Error(`Command not in whitelist: ${binary} ${args.join(' ')}`)
    }
    const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which'
    try {
      // windowsHide everywhere: these probes fire when the CODE tab / Providers
      // settings mount — without it every console binary FLASHES a cmd window
      // (user-reported "terminal blinks for a second").
      await execFileAsync(whichCmd, [binary], { timeout: 3000, windowsHide: true })
    } catch {
      return { found: false }
    }
    try {
      const { stdout } = await execFileAsync(binary, args, { timeout: timeoutMs, windowsHide: true })
      return { found: true, version: stdout.trim().split('\n')[0] }
    } catch {
      return { found: true }
    }
  },

  async npmGlobalRoot(): Promise<string | undefined> {
    if (_npmGlobalRootFetched) return _npmGlobalRootCache
    _npmGlobalRootFetched = true
    // On Windows, npm resolves to npm.cmd; on Unix it's npm
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const npmArgs = ['root', '-g']
    if (!argvAllowed(npmBin, npmArgs) && !argvAllowed('npm', npmArgs)) {
      return undefined
    }
    try {
      const { stdout } = await execFileAsync(npmBin, npmArgs, { timeout: 5000, windowsHide: true })
      _npmGlobalRootCache = stdout.trim()
      return _npmGlobalRootCache
    } catch {
      return undefined
    }
  },
}

export function buildRuntimeRegistry(): RuntimeDetector[] {
  const settings = loadSettings()
  // Canonical keychain id everywhere else this key is stored/read: the provider
  // registry's keychainId ('bankr-gateway'), provider-service.ts, bankr-service.ts,
  // curator-service.ts, router-service.ts, tachi/provider.ts, nook-brain.ts, etc.
  // This used to read retrieveKey('bankr') — an id nothing else in the app ever
  // stores under — so apiKey here was always undefined and the Bankr runtime
  // card's detector short-circuited to 'needs_login' before ever calling the
  // health function, regardless of whether the user had a working key.
  const bankrKey = retrieveKey('bankr-gateway') ?? undefined
  return buildRegistry({
    bankrApiKey: bankrKey,
    bankrBuddyPort: settings.bankrBuddyPort,
    binaryDetectors: [
      // Existing coding agents
      createCodexDetector(executor),
      createClaudeCodeDetector(executor),
      createOpenClaudeDetector(executor, { userDataPath: app.getPath('userData') }),
      createOpenClawDetector(executor),
      // SD3: new binary-based coding agents
      createOpenCodeDetector(executor),
      createHermesAgentDetector(executor),
      createAeonDetector(executor),
      createVSCodeDetector(executor),
      // SD3: HTTP + combined detectors (n8n needs both executor + fetch)
      createComfyUIDetector(),
      createN8nDetector(executor),
    ],
  })
}
