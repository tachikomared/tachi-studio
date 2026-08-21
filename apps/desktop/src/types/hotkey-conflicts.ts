// apps/desktop/src/types/hotkey-conflicts.ts
//
// Static list of OS-reserved and commonly-hijacked keyboard shortcuts.
// Not exhaustive — covers the obvious traps that users are most likely to
// accidentally set. findConflict() normalises modifier aliases before matching.

/** A known conflict entry: the accelerator string and who owns it. */
interface ConflictEntry {
  /** Electron-style accelerator, stored in canonical form (normalised on import) */
  accelerator: string
  /** Human-readable owner name, e.g. 'Spotlight' */
  owner: string
}

export const KNOWN_CONFLICTS: Record<NodeJS.Platform, ConflictEntry[]> = {
  darwin: [
    { accelerator: 'Command+Space',       owner: 'Spotlight (macOS)' },
    { accelerator: 'Command+Tab',         owner: 'App Switcher (macOS)' },
    { accelerator: 'Command+Q',           owner: 'Quit Application (macOS)' },
    { accelerator: 'Command+W',           owner: 'Close Window (macOS)' },
    { accelerator: 'Command+H',           owner: 'Hide Application (macOS)' },
    { accelerator: 'Command+M',           owner: 'Minimize Window (macOS)' },
    { accelerator: 'Ctrl+Command+F',      owner: 'Toggle Fullscreen (macOS)' },
    { accelerator: 'F11',                 owner: 'Show Desktop (macOS)' },
    { accelerator: 'Command+Shift+3',     owner: 'Screenshot — full screen (macOS)' },
    { accelerator: 'Command+Shift+4',     owner: 'Screenshot — region (macOS)' },
    { accelerator: 'Command+Shift+5',     owner: 'Screenshot / Screen Recording (macOS)' },
  ],
  win32: [
    { accelerator: 'Ctrl+Shift+Space',    owner: 'NVIDIA GeForce Experience (Windows)' },
    { accelerator: 'Super+E',             owner: 'File Explorer (Windows)' },
    { accelerator: 'Super+R',             owner: 'Run dialog (Windows)' },
    { accelerator: 'Super+S',             owner: 'Windows Search (Windows)' },
    { accelerator: 'Super+L',             owner: 'Lock Screen (Windows)' },
    { accelerator: 'Super+D',             owner: 'Show Desktop (Windows)' },
    { accelerator: 'Alt+F4',              owner: 'Close Window (Windows)' },
    { accelerator: 'Ctrl+Shift+Esc',      owner: 'Task Manager (Windows)' },
  ],
  linux: [
    { accelerator: 'Super+L',             owner: 'Lock Screen (Linux/GNOME)' },
    { accelerator: 'Ctrl+Alt+T',          owner: 'Open Terminal (Linux/GNOME)' },
    { accelerator: 'Ctrl+Alt+F1',         owner: 'TTY1 switch (Linux)' },
    { accelerator: 'Ctrl+Alt+F2',         owner: 'TTY2 switch (Linux)' },
    { accelerator: 'Ctrl+Alt+F3',         owner: 'TTY3 switch (Linux)' },
    { accelerator: 'Ctrl+Alt+F4',         owner: 'TTY4 switch (Linux)' },
    { accelerator: 'Ctrl+Alt+F5',         owner: 'TTY5 switch (Linux)' },
    { accelerator: 'Ctrl+Alt+F6',         owner: 'TTY6 switch (Linux)' },
    { accelerator: 'Ctrl+Alt+F7',         owner: 'TTY7 switch (Linux)' },
    { accelerator: 'Alt+F2',              owner: 'Run Command dialog (GNOME)' },
  ],
  // Rarely targeted by TachiDesk users — empty buckets satisfy the type.
  aix:       [],
  android:   [],
  freebsd:   [],
  haiku:     [],
  netbsd:    [],
  openbsd:   [],
  sunos:     [],
  cygwin:    [],
}

// ── Key-alias normalisation ───────────────────────────────────────────────────

/** Map common aliases to their canonical Electron accelerator token. */
const ALIAS_MAP: Record<string, string> = {
  cmd:            'Command',
  command:        'Command',
  ctrl:           'Control',
  control:        'Control',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl:      'CommandOrControl',
  opt:            'Alt',
  option:         'Alt',
  win:            'Super',
  windows:        'Super',
  meta:           'Super',
  shift:          'Shift',
  alt:            'Alt',
}

function normaliseToken(token: string): string {
  const lower = token.toLowerCase()
  return ALIAS_MAP[lower] ?? (token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
}

/**
 * Normalise an Electron accelerator string so that modifier aliases and
 * capitalisation differences don't cause false misses.
 *
 * 'ctrl+shift+space' -> 'Control+Shift+Space'
 * 'Cmd+K'           -> 'Command+K'
 */
export function normaliseAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map(t => normaliseToken(t.trim()))
    .join('+')
}

/**
 * Returns the first conflict entry for `accelerator` on `platform`, or null.
 * Matching is case-insensitive and handles common modifier aliases.
 */
export function findConflict(
  accelerator: string,
  platform: NodeJS.Platform,
): { owner: string } | null {
  const needle = normaliseAccelerator(accelerator)
  const list   = KNOWN_CONFLICTS[platform] ?? []
  const hit    = list.find(e => normaliseAccelerator(e.accelerator) === needle)
  return hit ? { owner: hit.owner } : null
}
