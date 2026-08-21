// apps/desktop/src/components/FirstLaunchGate.tsx
//
// One-time first-launch LEARN landing. Mounted INSIDE the main app router (so it
// can navigate) as a sibling of the routes; renders nothing. On a genuinely
// fresh install it redirects to /learn once and shows the welcome hero; for an
// existing user it silently records the done-flag and never touches navigation.
//
// The decision is the PURE shouldShowFirstLaunch() over persisted signals we
// read here: the done-flag, the chat store's persisted conversations, and the
// saved node flows (current canvas + on-disk flows). The chat store is encrypted
// (async rehydration) so we wait for it before counting; the nodes store uses
// plain localStorage and is hydrated synchronously.

import { useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useChatStore } from '../store/chat.store'
import { useNodesStore } from '../pages/nodes/store/nodes.store'
import { useFirstLaunchStore } from '../store/firstLaunch.store'
import {
  shouldShowFirstLaunch,
  isFirstLaunchDone,
  readFirstLaunchFlag,
  markFirstLaunchDone,
} from '../utils/firstLaunch'

/** Ensure the (encrypted, async) chat store has finished rehydrating so its
 *  persisted conversations are readable. Best-effort — falls through on error. */
async function ensureChatHydrated(): Promise<void> {
  try {
    if (useChatStore.persist.hasHydrated()) return
    await useChatStore.persist.rehydrate()
  } catch {
    /* best-effort: count whatever state exists */
  }
}

/** Count saved flows: the current persisted canvas graph (nodes store) counts as
 *  one, plus any flows saved to disk (the FlowsRail source of truth). */
async function readSavedFlowCount(): Promise<number> {
  let count = useNodesStore.getState().nodes.length > 0 ? 1 : 0
  try {
    const r = await window.tachi?.nodes?.listFlows?.()
    if (r?.ok && Array.isArray(r.flows)) count += r.flows.length
  } catch {
    /* IPC unavailable → rely on the canvas signal only */
  }
  return count
}

export function FirstLaunchGate() {
  const navigate = useNavigate()
  const location = useLocation()
  const heroVisible = useFirstLaunchStore(s => s.heroVisible)
  const ran = useRef(false)
  const sawLearn = useRef(false)
  // Live pathname for the one-shot decision (the async resolves after mount).
  const locRef = useRef(location.pathname)
  locRef.current = location.pathname

  useEffect(() => {
    // Run the decision exactly once. The ref (preserved across React 18
    // StrictMode's setup→cleanup→setup double-invoke on the same instance) is
    // what makes this a true one-shot; we deliberately do NOT abort on cleanup,
    // since this gate lives for the whole app session and must not be cancelled
    // by StrictMode's simulated unmount before the async decision resolves.
    if (ran.current) return
    ran.current = true

    // Fast path: a prior session already decided — never touch navigation again
    // (this is what guarantees no re-show on update / no navigation hijack).
    if (isFirstLaunchDone()) return

    void (async () => {
      await ensureChatHydrated()
      const conversationCount = useChatStore.getState().conversations.length
      const savedFlowCount = await readSavedFlowCount()

      const show = shouldShowFirstLaunch({
        flag: readFirstLaunchFlag(),
        conversationCount,
        savedFlowCount,
      })

      if (show) {
        // Only redirect from the NEUTRAL default (/home) — the explore/skip
        // onboarding path and returning no-data users. A deliberate onboarding
        // destination (RUN LOCAL → /catalog, cloud → /chat) is respected and NOT
        // hijacked; since we neither redirect nor set the flag in that case, a
        // later launch (which starts at /home again) lands the Learn hero.
        //
        // The done-flag is persisted only when the user dismisses (LearnPage) or
        // navigates away (the observer below) — never here, so the hero survives
        // if the app is closed before it is acknowledged.
        if (locRef.current === '/home') {
          useFirstLaunchStore.getState().showHero()
          navigate('/learn')
        }
      } else {
        // Existing user (or data that raced in): record silently, show nothing.
        markFirstLaunchDone()
      }
    })()
  }, [navigate])

  // "Navigating away sets the flag." Observed HERE (a component that lives for
  // the whole session) rather than in LearnPage's unmount, so React 18
  // StrictMode's simulated unmount can't spuriously dismiss the hero. Once the
  // hero has been shown AND the user has actually reached /learn, leaving /learn
  // for any other route acknowledges it (persists the flag + hides).
  useEffect(() => {
    if (!heroVisible) return
    if (location.pathname === '/learn') { sawLearn.current = true; return }
    if (sawLearn.current) useFirstLaunchStore.getState().dismissHero()
  }, [location.pathname, heroVisible])

  return null
}
