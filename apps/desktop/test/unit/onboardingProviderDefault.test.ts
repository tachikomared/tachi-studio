// apps/desktop/test/unit/onboardingProviderDefault.test.ts
//
// THE FIRST-RUN PROVIDER PICK NEVER REACHED THE CHAT.
//
// Onboarding's provider step wrote `selectedProvider` into a PERSISTED zustand
// store — and nothing ever read it back except the highlight ring on that very
// screen. So a user who picked Bankr on the first screen, pasted a key, tested
// it green and pressed through, opened a chat on FreeLLM: `newConversation()`
// seeds from chat.store's `autoFallback`, whose initial value is the local
// router and which is only ever updated by an explicit in-chat provider switch.
//
// Two id spaces made it easy to miss. The step speaks its own short ids
// ('freellmapi', 'ollama'); everything downstream speaks the canonical registry
// ids ('freellmapi-local', 'ollama-local'). A hand-copied second map is how this
// would break again silently, so the wizard goes through `canonicalProviderId`,
// which is derived from the step's own table.
//
// Pinned here: the mapping is real (checked against the registry, not a literal
// list), the chat store genuinely adopts what the mapping produces, and BOTH
// wizard exits hand the pick over — someone who chooses a provider and then hits
// SKIP ALL has still told us what they want.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Renderer globals the persist middleware needs, installed BEFORE the stores load.
const memStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  tachi: { safeStorage: { isAvailable: async () => ({ available: false }) } },
}

const { canonicalProviderId } = await import('../../src/pages/onboarding/steps/ProviderStep')
const { useChatStore } = await import('../../src/store/chat.store')
const { isProviderId } = await import('@tachi/core/src/providers/registry')

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const wizardSrc = read('src/pages/onboarding/OnboardingWizard.tsx')
const stepSrc   = read('src/pages/onboarding/steps/ProviderStep.tsx')

/** Every onboarding id the step offers, read out of the step's own table. */
const ONBOARDING_IDS = [...stepSrc.matchAll(/\{\s*id:\s*'([^']+)',\s*canonical:/g)].map(m => m[1])

describe('canonicalProviderId', () => {
  it('covers every provider the step actually offers', () => {
    expect(ONBOARDING_IDS.length).toBeGreaterThan(0)
    for (const id of ONBOARDING_IDS) {
      expect(canonicalProviderId(id), `no canonical id for onboarding provider '${id}'`).toBeTruthy()
    }
  })

  it('maps onto ids the REGISTRY knows, not strings that merely look right', () => {
    for (const id of ONBOARDING_IDS) {
      const canonical = canonicalProviderId(id)
      expect(isProviderId(canonical), `${id} → ${canonical} is not a registry provider`).toBe(true)
    }
  })

  it('translates the ids that genuinely differ between the two spaces', () => {
    // The two that would silently no-op if the step's short id were passed on.
    expect(canonicalProviderId('freellmapi')).toBe('freellmapi-local')
    expect(canonicalProviderId('ollama')).toBe('ollama-local')
  })

  it('answers with nothing for an unknown or absent pick', () => {
    expect(canonicalProviderId(undefined)).toBeUndefined()
    expect(canonicalProviderId('')).toBeUndefined()
    expect(canonicalProviderId('not-a-provider')).toBeUndefined()
  })
})

describe('the chat default really follows autoFallback', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [], folders: [], activeConversationId: null,
      autoFallback: { providerId: 'freellmapi-local', model: 'auto' },
    })
  })

  it('opens a new chat on the provider onboarding chose', () => {
    const canonical = canonicalProviderId('bankr-gateway')!
    useChatStore.getState().setAutoFallback(canonical, 'auto')

    const id = useChatStore.getState().newConversation()
    const conv = useChatStore.getState().conversations.find(c => c.id === id)
    expect(conv?.providerId).toBe('bankr-gateway')
  })

  it('without the wiring it would have opened on the local router', () => {
    // The pre-fix behaviour, as the control: untouched autoFallback.
    const id = useChatStore.getState().newConversation()
    expect(useChatStore.getState().conversations.find(c => c.id === id)?.providerId).toBe('freellmapi-local')
  })

  it('keeps the model as auto — onboarding never asked for one', () => {
    useChatStore.getState().setAutoFallback('bankr-gateway', 'auto')
    expect(useChatStore.getState().autoFallback.model).toBe('auto')
  })
})

describe('both wizard exits hand the pick over', () => {
  it('the wizard reads the pick through canonicalProviderId, not a second map', () => {
    expect(wizardSrc).toContain('canonicalProviderId')
    expect(wizardSrc).toContain('setAutoFallback')
    // A hand-copied canonical id in the wizard is the drift this guards against.
    expect(wizardSrc).not.toMatch(/'(freellmapi|ollama)-local'/)
  })

  it('FINISH and SKIP ALL both adopt it', () => {
    const calls = [...wizardSrc.matchAll(/adoptProviderChoice\(\)/g)].length
    // one definition site is `const adoptProviderChoice = useCallback(` — the
    // invocations are what matter, and there must be one per exit.
    expect(calls, 'adoptProviderChoice() must be invoked from finish AND skipAll').toBeGreaterThanOrEqual(2)
    for (const exit of ['const skipAll', 'const finish']) {
      const at = wizardSrc.indexOf(exit)
      expect(at, `${exit} not found`).toBeGreaterThan(-1)
      const body = wizardSrc.slice(at, at + 400)
      expect(body, `${exit} does not adopt the provider pick`).toContain('adoptProviderChoice()')
    }
  })
})
