// apps/desktop/electron/ipc/wallet.ipc.ts
//
// Typed IPC for the app-wide Base wallet (wallet-service.ts). Live "wallet:changed"
// pushes go out from the service via webContents.send; the renderer subscribes
// through window.tachi.wallet.onChanged.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import * as wallet from '../services/wallet-service'
import { isValidLimitString } from '../services/darksol-money-policy'
import { listWalletTx, verifyWalletTxLog } from '../services/wallet-tx-log'

export const walletRouter = defineRouter('wallet', {
  getInfo: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => wallet.refreshInfo(),
  }),
  getBalances: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => wallet.getBalances(),
  }),
  create: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => wallet.createWallet(),
  }),
  importRaw: route({
    input: z.object({ privateKey: z.string() }),
    output: z.any(),
    handle: async ({ privateKey }) => wallet.importRaw(privateKey),
  }),
  importKeystore: route({
    input: z.object({ json: z.string(), password: z.string() }),
    output: z.any(),
    handle: async ({ json, password }) => wallet.importKeystore(json, password),
  }),
  exportKeystore: route({
    input: z.object({ password: z.string() }),
    output: z.any(),
    handle: async ({ password }) => ({ keystore: await wallet.exportKeystore(password) }),
  }),
  forget: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => wallet.forget(),
  }),
  signMessage: route({
    input: z.object({ message: z.string() }),
    output: z.any(),
    handle: async ({ message }) => ({ signature: await wallet.signMessage(message) }),
  }),
  sendTransaction: route({
    input: z.object({ to: z.string(), value: z.string().optional(), data: z.string().optional(), amountEth: z.string().optional() }),
    output: z.any(),
    handle: async (tx) => wallet.sendTransaction(tx),
  }),
  // ── Multi-wallet / multi-chain / multi-token (darksol foundation) ──────────────
  listWallets: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => wallet.listWallets(),
  }),
  setActiveAgentWallet: route({
    input: z.object({ name: z.string().min(1) }),
    output: z.any(),
    handle: async ({ name }) => { wallet.setActiveAgentWallet(name); return wallet.listWallets() },
  }),
  createAgentWallet: route({
    input: z.object({ name: z.string().min(1) }),
    output: z.any(),
    handle: async ({ name }) => wallet.createAgentWallet(name),
  }),
  importAgentWallet: route({
    input: z.object({ name: z.string().min(1), privateKey: z.string().min(1) }),
    output: z.any(),
    handle: async ({ name, privateKey }) => wallet.importAgentWallet(name, privateKey),
  }),
  forgetAgentWallet: route({
    input: z.object({ name: z.string().min(1) }),
    output: z.any(),
    handle: async ({ name }) => { wallet.forgetAgentWallet(name); return wallet.listWallets() },
  }),
  walletBalances: route({
    input: z.object({
      kind: z.enum(['app', 'agent']),
      name: z.string().optional(),
      chainId: z.number().optional(),
    }),
    output: z.any(),
    handle: async ({ kind, name, chainId }) =>
      wallet.getWalletBalances(kind === 'app' ? { kind: 'app' } : { kind: 'agent', name: name! }, chainId),
  }),
  sendToken: route({
    input: z.object({
      kind: z.enum(['app', 'agent']), name: z.string().optional(),
      chainId: z.number(), tokenSymbol: z.string().min(1), to: z.string().min(1), amount: z.string().min(1),
    }),
    output: z.any(),
    handle: async ({ kind, name, chainId, tokenSymbol, to, amount }) =>
      wallet.sendToken({ wallet: kind === 'app' ? { kind: 'app' } : { kind: 'agent', name: name! }, chainId, tokenSymbol, to, amount }),
  }),
  fundAgentWallet: route({
    input: z.object({ toAgent: z.string().min(1), chainId: z.number(), amountEth: z.string().min(1) }),
    output: z.any(),
    handle: async (a) => wallet.fundAgentWallet(a),
  }),
  getAgentLimits: route({
    input: z.object({ name: z.string().min(1) }),
    output: z.any(),
    handle: async ({ name }) => wallet.getAgentLimits(name),
  }),
  setAgentLimits: route({
    input: z.object({
      name: z.string().min(1),
      limits: z.object({
        // Reject garbage limit strings at the boundary — an unparseable cap
        // would otherwise fail-closed at enforcement but reads as "no limit set"
        // in the UI (audit 2026-06-12, MEDIUM).
        maxPerTradeEth: z.string().refine(isValidLimitString, { message: 'maxPerTradeEth must be a non-negative decimal (e.g. "0.05")' }),
        dailyLimitEth:  z.string().refine(isValidLimitString, { message: 'dailyLimitEth must be a non-negative decimal (e.g. "0.20")' }),
        dryRun: z.boolean(), allowlist: z.array(z.string()),
      }),
    }),
    output: z.any(),
    handle: async ({ name, limits }) => { wallet.setAgentLimits(name, limits); return wallet.getAgentLimits(name) },
  }),
  listNetworks: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => (await import('@tachi/core')).CHAINS,
  }),
  // Persistent audit trail of real (broadcast) transactions (audit 2026-06-12).
  listTx: route({
    input: z.object({ limit: z.number().int().positive().max(2000).optional() }),
    output: z.any(),
    handle: async ({ limit }) => listWalletTx(limit ?? 200),
  }),
  // Tamper-evidence check over the journal's SHA-256 hash chain
  // (STEAL 2026-06-12 cluster D; entries sealed since 2026-06-13).
  verifyTxLog: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => verifyWalletTxLog(),
  }),
})
