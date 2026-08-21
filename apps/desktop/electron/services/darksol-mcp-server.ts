// apps/desktop/electron/services/darksol-mcp-server.ts
//
// Standalone stdio MCP server — the SHIM that gives darksol an MCP surface it
// otherwise lacks. darksol ships NO MCP server (no @modelcontextprotocol/sdk in
// its deps — see DARKSOL-AGENT-INTEGRATION-PLAN.md §3), so where nook-mcp.ts can
// just spawn @nookplot/mcp's prebuilt binary, this file IS the binary for darksol.
//
// ─── How this is consumed ──────────────────────────────────────────────────────
//
// darksol-mcp.ts (the manager service) registers THIS script in the app's MCP
// registry (electron/services/mcp-manager.ts) via addServer({ command: 'node',
// args: [<this file>], env: {...creds} }) and startServer('darksol'). mcp-manager
// then spawns it over StdioClientTransport, calls listTools(), and keeps a live
// Client — exactly the path @nookplot/mcp takes. The Nodes-canvas MCP node and
// every agent that reads the mcp-manager registry then see the darksol tools.
//
// ─── What it does ──────────────────────────────────────────────────────────────
//
// For each darksol harness tool (price/gas/wallet-balance/portfolio/market/swap/
// send/wiretap-*) it registers an MCP tool whose handler shells out to the darksol
// CLI harness:  `darksol agent harness call-tool <name> --input <json> --json`
// and returns the parsed JSON. Signing (for swap/send) is done by darksol's own
// agent-signer, configured from the wallet creds the manager seeds via env (below).
//
// ─── Configuration (env, injected by darksol-mcp.ts at spawn) ───────────────────
//
//   DARKSOL_BIN            absolute path to the darksol CLI entry (resolved by the
//                          manager; we spawn `node <DARKSOL_BIN>` or the bin shim).
//   DARKSOL_WALLET         active darksol wallet name (from `darksol-active-wallet`).
//   DARKSOL_WALLET_PASSWORD wallet password (decrypts the darksol keystore).
//   DARKSOL_DRY_RUN        '1' (default) | '0' — forwarded to money-moving tools.
//   DARKSOL_DEFAULT_CHAIN  optional default chainId for chain-scoped tools.
//
// NO electron import — this runs in a plain Node child process where `electron`
// is not available. Keep deps to @modelcontextprotocol/sdk + node builtins.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { execFile } from 'node:child_process'
import { evaluateMoneyPolicy, parseAllowlistEnv } from './darksol-money-policy'
import { createRiskBreaker } from './darksol-risk-breaker'

// ─── Harness tool table (the ONE place the tool set + schemas live) ─────────────
//
// Each entry is one darksol harness tool exposed over MCP. Schemas are kept
// permissive (additionalProperties: true) so we forward whatever darksol's harness
// accepts without re-deriving its full param spec — the harness validates
// authoritatively. moneyMoving entries get dryRun injected by the handler.

interface HarnessToolDef {
  /** darksol harness tool name passed to `call-tool <name>`. */
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
  /** When true, the handler injects DARKSOL_DRY_RUN into the input unless caller set it. */
  moneyMoving?: boolean
}

const HARNESS_TOOLS: HarnessToolDef[] = [
  { name: 'price', description: 'Get the current price of a token.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, chainId: { type: 'number' } }, required: ['token'], additionalProperties: true } },
  { name: 'gas', description: 'Get current gas prices for a chain.',
    inputSchema: { type: 'object', properties: { chainId: { type: 'number' } }, additionalProperties: true } },
  { name: 'wallet-balance', description: "Get the darksol agent wallet's balances.",
    inputSchema: { type: 'object', properties: { chainId: { type: 'number' }, token: { type: 'string' } }, additionalProperties: true } },
  { name: 'portfolio', description: "Get the agent wallet's full portfolio across chains.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'market', description: 'Get market data / overview for a token or the broader market.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' } }, additionalProperties: true } },
  { name: 'swap', description: 'Swap one token for another via the agent (LI.FI). Dry-run by default.', moneyMoving: true,
    inputSchema: { type: 'object', properties: { fromToken: { type: 'string' }, toToken: { type: 'string' }, amount: { type: 'string' }, chainId: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['fromToken', 'toToken', 'amount'], additionalProperties: true } },
  { name: 'send', description: 'Send native or ERC-20 tokens via the agent. Dry-run by default.', moneyMoving: true,
    inputSchema: { type: 'object', properties: { token: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' }, chainId: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['to', 'amount'], additionalProperties: true } },
  { name: 'wiretap-status', description: 'Get the status of darksol wiretap (on-chain activity monitoring).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'wiretap-list', description: 'List the addresses/contracts darksol wiretap is watching.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'wiretap-watch', description: 'Add an address/contract to the darksol wiretap watch list.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' }, chainId: { type: 'number' } }, required: ['address'], additionalProperties: true } },
]

// ─── Harness CLI shell-out (the ONE place the CLI contract lives) ───────────────

const DARKSOL_BIN  = process.env.DARKSOL_BIN  ?? 'darksol'
const DRY_RUN      = process.env.DARKSOL_DRY_RUN !== '0' // default ON
// Per-trade ceiling + recipient allowlist seeded by darksol-mcp.ts from the
// active wallet's AgentLimits. Enforced in-process below (audit 2026-06-12).
const MAX_VALUE    = process.env.DARKSOL_MAX_VALUE ?? '0.05'
const ALLOWLIST    = parseAllowlistEnv(process.env.DARKSOL_ALLOWLIST)
const HARNESS_TIMEOUT_MS = 60_000

// Cross-trade risk breaker (audit 2026-06-12 / CloddsBot pattern). The per-trade
// money-policy gate caps ONE send; this halts ALL real money once the agent
// either hammers failing sends (gas-bleed) or bursts many actions in a window —
// threats no single-trade cap can see. Tripped => evaluateMoneyPolicy denies
// real sends until the process restarts (a fresh wallet session). USD-windowed
// tripping is available in the breaker but not wired here: this standalone CLI
// process has no price oracle, so we trip on failure-streak + action-velocity,
// both unit-free. Tunable via env without touching code.
const RISK_BREAKER = createRiskBreaker({
  conditions: [
    { type: 'consecutiveFailures', max: Number(process.env.DARKSOL_BREAKER_FAIL_STREAK ?? 3) },
    {
      type: 'rollingActionCount',
      windowMs: Number(process.env.DARKSOL_BREAKER_WINDOW_MS ?? 3_600_000),
      max: Number(process.env.DARKSOL_BREAKER_MAX_ACTIONS ?? 20),
    },
  ],
})

/**
 * Invoke one darksol harness tool via the CLI and return its parsed JSON.
 * Contract (DARKSOL-AGENT-INTEGRATION-PLAN.md §3):
 *   darksol agent harness call-tool <name> --input <json> --json
 * The wallet/network context comes from env darksol reads on its own (set by
 * darksol-mcp.ts at spawn); we only pass the per-call tool input here.
 */
function callHarnessTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const json = JSON.stringify(input ?? {})
  const args = ['agent', 'harness', 'call-tool', name, '--input', json, '--json']
  // DARKSOL_BIN may be a .js entry (spawn via node) or a real executable/bin shim.
  const isJs = /\.[cm]?js$/i.test(DARKSOL_BIN)
  const cmd  = isJs ? (process.platform === 'win32' ? 'node.exe' : 'node') : DARKSOL_BIN
  const argv = isJs ? [DARKSOL_BIN, ...args] : args
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: HARNESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`darksol ${name} failed: ${stderr?.trim() || err.message}`)); return }
        const out = (stdout ?? '').trim()
        try { resolve(out ? JSON.parse(out) : { ok: true }) }
        catch { resolve({ ok: true, raw: out }) } // tolerate non-JSON success output
      })
  })
}

// ─── MCP server wiring (mirror mcp-server.ts Steps 1–3) ─────────────────────────

const SERVER_NAME = 'darksol-mcp'
const SERVER_VERSION = '0.1.0'

function wrapResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  const text = JSON.stringify(value, null, 2)
  const out: { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } = {
    content: [{ type: 'text', text }],
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) out.structuredContent = value as Record<string, unknown>
  return out
}
function wrapError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}

async function main(): Promise<void> {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: HARNESS_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const def = HARNESS_TOOLS.find(t => t.name === req.params.name)
    if (!def) return wrapError(`unknown tool: ${req.params.name}`)
    const input = { ...((req.params.arguments ?? {}) as Record<string, unknown>) }
    // Money-moving tools: enforce the wallet's dry-run lock + per-trade cap +
    // recipient allowlist IN-PROCESS, before shelling out to the darksol CLI
    // (audit 2026-06-12, dimension 2 / CRITICAL — this MCP path previously had
    // no cap and let a caller pass dryRun:false to bypass the lock).
    let recordReal: ((ok: boolean) => void) | null = null
    if (def.moneyMoving) {
      const decision = evaluateMoneyPolicy(
        { tool: def.name, amount: input.amount, to: input.to, dryRun: input.dryRun },
        { dryRunForced: DRY_RUN, maxPerTradeEth: MAX_VALUE, allowlist: ALLOWLIST },
        RISK_BREAKER,
      )
      if (!decision.allowed) return wrapError(decision.reason ?? 'Refused by wallet policy.')
      input.dryRun = decision.effectiveDryRun // override caller — the lock cannot be bypassed
      // Only a REAL send feeds the cross-trade breaker; a simulation moves nothing.
      if (!decision.effectiveDryRun) recordReal = (ok) => RISK_BREAKER.recordOutcome(def.name, ok)
    }
    try {
      const out = await callHarnessTool(def.name, input)
      recordReal?.(true)
      return wrapResult(out)
    } catch (e) {
      recordReal?.(false)
      return wrapError(e instanceof Error ? e.message : String(e))
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdio transport keeps the process alive; nothing else to do.
}

main().catch(err => {
  // Fatal startup error → write to stderr (mcp-manager surfaces it as lastError) and exit non-zero.
  process.stderr.write(`[darksol-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
