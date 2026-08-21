// apps/desktop/electron/services/key-events.ts
//
// Tiny in-process pub/sub for keychain mutations — the key-change signal the app
// was missing (audit 2026-06-12, dimension 5 root cause). keychain.storeKey /
// deleteKey emit here; subscribers (sidecar-manager) react so a rotated/deleted
// key cannot keep working inside a live sidecar that was seeded a copy at spawn.
//
// Zero imports (no electron) so it sits at the bottom of the dependency graph:
//   keychain → key-events ← sidecar-manager   (no cycle)

export type KeyChangeListener = (keyId: string) => void

const listeners = new Set<KeyChangeListener>()

/** Subscribe to key changes. Returns an unsubscribe function. */
export function onKeyChange(fn: KeyChangeListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Notify subscribers that `keyId` was stored/rotated/deleted. A '*' id means a
 * bulk change (e.g. deleteAllKeys). A listener that throws is isolated — it must
 * never break the key write that triggered the emit.
 */
export function emitKeyChange(keyId: string): void {
  for (const fn of [...listeners]) {
    try { fn(keyId) } catch { /* never let a subscriber break a key write */ }
  }
}
