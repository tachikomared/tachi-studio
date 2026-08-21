// apps/desktop/electron/services/multi-chain-runner.ts
//
// Stub multi-process launcher for multi-chain flows compiled by `chainScheduler`
// in NodesPage.tsx. In Sprint B1 this is a logging stub — real parallel sidecar
// spawning is deferred to Sprint C (sidecar-checkpointing sprint).
//
// The type `ChainConfig` is exported so the renderer can import it for the IPC
// boundary without introducing new IPC channels (the renderer just toasts the
// count and applies chains[0] to agent.store in v1).
//
// Reference: inngest/agent-kit Network.Router.FnRouter + State shapes.

import { app } from 'electron'
import path from 'path'
import fs from 'fs'

// ── Public types ──────────────────────────────────────────────────────────────

/** Config for a single agent chain derived from the visual flow graph. */
export interface ChainConfig {
  /** Harness that will run this chain. ('goose' was removed with the harness.) */
  harness: 'openclaude'
  /** Provider gateway that the harness's LLM calls route through. */
  provider: 'default' | 'bankr'
  /** Human-readable label for the provider node (e.g. "Bankr Gateway"). */
  providerLabel: string
  /** Bankr model slug — only set when provider === 'bankr'. */
  bankrModel?: string
  /** Permission tier id from the downstream skill/permission node, if wired. */
  permission?: string
  /** The agent node id from the canvas — useful for UI tracing / highlighting. */
  agentNodeId: string
}

/** Return type of runMultiChain. */
export interface MultiChainResult {
  /** Number of chains that were processed (logged in stub; will be launched in C). */
  launched: number
}

// ── Stub runner ───────────────────────────────────────────────────────────────

/**
 * Stub: logs each ChainConfig to the app log file and returns the count.
 * Real multi-process sidecar spawning is deferred to Sprint C.
 */
export async function runMultiChain(chains: ChainConfig[]): Promise<MultiChainResult> {
  const logLines: string[] = [
    `[multi-chain-runner] ${new Date().toISOString()} — received ${chains.length} chain(s):`,
  ]

  chains.forEach((c, i) => {
    logLines.push(
      `  chain[${i}] agentNode=${c.agentNodeId} harness=${c.harness} ` +
      `provider=${c.provider} (${c.providerLabel})` +
      (c.bankrModel   ? ` model=${c.bankrModel}`  : '') +
      (c.permission   ? ` perm=${c.permission}`   : ''),
    )
  })

  const logStr = logLines.join('\n') + '\n'

  // Write to the Electron userData log directory so the output is visible
  // during development without needing the DevTools open.
  try {
    const logPath = path.join(app.getPath('userData'), 'multi-chain-runner.log')
    fs.appendFileSync(logPath, logStr, 'utf8')
  } catch {
    // Non-fatal — app.getPath may not be available in unit-test contexts.
  }

  // Console output visible in the main-process DevTools / terminal
  // eslint-disable-next-line no-console
  console.log(logStr)

  return { launched: chains.length }
}
