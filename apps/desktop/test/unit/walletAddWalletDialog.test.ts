// apps/desktop/test/unit/walletAddWalletDialog.test.ts
//
// THE DEAD "ADD AGENT WALLET" FLOW — regression pins.
//
// WalletSwitcher's add-wallet button called window.prompt(). That global is not
// implemented in Electron's renderer: it THROWS, so the handler died on its
// first line and the button did nothing at all in every packaged build. The fix
// is an in-app dialog (PromptDialog + usePromptText on the house
// ConfirmProvider), reusing the same useDialog() a11y hook as <Modal> and the
// canvas dialogs.
//
// None of this can be driven in the repo's node-only test env (no jsdom), so the
// contract is pinned against the SOURCE, the same way chatA11y / nodesA11y pin
// theirs. Four contracts:
//   1. SWEEP   — zero native prompt/confirm/alert anywhere under src/pages/wallet.
//   2. DIALOG  — PromptDialog is a real labelled modal: role/aria-modal, the
//                input is the first focusable (that is what puts initial focus
//                in it), Enter submits, blank can never resolve a value.
//   3. WIRING  — WalletSwitcher awaits the dialog and refuses a blank name.
//   4. I18N    — every key the switcher asks for exists, non-empty, in all 8
//                locales; and useConfirm()'s API is untouched for its callers.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP     = path.resolve(__dirname, '../..')
const WALLET  = path.join(APP, 'src/pages/wallet')
const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

/** Drop comments so an assertion about CODE is never satisfied by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every .ts/.tsx under src/pages/wallet, repo-relative, sorted. */
function walletSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) out.push(path.relative(APP, p).replace(/\\/g, '/'))
    }
  }
  walk(WALLET)
  return out.sort()
}

function walletNs(lang: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'wallet.json'), 'utf8')) as Record<string, unknown>
}

function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

// ── 1. Sweep: no native dialogs anywhere in the wallet surface ────────────────

describe('wallet surface: zero native browser dialogs', () => {
  const files = walletSources()

  it('finds the wallet sources to sweep', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
    expect(files).toContain('src/pages/wallet/components/WalletSwitcher.tsx')
    expect(files).toContain('src/pages/wallet/WalletPage.tsx')
  })

  for (const rel of files) {
    it(`${rel}: no window.prompt / window.confirm / window.alert`, () => {
      const s = stripComments(read(rel))
      expect(s, rel).not.toMatch(/window\s*\.\s*(prompt|confirm|alert)\s*\(/)
    })

    it(`${rel}: no bare prompt() / alert() global call`, () => {
      const s = stripComments(read(rel))
      // Negative lookbehind keeps `promptText(`, `.prompt(` and `myAlert(` clean —
      // only a bare global call trips this.
      expect(s, rel).not.toMatch(/(?<![\w$.])prompt\s*\(/)
      expect(s, rel).not.toMatch(/(?<![\w$.])alert\s*\(/)
    })

    it(`${rel}: a bare confirm() call only ever means the house dialog`, () => {
      const s = stripComments(read(rel))
      const callsConfirm = /(?<![\w$.])confirm\s*\(/.test(s)
      if (callsConfirm) {
        // The only legitimate `confirm(...)` is the one from useConfirm().
        expect(s, `${rel} calls confirm() without importing useConfirm`).toMatch(
          /import\s*\{[^}]*\buseConfirm\b[^}]*\}\s*from\s*['"][^'"]*ConfirmProvider['"]/,
        )
      }
    })
  }
})

// ── 2. The dialog contract ───────────────────────────────────────────────────

describe('PromptDialog: a real, labelled, keyboard-usable modal', () => {
  const src = () => read('src/components/PromptDialog.tsx')

  it('is a labelled modal dialog', () => {
    const s = stripComments(src())
    expect(s).toContain('role="dialog"')
    expect(s).toContain('aria-modal="true"')
    expect(s).toContain('aria-labelledby={titleId}')
    // The header text carries the accessible name.
    expect(s).toContain('id={titleId}')
  })

  it('delegates focus trap / Escape / focus restore to the house useDialog hook', () => {
    const s = stripComments(src())
    expect(s).toMatch(/import\s*\{\s*useDialog\s*\}\s*from\s*'\.\.\/hooks\/useDialog'/)
    expect(s).toMatch(/useDialog<HTMLDivElement>\(onCancel\)/)
  })

  it('useDialog still provides the three behaviours this dialog leans on', () => {
    const s = stripComments(read('src/hooks/useDialog.ts'))
    expect(s).toContain("e.key === 'Escape'")          // Escape closes
    expect(s).toContain("e.key === 'Tab'")             // focus trap
    expect(s).toContain('prevFocus?.focus?.()')        // focus restore
    expect(s).toMatch(/const first = focusables\(\)\[0\]/) // initial focus = FIRST focusable
  })

  it('puts the text input FIRST so initial focus lands in it, not on a button', () => {
    const s = stripComments(src())
    const input  = s.indexOf('<input')
    const button = s.indexOf('<button')
    expect(input, 'PromptDialog must render an <input>').toBeGreaterThan(-1)
    expect(button, 'PromptDialog must render buttons').toBeGreaterThan(-1)
    expect(input, 'the input must precede every button in DOM order').toBeLessThan(button)
  })

  it('labels the input with a real <label htmlFor>', () => {
    const s = stripComments(src())
    expect(s).toContain('htmlFor={inputId}')
    expect(s).toContain('id={inputId}')
  })

  it('Enter submits', () => {
    const s = stripComments(src())
    expect(s).toMatch(/e\.key === 'Enter'/)
    expect(s).toMatch(/e\.key === 'Enter'\s*\)\s*\{[^}]*submit\(\)/)
  })

  it('a blank / whitespace-only value can never resolve — OK is disabled and submit no-ops', () => {
    const s = stripComments(src())
    expect(s).toMatch(/const trimmed = value\.trim\(\)/)
    expect(s).toMatch(/const canSubmit = trimmed\.length > 0/)
    // submit() is the ONLY path to onOk, and it is guarded.
    expect(s).toMatch(/const submit = \(\) => \{ if \(canSubmit\) onOk\(trimmed\) \}/)
    expect(s).toContain('disabled={!canSubmit}')
    // onOk is never called anywhere except inside the guarded submit().
    const onOkCalls = [...s.matchAll(/onOk\(/g)]
    expect(onOkCalls.length, 'onOk must be called from exactly one guarded place').toBe(1)
  })

  it('resolves the TRIMMED value, not the raw input', () => {
    const s = stripComments(src())
    expect(s).toContain('onOk(trimmed)')
  })

  it('is danger-free — no destructive styling on a value prompt', () => {
    const s = stripComments(src())
    expect(s).not.toContain('danger')
    expect(s).not.toContain('--danger')
    expect(s).toContain("const accentVar = 'var(--accent)'")
  })

  it('cancels on backdrop click and exposes a CANCEL button', () => {
    const s = stripComments(src())
    expect(s).toMatch(/onClick=\{onCancel\}/)
    expect(s).toContain('{cancelLabel}')
    // Clicks inside the card must not dismiss it.
    expect(s).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
  })

  it('does not itself reach for the native global it replaces', () => {
    const s = stripComments(src())
    expect(s).not.toMatch(/(?<![\w$.])prompt\s*\(/)
    expect(s).not.toMatch(/window\s*\.\s*prompt/)
  })
})

// ── 3. Provider: one queue, two dialogs, confirm() untouched ─────────────────

describe('ConfirmProvider: promptText added without disturbing confirm', () => {
  const src = () => read('src/components/ConfirmProvider.tsx')

  it('exports both hooks', () => {
    const s = stripComments(src())
    expect(s).toMatch(/export function useConfirm\(\): ConfirmFn/)
    expect(s).toMatch(/export function usePromptText\(\): PromptFn/)
  })

  it('keeps the confirm API byte-compatible for its existing callers', () => {
    const s = stripComments(src())
    // Same signature as before this change.
    expect(s).toMatch(/type ConfirmFn = \(options: ConfirmOptions\) => Promise<boolean>/)
    // Confirm still resolves true on OK and false on cancel.
    expect(s).toMatch(/onOk=\{\(\)\s*=> close\(current\.id, true\)\}/)
    expect(s).toMatch(/onCancel=\{\(\)\s*=> close\(current\.id, false\)\}/)
    // ConfirmOptions is still whatever ConfirmDialog defines — not redefined here.
    expect(s).toMatch(/import \{ ConfirmDialog, type ConfirmOptions \} from '\.\/ConfirmDialog'/)
  })

  it('ConfirmOptions itself is unchanged (the ~dozen callers pass these)', () => {
    const s = stripComments(read('src/components/ConfirmDialog.tsx'))
    for (const key of ['title?:', 'message:', 'okLabel?:', 'cancelLabel?:', 'danger?:']) {
      expect(s, `ConfirmOptions.${key}`).toContain(key)
    }
  })

  it('every useConfirm() caller still resolves against the same provider', () => {
    // A cheap census: if this drops, someone removed callers; if the import path
    // moved, they all broke at once.
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) {
          const s = fs.readFileSync(p, 'utf8')
          if (/\buseConfirm\b/.test(s) && !p.includes('ConfirmProvider') && !p.includes('ConfirmDialog')) {
            callers.push(path.relative(APP, p).replace(/\\/g, '/'))
          }
        }
      }
    }
    walk(path.join(APP, 'src'))
    expect(callers.length, `useConfirm callers: ${callers.join(', ')}`).toBeGreaterThanOrEqual(12)
  })

  it('prompt resolves null on cancel and a string on OK', () => {
    const s = stripComments(src())
    expect(s).toMatch(/type PromptFn = \(options: PromptOptions\) => Promise<string \| null>/)
    expect(s).toMatch(/onOk=\{\(value\) => close\(current\.id, value\)\}/)
    expect(s).toMatch(/onCancel=\{\(\)\s*=> close\(current\.id, null\)\}/)
    // A non-string result can never leak out as a value.
    expect(s).toMatch(/entry\.resolve\(typeof result === 'string' \? result : null\)/)
  })

  it('shares ONE queue so two modals never stack at z-index 99999', () => {
    const s = stripComments(src())
    expect(s).toMatch(/const current = queue\[0\]/)
    expect(s).toMatch(/current\.kind === 'confirm'/)
    expect(s).toMatch(/current\.kind === 'prompt'/)
    expect(s).toMatch(/type PendingEntry = PendingConfirm \| PendingPrompt/)
  })
})

// ── 4. WalletSwitcher wiring ─────────────────────────────────────────────────

describe('WalletSwitcher: add-agent-wallet actually runs', () => {
  const src = () => read('src/pages/wallet/components/WalletSwitcher.tsx')

  it('uses the in-app dialog hook', () => {
    const s = stripComments(src())
    expect(s).toMatch(/import \{ usePromptText \} from '\.\.\/\.\.\/\.\.\/components\/ConfirmProvider'/)
    expect(s).toMatch(/const promptText = usePromptText\(\)/)
  })

  it('AWAITS the dialog before creating the wallet', () => {
    const s = stripComments(src())
    expect(s).toMatch(/await promptText\(\{/)
    // The await must come before the IPC call, and the IPC call must be guarded.
    const ask    = s.indexOf('await promptText(')
    const create = s.indexOf('createAgentWallet(')
    expect(ask).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(ask)
  })

  it('refuses a blank name — no wallet is created', () => {
    const s = stripComments(src())
    expect(s).toMatch(/\)\)\?\.trim\(\)/)
    expect(s).toMatch(/if \(!name\) return/)
    const guard  = s.indexOf('if (!name) return')
    const create = s.indexOf('createAgentWallet(')
    expect(guard, 'the blank guard must precede the IPC call').toBeLessThan(create)
  })

  it('passes translated title / label / placeholder / buttons', () => {
    const s = stripComments(src())
    for (const key of ['switcher.newTitle', 'switcher.newPrompt', 'switcher.newPlaceholder', 'switcher.newOk', 'switcher.newCancel']) {
      expect(s, key).toContain(`t('${key}')`)
    }
  })

  it('reloads the list after creating', () => {
    const s = stripComments(src())
    const create = s.indexOf('createAgentWallet(')
    const reload = s.indexOf('await load()', create)
    expect(reload, 'load() must run after createAgentWallet').toBeGreaterThan(create)
  })
})

// ── 5. i18n parity for the new keys ──────────────────────────────────────────

describe('wallet i18n: the dialog strings ship in all 8 locales', () => {
  const NEW_KEYS = [
    'switcher.newTitle',
    'switcher.newPlaceholder',
    'switcher.newOk',
    'switcher.newCancel',
  ] as const

  for (const lang of LANGS) {
    for (const key of NEW_KEYS) {
      it(`${lang}/wallet.json: ${key} is a non-empty string`, () => {
        const val = lookup(walletNs(lang), key)
        expect(typeof val, `${lang}:${key}`).toBe('string')
        expect((val as string).trim(), `${lang}:${key}`).not.toBe('')
      })
    }
  }

  it('the pre-existing newPrompt label survived (it is the input label now)', () => {
    for (const lang of LANGS) {
      const val = lookup(walletNs(lang), 'switcher.newPrompt')
      expect(typeof val, `${lang}:switcher.newPrompt`).toBe('string')
      expect((val as string).trim(), `${lang}:switcher.newPrompt`).not.toBe('')
    }
  })

  it('every switcher.* key the component asks for exists in English', () => {
    const s = stripComments(read('src/pages/wallet/components/WalletSwitcher.tsx'))
    const used = [...s.matchAll(/t\('([^']+)'\)/g)].map(m => m[1])
    expect(used.length).toBeGreaterThanOrEqual(5)
    const en = walletNs('en')
    for (const key of used) {
      expect(typeof lookup(en, key), `en:${key} (used by WalletSwitcher)`).toBe('string')
    }
  })
})
