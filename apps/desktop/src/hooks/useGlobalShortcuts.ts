// apps/desktop/src/hooks/useGlobalShortcuts.ts
//
// Registers in-app keyboard shortcuts (fired only while the window is focused).
// Accelerators are read from the user's saved hotkey settings; missing entries
// fall back to each action's defaultAccelerator from HOTKEY_ACTIONS.
//
// Global shortcuts (OS-wide) are handled by electron/services/hotkey-manager.ts.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../store/chat.store'
import { HOTKEY_ACTIONS } from '../types/hotkeys'
import { shouldSuppressGlobalHotkeys } from './useFocusStack'

/** Parse an Electron accelerator string into a simple {key, meta, ctrl, shift, alt} shape. */
interface ParsedAccel {
  key:   string
  meta:  boolean
  ctrl:  boolean
  shift: boolean
  alt:   boolean
}

function parseAccelerator(accel: string): ParsedAccel {
  const parts  = accel.split('+')
  const lc     = parts.map(p => p.toLowerCase())
  // Last token is the non-modifier key. An accelerator ending in '+' (e.g.
  // "CommandOrControl++") splits to a trailing empty token — the real key is '+'.
  const keyPart = parts[parts.length - 1] || '+'
  return {
    key:   keyPart.toLowerCase(),
    meta:  lc.some(p => p === 'command' || p === 'commandorcontrol'),
    ctrl:  lc.some(p => p === 'control' || p === 'ctrl' || p === 'commandorcontrol'),
    shift: lc.some(p => p === 'shift'),
    alt:   lc.some(p => p === 'alt' || p === 'option'),
  }
}

function matchesAccel(e: KeyboardEvent, parsed: ParsedAccel): boolean {
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const modOk = (parsed.meta  ? (isMac ? e.metaKey : e.ctrlKey)  : true)
             && (parsed.ctrl  ? (!isMac ? e.ctrlKey : e.metaKey)   : true)
             && (parsed.shift ? e.shiftKey : !e.shiftKey)
             && (parsed.alt   ? e.altKey   : !e.altKey)
  // CommandOrControl triggers on meta (mac) or ctrl (win/linux)
  const cmdOrCtrl = parsed.meta && parsed.ctrl
    ? (e.metaKey || e.ctrlKey)
    : true
  return modOk && cmdOrCtrl && e.key.toLowerCase() === parsed.key
}

/** Resolve a hotkey action's accelerator: user override or default. */
function resolveAccel(actionId: string, overrides: Record<string, string>): string {
  const action = HOTKEY_ACTIONS.find(a => a.id === actionId)
  if (!action) return ''
  return overrides[actionId] ?? action.defaultAccelerator
}

export function useGlobalShortcuts(): void {
  const navigate = useNavigate()
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({})

  // Load user's saved accelerators once on mount.
  useEffect(() => {
    window.tachi.hotkeys.load().then(setHotkeys).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore events from inside inputs/textareas/contenteditable to avoid
      // hijacking normal typing — except for modifier-only combos.
      const target = e.target as HTMLElement
      const inEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      if (inEditable) return
      // Also defer when a modal/dropdown/custom-input region owns focus.
      if (shouldSuppressGlobalHotkeys()) return

      const paletteAccel = parseAccelerator(resolveAccel('palette', hotkeys))
      if (matchesAccel(e, paletteAccel)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('tachi:toggle-palette'))
        return
      }

      const newChatAccel = parseAccelerator(resolveAccel('new-chat', hotkeys))
      if (matchesAccel(e, newChatAccel)) {
        e.preventDefault()
        useChatStore.getState().newConversation()
        navigate('/chat')
        return
      }

      const helpAccel = parseAccelerator(resolveAccel('help', hotkeys))
      if (matchesAccel(e, helpAccel)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('tachi:show-shortcut-help'))
        return
      }

      const toggleHistoryAccel = parseAccelerator(resolveAccel('toggle-history', hotkeys))
      if (matchesAccel(e, toggleHistoryAccel)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('tachi:toggle-history'))
        return
      }

      const focusInputAccel = parseAccelerator(resolveAccel('focus-input', hotkeys))
      if (matchesAccel(e, focusInputAccel)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('tachi:focus-input'))
        return
      }

      // Cmd/Ctrl+, — settings (not remappable via hotkeys UI, kept as-is)
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        navigate('/settings')
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate, hotkeys])
}
