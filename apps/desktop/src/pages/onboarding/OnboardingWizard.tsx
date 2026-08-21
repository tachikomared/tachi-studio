import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WelcomeStep } from './steps/WelcomeStep'
import { OB1PrivacyChoice } from './steps/OB1PrivacyChoice'
import { ProviderStep, canonicalProviderId } from './steps/ProviderStep'
import { useChatStore } from '../../store/chat.store'
import { VibeStep } from './steps/VibeStep'
import { DoneStep, VIBE_ROUTES } from './steps/DoneStep'
import { useOnboardingStore } from '../../store/onboarding.store'
import type { FirstRunChoice } from '../../store/onboarding.store'

type StepKey = 'welcome' | 'privacy' | 'provider' | 'vibe' | 'done'

// First-run three-card choice (UX-benchmark #1): the welcome pick decides the
// path through the wizard.
//  - local   → privacy polar choice matters (PRIVATE+LOCAL lives there), no
//              cloud provider form; finish routes to /catalog to grab a model.
//  - cloud   → straight to the provider key form (they already chose cloud,
//              the FREE-vs-PRIVATE fork would contradict it), vibe, done.
//  - explore → no steps at all; the welcome card completes the wizard.
const FULL_FLOW: StepKey[] = ['welcome', 'privacy', 'provider', 'vibe', 'done']
const FLOWS: Record<FirstRunChoice, StepKey[]> = {
  local: ['welcome', 'privacy', 'done'],
  cloud: ['welcome', 'provider', 'vibe', 'done'],
  explore: ['welcome'],
}

interface OnboardingWizardProps {
  /** Called when wizard is done. Receives optional route to navigate to. */
  onComplete: (targetRoute?: string) => void
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const { t } = useTranslation('onboarding')
  // `selectedVibe` is deliberately NOT subscribed here: finish() reads the live
  // snapshot via getState() (a stale hook closure once dropped the route), so a
  // second, unread copy only bought this component extra re-renders.
  const { setComplete, firstRunChoice, setFirstRunChoice } = useOnboardingStore()

  // 'explore' finishes immediately from the welcome card, so if it is ever the
  // rehydrated value while the wizard still shows, render the full flow.
  const flow: StepKey[] = firstRunChoice && firstRunChoice !== 'explore'
    ? FLOWS[firstRunChoice]
    : FULL_FLOW
  const stepKey = flow[Math.min(stepIndex, flow.length - 1)]

  const advance = useCallback(() => {
    setStepIndex(i => Math.min(i + 1, flow.length - 1))
  }, [flow.length])

  const goBack = useCallback(() => {
    setStepIndex(i => Math.max(i - 1, 0))
  }, [])

  /**
   * Make the first-run provider pick the one the chat OPENS on.
   *
   * `newConversation()` seeds a new chat from chat.store's `autoFallback`, whose
   * initial value is the local router — so a user who picked Bankr on the first
   * screen, typed their key, and pressed through, landed in a FreeLLM chat. The
   * pick was stored (`selectedProvider`) and read by nothing but the highlight on
   * the step itself.
   *
   * Model stays 'auto': onboarding asks for a provider, never a model, and
   * inventing one here would be a claim the user did not make.
   *
   * Called from BOTH exits — someone who picks a provider and then hits SKIP ALL
   * has still told us what they want.
   */
  const adoptProviderChoice = useCallback(() => {
    const canonical = canonicalProviderId(useOnboardingStore.getState().selectedProvider)
    if (canonical) useChatStore.getState().setAutoFallback(canonical, 'auto')
  }, [])

  const skipAll = useCallback(async () => {
    adoptProviderChoice()
    try {
      await window.tachi.settings.save({ onboardingComplete: true } as Parameters<typeof window.tachi.settings.save>[0])
    } catch { /* proceed */ }
    setComplete(true)
    onComplete()
  }, [setComplete, onComplete, adoptProviderChoice])

  const finish = useCallback(async () => {
    adoptProviderChoice()
    try {
      await window.tachi.settings.save({ onboardingComplete: true } as Parameters<typeof window.tachi.settings.save>[0])
    } catch { /* proceed */ }
    setComplete(true)
    // RUN LOCAL intent wins: land in the catalog to download a model. Cloud
    // path honors the vibe pick, defaulting to /chat (they set up a key to talk).
    // Read the CURRENT store snapshot, not the hook closure — the async save
    // above yields to React, and a stale closure here silently dropped the
    // route (new users picked RUN LOCAL and landed on Home, not the catalog).
    const { firstRunChoice: choice, selectedVibe: vibe } = useOnboardingStore.getState()
    const route = choice === 'local'
      ? '/catalog'
      : vibe
      ? VIBE_ROUTES[vibe]
      : choice === 'cloud'
      ? '/chat'
      : undefined
    onComplete(route)
  }, [setComplete, onComplete, adoptProviderChoice])

  const handleChoice = useCallback((choice: FirstRunChoice) => {
    setFirstRunChoice(choice)
    if (choice === 'explore') {
      void skipAll()
    } else {
      setStepIndex(1)
    }
  }, [setFirstRunChoice, skipAll])

  return (
    <div style={shell}>
      {/* Step indicator */}
      <div style={stepBar}>
        {flow.map((key, i) => {
          const isComplete = stepIndex > i
          const isActive = stepIndex === i

          return (
            <React.Fragment key={key}>
              {i > 0 && (
                <div style={{
                  ...connector,
                  background: isComplete ? 'var(--accent)' : 'var(--border)',
                }} />
              )}
              <div style={stepItem}>
                <div style={{
                  ...stepDot,
                  background: isActive
                    ? 'var(--accent)'
                    : isComplete
                    ? 'var(--success)'
                    : 'var(--bg-elevated)',
                  border: isActive || isComplete
                    ? '2px solid transparent'
                    : '2px solid var(--border)',
                  color: isActive || isComplete ? '#ffffff' : 'var(--text-dim)',
                }}>
                  {isComplete ? '+' : i + 1}
                </div>
                <span style={{
                  ...stepLabel,
                  color: isActive
                    ? 'var(--text-primary)'
                    : isComplete
                    ? 'var(--text-muted)'
                    : 'var(--text-dim)',
                }}>
                  {t(`steps.${key}`)}
                </span>
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* Step content area */}
      <div style={contentArea}>
        {stepKey === 'welcome' && (
          <WelcomeStep onChoice={handleChoice} />
        )}
        {stepKey === 'privacy' && (
          <OB1PrivacyChoice onContinue={advance} onBack={goBack} onSkip={advance} />
        )}
        {stepKey === 'provider' && (
          <ProviderStep onContinue={advance} onBack={goBack} onSkip={advance} />
        )}
        {stepKey === 'vibe' && (
          <VibeStep onContinue={advance} onBack={goBack} />
        )}
        {stepKey === 'done' && (
          <DoneStep onFinish={finish} onBack={goBack} />
        )}
      </div>

      {/* Footer */}
      <div style={footer}>
        <span style={footerText}>
          {t('footer.step', { current: stepIndex + 1, total: flow.length })}
        </span>
        {stepIndex < flow.length - 1 && (
          <button onClick={skipAll} style={footerSkip}>
            {t('footer.skipAll')}
          </button>
        )}
      </div>
    </div>
  )
}

const shell: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--bg-base)',
  display: 'flex',
  flexDirection: 'column',
  color: 'var(--text-primary)',
  zIndex: 9999,
}

const stepBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px 32px 20px',
  borderBottom: '2px solid var(--border)',
  background: 'var(--bg-surface)',
  gap: 0,
  flexShrink: 0,
}

const stepItem: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
}

const stepDot: React.CSSProperties = {
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  flexShrink: 0,
}

const connector: React.CSSProperties = {
  height: 2,
  width: 60,
  marginBottom: 22,
  flexShrink: 0,
}

const stepLabel: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
}

const contentArea: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px 0',
}

const footer: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 32px',
  borderTop: '2px solid var(--border)',
  background: 'var(--bg-surface)',
  flexShrink: 0,
}

const footerText: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  color: 'var(--text-dim)',
  letterSpacing: '0.06em',
}

const footerSkip: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  color: 'var(--text-muted)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
  letterSpacing: '0.04em',
}
