// apps/desktop/src/types/hotkeys.ts
//
// Registry of every remappable keyboard action in TachiDesk.
// Scope 'global' means OS-wide via Electron globalShortcut (fires even when
// the app is not focused). Scope 'in-app' means DOM keydown listened only
// while the app window is focused.

export interface HotkeyAction {
  /** Stable identifier stored in settings.hotkeys */
  id: string
  /** Human-readable label shown in the Shortcuts UI */
  label: string
  /** One-line description shown below the label */
  description: string
  /** Electron accelerator string, e.g. 'Alt+Shift+Space' */
  defaultAccelerator: string
  /** global = registered via globalShortcut; in-app = DOM keydown only */
  scope: 'global' | 'in-app'
}

export const HOTKEY_ACTIONS: HotkeyAction[] = [
  {
    id: 'overlay-capture',
    label: 'Screen capture',
    description: 'Open the screen-region overlay to share with the current chat',
    defaultAccelerator: 'Alt+Shift+Space',
    scope: 'global',
  },
  {
    id: 'quick-ask',
    label: 'Quick ask',
    description: 'Summon the floating ask bar from anywhere (answers via the keyless FreeLLM router)',
    defaultAccelerator: 'CommandOrControl+Shift+Space',
    scope: 'global',
  },
  {
    id: 'palette',
    label: 'Command palette',
    description: 'Toggle the command palette (Cmd+K / Ctrl+K)',
    defaultAccelerator: 'CommandOrControl+K',
    scope: 'in-app',
  },
  {
    id: 'new-chat',
    label: 'New chat',
    description: 'Start a fresh conversation',
    defaultAccelerator: 'CommandOrControl+N',
    scope: 'in-app',
  },
  {
    id: 'help',
    label: 'Shortcut help',
    description: 'Show available keyboard shortcuts',
    defaultAccelerator: 'CommandOrControl+/',
    scope: 'in-app',
  },
  {
    id: 'toggle-history',
    label: 'Toggle history',
    description: 'Show or hide the conversation history sidebar',
    defaultAccelerator: 'CommandOrControl+B',
    scope: 'in-app',
  },
  {
    id: 'focus-input',
    label: 'Focus input',
    description: 'Move keyboard focus to the chat input box',
    defaultAccelerator: 'CommandOrControl+L',
    scope: 'in-app',
  },
]
