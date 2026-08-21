// apps/desktop/electron/services/wallet-service.ts
//
// App-wide Ethereum wallet on Base. This is the SINGLE agent wallet the whole
// app shares — nookplot (register/confirm/pay), x402 micropayments, and any
// future integration sign through it. The private key lives in the OS keychain
// (Electron safeStorage), is derived to an ethers Wallet only inside the main
// process for signing, and never crosses IPC to the renderer.
//
// Key id is shared with nook-service ('nook-private-key') so "the wallet" and
// "the nookplot agent" are the same account — connecting nookplot uses this key,
// and managing the wallet here changes the nookplot agent too.

import { BrowserWindow } from 'electron'
import { storeKey, retrieveKey, hasKey, deleteKey } from './keychain'
import { recordWalletTx } from './wallet-tx-log'
import { CHAINS, getChain, aggregateBalances, trimAmount } from '@tachi/core'
import type { PerChainBalance, AggregatedToken } from '@tachi/core'

const KEY_PK = 'nook-private-key'
const BASE_RPC = 'https://mainnet.base.org'
const BASE_CHAIN_ID = 8453

// ── Real-broadcast confirmation gate (audit S6) ────────────────────────────────
// A real (non-dry-run) fund movement must be explicitly confirmed by the user
// before it is signed + broadcast. The renderer wires a handler (main.ts ->
// window round-trip -> confirm modal); if no handler is wired (headless/tests)
// the send proceeds, so this never blocks automation that isn't user-facing.
export interface SendConfirmSummary {
  kind:   'native' | 'token'
  to:     string
  amount: string   // human-readable, e.g. "0.01"
  symbol: string   // "ETH" / "USDC" / …
  chainId?: number
}
let _sendConfirmHandler: ((s: SendConfirmSummary) => Promise<boolean>) | null = null
export function setSendConfirmHandler(fn: ((s: SendConfirmSummary) => Promise<boolean>) | null): void {
  _sendConfirmHandler = fn
}
async function requireSendConfirm(summary: SendConfirmSummary): Promise<void> {
  if (!_sendConfirmHandler) return
  const ok = await _sendConfirmHandler(summary)
  if (!ok) throw new Error('Transaction rejected in the confirmation dialog.')
}

// Base mainnet tokens shown in the wallet widget (order = display order after ETH).
// Empty address = symbol shown with "—" until a real contract address is set.
const TOKENS: { symbol: string; address: string; decimals: number }[] = [
  { symbol: 'TACHI', address: '', decimals: 18 }, // TODO: Base contract address
  { symbol: 'BNKR',  address: '', decimals: 18 }, // TODO: Base contract address (Bankr token)
  { symbol: 'USDC',  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
]

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
]

export interface WalletInfoView {
  address: string | null
  hasKey:  boolean
  chain:   string
}

export interface WalletBalances {
  address: string
  native:  { symbol: 'ETH'; amount: string }
  tokens:  { symbol: string; amount: string }[]
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('wallet:changed', getInfo())
  }
}

async function ethers() {
  return await import('ethers')
}

/** ethers Wallet from the stored key, or null if none. */
async function loadWallet() {
  const pk = retrieveKey(KEY_PK)
  if (!pk) return null
  const { Wallet, JsonRpcProvider } = await ethers()
  const provider = new JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID)
  return new Wallet(pk, provider)
}

/** Address derived from the stored key (cheap, no RPC), or null. */
let addressCache: string | null = null
async function currentAddress(): Promise<string | null> {
  const pk = retrieveKey(KEY_PK)
  if (!pk) { addressCache = null; return null }
  try {
    const { Wallet } = await ethers()
    addressCache = new Wallet(pk).address
    return addressCache
  } catch { return null }
}

export function getInfo(): WalletInfoView {
  return { address: addressCache, hasKey: hasKey(KEY_PK), chain: 'Base' }
}

/** Refresh the cached address (called on changes) and return info. */
export async function refreshInfo(): Promise<WalletInfoView> {
  await currentAddress()
  return getInfo()
}

/** Live ETH + token balances on Base. */
export async function getBalances(): Promise<WalletBalances> {
  const address = await currentAddress()
  if (!address) throw new Error('No wallet. Create or import one first.')
  const { JsonRpcProvider, Contract, formatEther, formatUnits } = await ethers()
  const provider = new JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID)

  const native = await provider.getBalance(address).then(
    (wei) => ({ symbol: 'ETH' as const, amount: trim(formatEther(wei)) }),
  ).catch(() => ({ symbol: 'ETH' as const, amount: '0' }))

  const tokens = await Promise.all(TOKENS.map(async (t) => {
    if (!t.address) return { symbol: t.symbol, amount: '—' }  // address not configured yet
    try {
      const c = new Contract(t.address, ERC20_ABI, provider)
      const bal = await c.balanceOf(address) as bigint
      return { symbol: t.symbol, amount: trim(formatUnits(bal, t.decimals)) }
    } catch { return { symbol: t.symbol, amount: '0' } }
  }))

  return { address, native, tokens }
}

function trim(s: string): string {
  // limit to 6 fractional digits, strip trailing zeros
  if (!s.includes('.')) return s
  const [w, f] = s.split('.')
  const frac = f.slice(0, 6).replace(/0+$/, '')
  return frac ? `${w}.${frac}` : w
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

export interface NewWallet { address: string; privateKey: string; mnemonic?: string }

export async function createWallet(): Promise<NewWallet> {
  const { Wallet } = await ethers()
  const w = Wallet.createRandom()
  storeKey(KEY_PK, w.privateKey)
  addressCache = w.address
  broadcast()
  return { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic?.phrase }
}

export async function importRaw(privateKey: string): Promise<WalletInfoView> {
  const { Wallet } = await ethers()
  const pk = privateKey.trim()
  let w
  try { w = new Wallet(pk) } catch { throw new Error('Invalid private key.') }
  storeKey(KEY_PK, w.privateKey)
  addressCache = w.address
  broadcast()
  return getInfo()
}

export async function importKeystore(json: string, password: string): Promise<WalletInfoView> {
  const { Wallet } = await ethers()
  let w
  try { w = await Wallet.fromEncryptedJson(json.trim(), password) }
  catch { throw new Error('Could not decrypt — wrong password or invalid keystore.') }
  storeKey(KEY_PK, w.privateKey)
  addressCache = w.address
  broadcast()
  return getInfo()
}

export async function exportKeystore(password: string): Promise<string> {
  const pk = retrieveKey(KEY_PK)
  if (!pk) throw new Error('No wallet to export.')
  if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.')
  const { Wallet } = await ethers()
  return await new Wallet(pk).encrypt(password)
}

export function forget(): WalletInfoView {
  deleteKey(KEY_PK)
  addressCache = null
  broadcast()
  return getInfo()
}

// ── Signing / sending (for x402 + other integrations) ──────────────────────────

export async function signMessage(message: string): Promise<string> {
  const w = await loadWallet()
  if (!w) throw new Error('No wallet.')
  return await w.signMessage(message)
}

export async function signTypedData(domain: unknown, types: unknown, value: unknown): Promise<string> {
  const w = await loadWallet()
  if (!w) throw new Error('No wallet.')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await w.signTypedData(domain as any, types as any, value as any)
}

export async function sendTransaction(tx: { to: string; value?: string; data?: string; amountEth?: string }): Promise<{ hash: string }> {
  const w = await loadWallet()
  if (!w) throw new Error('No wallet.')
  const { parseEther, isAddress } = await ethers()
  const to = tx.to.trim()
  if (!isAddress(to)) throw new Error('Invalid recipient address.')
  // amountEth (human "0.01") is parsed exactly via parseEther — no float loss.
  // value (raw wei string) is the lower-level path.
  let value: bigint | undefined
  if (tx.amountEth != null && tx.amountEth !== '') value = parseEther(tx.amountEth)
  else if (tx.value) value = BigInt(tx.value)
  // Confirm before signing/broadcasting a real transaction (audit S6).
  await requireSendConfirm({
    kind: 'native', to,
    amount: tx.amountEth ?? (value != null ? `${value} wei` : '0'),
    symbol: 'ETH', chainId: BASE_CHAIN_ID,
  })
  const sent = await w.sendTransaction({ to, value, data: tx.data })
  recordWalletTx({
    ts: Date.now(), kind: 'native', walletKind: 'app', chainId: BASE_CHAIN_ID,
    symbol: 'ETH', to, amount: tx.amountEth ?? (value != null ? `${value} wei` : '0'), hash: sent.hash,
  })
  return { hash: sent.hash }
}

// ── Multi-wallet store (app + named darksol agent wallets) ──────────────────────
//
// The app wallet stays at 'nook-private-key' (KEY_PK above), untouched. Agent
// wallets are named, each PK at 'darksol-wallet:<name>', tracked by a JSON index
// ('darksol-wallets') with an active-pointer ('darksol-active-wallet').

export type WalletId = { kind: 'app' } | { kind: 'agent'; name: string }

const KEY_APP_PK       = KEY_PK                        // unchanged app wallet
const KEY_AGENT_INDEX  = 'darksol-wallets'             // JSON: string[] of agent wallet names
const KEY_AGENT_ACTIVE = 'darksol-active-wallet'       // active agent wallet name
const agentPkId = (name: string) => `darksol-wallet:${name}`

function readAgentIndex(): string[] {
  const raw = retrieveKey(KEY_AGENT_INDEX)
  if (!raw) return []
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [] }
  catch { return [] }
}
function writeAgentIndex(names: string[]): void { storeKey(KEY_AGENT_INDEX, JSON.stringify(names)) }

/** Resolve the keychain PK id for a WalletId. */
function pkIdFor(id: WalletId): string {
  return id.kind === 'app' ? KEY_APP_PK : agentPkId(id.name)
}

export interface WalletListEntry { id: WalletId; label: string; address: string | null; active: boolean }

export async function listWallets(): Promise<WalletListEntry[]> {
  const { Wallet } = await ethers()
  const addrOf = (pkId: string): string | null => {
    const pk = retrieveKey(pkId)
    if (!pk) return null
    try { return new Wallet(pk).address } catch { return null }
  }
  const activeName = retrieveKey(KEY_AGENT_ACTIVE) ?? null
  const entries: WalletListEntry[] = [
    { id: { kind: 'app' }, label: 'App · NOOK · x402', address: addrOf(KEY_APP_PK), active: false },
  ]
  for (const name of readAgentIndex()) {
    entries.push({
      id: { kind: 'agent', name },
      label: name,
      address: addrOf(agentPkId(name)),
      active: name === activeName,
    })
  }
  return entries
}

export function getActiveAgentWallet(): string | null {
  return retrieveKey(KEY_AGENT_ACTIVE) ?? null
}

export function setActiveAgentWallet(name: string): void {
  if (!readAgentIndex().includes(name)) throw new Error(`Unknown agent wallet: ${name}`)
  storeKey(KEY_AGENT_ACTIVE, name)
  broadcast()
}

export async function createAgentWallet(name: string): Promise<NewWallet> {
  const clean = name.trim()
  if (!clean) throw new Error('Wallet name required.')
  if (readAgentIndex().includes(clean)) throw new Error(`Agent wallet "${clean}" already exists.`)
  const { Wallet } = await ethers()
  const w = Wallet.createRandom()
  storeKey(agentPkId(clean), w.privateKey)
  writeAgentIndex([...readAgentIndex(), clean])
  storeKey(KEY_AGENT_ACTIVE, clean)
  broadcast()
  return { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic?.phrase }
}

export async function importAgentWallet(name: string, privateKey: string): Promise<WalletListEntry[]> {
  const clean = name.trim()
  if (!clean) throw new Error('Wallet name required.')
  const { Wallet } = await ethers()
  let w
  try { w = new Wallet(privateKey.trim()) } catch { throw new Error('Invalid private key.') }
  storeKey(agentPkId(clean), w.privateKey)
  if (!readAgentIndex().includes(clean)) writeAgentIndex([...readAgentIndex(), clean])
  storeKey(KEY_AGENT_ACTIVE, clean)
  broadcast()
  return listWallets()
}

export function forgetAgentWallet(name: string): void {
  deleteKey(agentPkId(name))
  writeAgentIndex(readAgentIndex().filter((n) => n !== name))
  if (retrieveKey(KEY_AGENT_ACTIVE) === name) deleteKey(KEY_AGENT_ACTIVE)
  broadcast()
}

// ── Multi-chain balances + multi-token send ─────────────────────────────────────
//
// Per-chain provider/signer driven by the @tachi/core registry, for any WalletId.

async function providerFor(chainId: number) {
  const chain = getChain(chainId)
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const { JsonRpcProvider } = await ethers()
  return new JsonRpcProvider(chain.rpc, chainId)
}

async function signerFor(id: WalletId, chainId: number) {
  const pk = retrieveKey(pkIdFor(id))
  if (!pk) throw new Error('No wallet. Create or import one first.')
  const { Wallet } = await ethers()
  return new Wallet(pk, await providerFor(chainId))
}

const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)']

/** Balances for one wallet on one chain (native + that chain's tokens). */
async function balancesOnChain(id: WalletId, chainId: number): Promise<PerChainBalance[]> {
  const pk = retrieveKey(pkIdFor(id))
  if (!pk) return []
  const { Wallet, Contract, formatEther, formatUnits } = await ethers()
  const address = new Wallet(pk).address
  const chain = getChain(chainId)!
  const provider = await providerFor(chainId)

  const out: PerChainBalance[] = []
  const native = await provider.getBalance(address)
    .then((wei) => trimAmount(formatEther(wei))).catch(() => '0')
  out.push({ chainId, symbol: chain.nativeSymbol, amount: native })

  for (const t of chain.tokens) {
    try {
      const c = new Contract(t.address, ERC20_BAL_ABI, provider)
      const bal = await c.balanceOf(address) as bigint
      out.push({ chainId, symbol: t.symbol, amount: trimAmount(formatUnits(bal, t.decimals)) })
    } catch { out.push({ chainId, symbol: t.symbol, amount: '0' }) }
  }
  return out
}

/** Aggregated balances for a wallet. `chainId` undefined → all chains; else just that one. */
export async function getWalletBalances(
  id: WalletId,
  chainId?: number,
): Promise<{ address: string | null; tokens: AggregatedToken[] }> {
  const pk = retrieveKey(pkIdFor(id))
  if (!pk) return { address: null, tokens: [] }
  const { Wallet } = await ethers()
  const address = new Wallet(pk).address
  const targetChains = chainId != null ? [chainId] : CHAINS.map((c) => c.id)
  const rows = (await Promise.all(targetChains.map((c) => balancesOnChain(id, c)))).flat()
  return { address, tokens: aggregateBalances(rows) }
}

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint amount) returns (bool)']

/**
 * Send native or an ERC-20 on `chainId`. `tokenSymbol` 'ETH'/'POL'/native → native send;
 * otherwise resolve the token from the chain registry, or treat `tokenSymbol` as a raw
 * 0x… contract address for arbitrary tokens (decimals fetched on-chain).
 */
export async function sendToken(opts: {
  wallet: WalletId; chainId: number; tokenSymbol: string; to: string; amount: string
}): Promise<{ hash: string }> {
  const { wallet, chainId, tokenSymbol, to, amount } = opts
  const { isAddress, parseEther, parseUnits, Contract } = await ethers()
  const recipient = to.trim()
  if (!isAddress(recipient)) throw new Error('Invalid recipient address.')
  // Confirm before signing/broadcasting a real transfer (audit S6).
  await requireSendConfirm({ kind: 'token', to: recipient, amount: amount.trim(), symbol: tokenSymbol, chainId })
  const signer = await signerFor(wallet, chainId)
  const chain = getChain(chainId)!

  if (tokenSymbol === chain.nativeSymbol) {
    const tx = await signer.sendTransaction({ to: recipient, value: parseEther(amount.trim()) })
    recordWalletTx({
      ts: Date.now(), kind: 'native', walletKind: wallet.kind,
      walletName: wallet.kind === 'agent' ? wallet.name : undefined,
      chainId, symbol: tokenSymbol, to: recipient, amount: amount.trim(), hash: tx.hash,
    })
    return { hash: tx.hash }
  }

  // Registry token by symbol, else a raw contract address.
  let tokenAddr: string
  let decimals: number
  const known = chain.tokens.find((t) => t.symbol === tokenSymbol)
  if (known) { tokenAddr = known.address; decimals = known.decimals }
  else if (isAddress(tokenSymbol)) {
    tokenAddr = tokenSymbol
    const meta = new Contract(tokenAddr, ['function decimals() view returns (uint8)'], signer)
    decimals = Number(await meta.decimals())
  } else throw new Error(`Unknown token "${tokenSymbol}" on ${chain.name}.`)

  const erc20 = new Contract(tokenAddr, ERC20_TRANSFER_ABI, signer)
  const tx = await erc20.transfer(recipient, parseUnits(amount.trim(), decimals))
  recordWalletTx({
    ts: Date.now(), kind: 'token', walletKind: wallet.kind,
    walletName: wallet.kind === 'agent' ? wallet.name : undefined,
    chainId, symbol: tokenSymbol, to: recipient, amount: amount.trim(), hash: tx.hash,
  })
  return { hash: tx.hash }
}

// ── Funding (app → agent) + agent-signer limit storage ──────────────────────────

export async function fundAgentWallet(opts: {
  toAgent: string; chainId: number; amountEth: string
}): Promise<{ hash: string }> {
  const { toAgent, chainId, amountEth } = opts
  const dest = retrieveKey(agentPkId(toAgent))
  if (!dest) throw new Error(`Agent wallet "${toAgent}" not found.`)
  const { Wallet } = await ethers()
  const toAddress = new Wallet(dest).address
  // Reuse sendToken from the APP wallet so limits/native handling stay in one place.
  return sendToken({ wallet: { kind: 'app' }, chainId, tokenSymbol: getChain(chainId)!.nativeSymbol, to: toAddress, amount: amountEth })
}

export interface AgentLimits {
  maxPerTradeEth: string   // e.g. '0.05'
  dailyLimitEth:  string   // e.g. '0.20'
  dryRun:         boolean  // default true
  allowlist:      string[] // contract addresses; empty = no restriction
}
const limitsId = (name: string) => `darksol-limits:${name}`
const DEFAULT_LIMITS: AgentLimits = { maxPerTradeEth: '0.05', dailyLimitEth: '0.20', dryRun: true, allowlist: [] }

export function getAgentLimits(name: string): AgentLimits {
  const raw = retrieveKey(limitsId(name))
  if (!raw) return { ...DEFAULT_LIMITS }
  try { return { ...DEFAULT_LIMITS, ...JSON.parse(raw) } } catch { return { ...DEFAULT_LIMITS } }
}

export function setAgentLimits(name: string, limits: AgentLimits): void {
  storeKey(limitsId(name), JSON.stringify(limits))
  broadcast()
}
