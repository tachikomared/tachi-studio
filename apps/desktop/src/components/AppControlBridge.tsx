// apps/desktop/src/components/AppControlBridge.tsx
//
// Renderer-side executor for the harness `app_control` tool. Mounted INSIDE the
// Router so it can navigate. Subscribes to app-control:exec, runs ONE of a curated
// allowlist of actions against the app's stores/router, and replies. The allowlist
// IS the security boundary — only reversible, non-destructive, non-financial app
// actions are exposed (no data deletion, no wallet sends, no file ops). Renders
// nothing.

import { useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useThemeStore, VALID_THEMES, type Theme } from '../store/theme.store'
import { useAgentStore } from '../store/agent.store'
import { useDesignStore } from '../store/design.store'

const TABS = [
  'home', 'chat', 'agent', 'nodes', 'design', 'media', 'artifacts', 'studio',
  'aeon', 'swarm', 'nook', 'wallet', 'learn', 'catalog', 'notebook', 'settings',
] as const

export function AppControlBridge() {
  const navigate = useNavigate()
  const location = useLocation()
  const { i18n } = useTranslation()
  // Track the route without re-subscribing the exec handler on every navigation.
  const locRef = useRef(location.pathname)
  locRef.current = location.pathname

  useEffect(() => {
    const off = window.tachi.appControl?.onExec?.(async ({ id, action, args }) => {
      const reply = (r: { ok: boolean; result?: unknown; error?: string }) => {
        try { window.tachi.appControl.result({ id, ...r }) } catch { /* window gone */ }
      }
      try {
        switch (action) {
          case 'get_app_state':
            reply({ ok: true, result: {
              theme: useThemeStore.getState().theme,
              availableThemes: VALID_THEMES,
              route: locRef.current,
              tabs: TABS,
              language: i18n.language,
              agentProvider: useAgentStore.getState().provider,
              design: { provider: useDesignStore.getState().providerId, model: useDesignStore.getState().model },
            } })
            break
          case 'set_theme': {
            const t = String(args.theme ?? '') as Theme
            if (!VALID_THEMES.includes(t)) {
              reply({ ok: false, error: `invalid theme "${String(args.theme)}"; valid: ${VALID_THEMES.join(', ')}` }); break
            }
            useThemeStore.getState().setTheme(t)
            reply({ ok: true, result: { theme: t } })
            break
          }
          case 'navigate': {
            const tab = String(args.tab ?? '').replace(/^\/+/, '')
            if (!(TABS as readonly string[]).includes(tab)) {
              reply({ ok: false, error: `unknown tab "${String(args.tab)}"; valid: ${TABS.join(', ')}` }); break
            }
            navigate('/' + tab)
            reply({ ok: true, result: { route: '/' + tab } })
            break
          }
          case 'set_language': {
            const lng = String(args.language ?? '').trim()
            if (!lng) { reply({ ok: false, error: 'language is required (e.g. "en", "ru")' }); break }
            await i18n.changeLanguage(lng)
            reply({ ok: true, result: { language: i18n.language } })
            break
          }
          case 'set_design_provider': {
            if (args.providerId) useDesignStore.getState().setProvider(String(args.providerId))
            if (args.model) useDesignStore.getState().setModel(String(args.model))
            reply({ ok: true, result: { provider: useDesignStore.getState().providerId, model: useDesignStore.getState().model } })
            break
          }
          default:
            reply({ ok: false, error: `unknown action "${String(action)}"` })
        }
      } catch (e) {
        reply({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
    return off
  }, [navigate, i18n])

  return null
}
