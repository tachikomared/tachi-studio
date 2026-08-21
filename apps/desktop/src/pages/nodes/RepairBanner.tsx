// apps/desktop/src/pages/nodes/RepairBanner.tsx
//
// NODES-RESEARCH #4 — the SELF-HEALING TEMPLATE repair banner. When a flow is
// opened, switched to, or imported, the flow-doctor checks it for semantic
// breakage (a provider with no key, a local model that isn't downloaded, a
// folder that doesn't exist, a missing codex/skill) and this brutalist,
// warning-accented strip surfaces one row per issue with ONE repair action each
// — the ComfyUI "Install Missing X" mechanic that fixed ~85% of broken shares.
//
// It NEVER traps: loading is never blocked, the banner just sits at the top of
// the canvas. "OPEN ANYWAY" dismisses it for this flow (session-scoped, so it
// never nags), and the doctor re-runs on window focus/visibility so a fix the
// user made in another tab makes the row disappear on return.

import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useFlowDoctorStore, runFlowDoctor } from './store/flow-doctor.store'
import { useNodesStore } from './store/nodes.store'
import type { FlowIssue, FlowIssueFix } from './flow-doctor'

// ── Fix → route / verb ────────────────────────────────────────────────────────

const NAV_ROUTE: Record<'providers' | 'catalog' | 'settings' | 'skills', string> = {
  providers: '/settings?tab=connections',
  catalog:   '/catalog',
  settings:  '/settings?tab=connections',
  skills:    '/settings?tab=connections',
}

/** i18n key suffix for the ONE action button, per fix. */
function fixVerbKey(fix: FlowIssueFix): string {
  if (fix.kind === 'pick-folder') return 'pickFolder'
  if (fix.kind === 'navigate') return fix.to
  return 'generic'
}

/** i18n key suffix + interpolation for the plain-language problem line. */
function problemFor(issue: FlowIssue): { key: string; vars: Record<string, string> } {
  const d = issue.detail ?? {}
  switch (issue.kind) {
    case 'provider-key': return { key: 'providerKey', vars: {} }
    case 'local-model':  return { key: 'localModel',  vars: { model: d.model ?? '' } }
    case 'engine-off':   return { key: 'engineOff',   vars: { model: d.model ?? '' } }
    case 'folder-missing':
      return d.reason === 'missing'
        ? { key: 'folderMissing', vars: { path: d.path ?? '' } }
        : { key: 'folderEmpty',   vars: {} }
    case 'skill-missing': return { key: 'skillMissing', vars: { skill: d.skill ?? '' } }
    case 'codex-missing': return { key: 'codexMissing', vars: {} }
    // A WARNING, not a blocker: fix.kind is 'none', so this row renders with no
    // button — the remedy is editorial (one more scene, not a longer one).
    case 'segment-length': return { key: 'segmentLength', vars: { frames: d.frames ?? '', cap: d.cap ?? '' } }
    // Both rife rows are WARNINGS with fix.kind 'none' — no button renders. One
    // fix is a wire the user draws, the other is the install button on the node
    // itself (which is where the 431 MB figure belongs).
    case 'rife-no-input': return { key: 'rifeNoInput', vars: {} }
    case 'rife-missing':  return { key: 'rifeMissing',  vars: {} }
    default:              return { key: 'generic', vars: {} }
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RepairBanner() {
  const { t } = useTranslation('nodes')
  const navigate = useNavigate()

  const issues        = useFlowDoctorStore(s => s.issues)
  const checkedFlow   = useFlowDoctorStore(s => s.flowName)
  const dismissed     = useFlowDoctorStore(s => s.dismissed)
  const dismissCurrent = useFlowDoctorStore(s => s.dismissCurrent)

  const flowName       = useNodesStore(s => s.flowName)
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  // THE QUOTA BANNER (audit 3D-4): nodes.store's throttled flush swallows a
  // QuotaExceededError behind a console.warn — canvas edits keep LOOKING like
  // they save (nothing on screen changes) while localStorage silently stops
  // accepting them. Not a per-node flow-doctor issue (there is no offending
  // node, and it is not scoped to any one saved flow), so it renders as its
  // own always-on strip rather than a row in `issues` below.
  const persistFailed  = useNodesStore(s => s.persistFailed)

  // Re-run the doctor when the user returns to the window (they may have just
  // added a key / downloaded a model in another tab) so fixed rows disappear.
  useEffect(() => {
    runFlowDoctor()
    const recheck = () => { if (document.visibilityState === 'visible') runFlowDoctor() }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [])

  // Only show issues that belong to the flow currently on the canvas (guards the
  // async gap during a flow switch), and only if this flow wasn't dismissed.
  const show = checkedFlow === flowName && issues.length > 0 && !dismissed[flowName]
  if (!show && !persistFailed) return null

  const applyFix = async (issue: FlowIssue) => {
    const fix = issue.fix
    if (fix.kind === 'pick-folder') {
      // Reuse the folder-node picking flow in place; on success the doctor
      // re-runs so the row clears without a full reload.
      try {
        const picked = await window.tachi?.agent?.pickFolder?.()
        if (picked) { updateNodeData(issue.nodeId, { path: picked }); runFlowDoctor() }
      } catch { /* user cancelled — leave the row */ }
      return
    }
    if (fix.kind === 'navigate') {
      // Codex lives in a buried Connections card — reuse its deep-link scroll.
      if (issue.kind === 'codex-missing') {
        try { sessionStorage.setItem('tachi:settings-scroll', 'codex') } catch { /* ignore */ }
      }
      navigate(NAV_ROUTE[fix.to])
    }
  }

  return (
    <>
      {/* THE QUOTA BANNER — always on while persistFailed is latched, entirely
          independent of the per-flow doctor issues below (no "open anyway"
          dismiss: this is live data loss risk, not a template that needs
          setup, and it clears itself the moment a later flush succeeds). */}
      {persistFailed && (
        <div
          role="alert"
          style={{
            flexShrink: 0, padding: '7px 12px', borderBottom: '2px solid var(--danger)',
            background: 'var(--bg-surface)', boxShadow: 'inset 3px 0 0 var(--danger)',
            fontFamily: 'JetBrains Mono, monospace', display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <span style={{
            padding: '1px 5px', border: '2px solid var(--danger)', color: 'var(--danger)',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            flexShrink: 0,
          }}>
            {t('repair.persistFailedTitle', { defaultValue: 'Not saving' })}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-primary)', lineHeight: 1.4 }}>
            {t('repair.persistFailed', {
              defaultValue: 'Canvas changes are NOT being saved — export your flow.',
            })}
          </span>
        </div>
      )}
      {show && (
        <div
          role="region"
          aria-label={t('repair.title', { defaultValue: 'Flow needs setup' })}
          style={{
            flexShrink: 0,
            borderBottom: '2px solid var(--warning)',
            background: 'var(--bg-surface)',
            boxShadow: 'inset 3px 0 0 var(--warning)',
            fontFamily: 'JetBrains Mono, monospace',
            maxHeight: '38%',
            overflowY: 'auto',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, padding: '7px 12px', borderBottom: '2px solid var(--border)',
            background: 'var(--bg-elevated)', position: 'sticky', top: 0, zIndex: 1,
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{
                padding: '1px 5px', border: '2px solid var(--warning)', color: 'var(--warning)',
                fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                flexShrink: 0,
              }}>
                {t('repair.title', { defaultValue: 'Flow needs setup' })}
              </span>
              <span style={{
                fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {t('repair.summary', {
                  count: issues.length,
                  defaultValue: 'This flow references {{count}} thing that is not ready yet.',
                })}
              </span>
            </span>
            <button
              onClick={dismissCurrent}
              title={t('repair.openAnywayTitle', { defaultValue: 'Dismiss for this flow — open it as-is' })}
              style={{
                flexShrink: 0, padding: '3px 10px', border: '2px solid var(--border)',
                background: 'var(--bg-surface)', color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
              }}
            >
              {t('repair.openAnyway', { defaultValue: 'Open anyway' })}
            </button>
          </div>

          {/* One row per issue */}
          {issues.map((issue, i) => {
            const p = problemFor(issue)
            const verb = fixVerbKey(issue.fix)
            return (
              <div
                key={`${issue.nodeId}-${issue.kind}-${i}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
                  borderBottom: i === issues.length - 1 ? 'none' : 'var(--border-width) solid var(--border)',
                }}
              >
                <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {issue.label}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    {t(`repair.problem.${p.key}`, { ...p.vars, defaultValue: REPAIR_PROBLEM_FALLBACK[p.key] ?? '' })}
                  </span>
                </span>
                {issue.fix.kind !== 'none' && (
                  <button
                    onClick={() => { void applyFix(issue) }}
                    // A11Y (batch34): every row renders the SAME verb ("Add key",
                    // "Fix"), so the accessible name has to carry which node it
                    // repairs — otherwise the banner reads as N identical buttons.
                    aria-label={t('repair.fixAria', {
                      action: t(`repair.fix.${verb}`, { defaultValue: REPAIR_FIX_FALLBACK[verb] ?? 'Fix' }),
                      label: issue.label,
                      defaultValue: '{{action}} — {{label}}',
                    })}
                    style={{
                      flexShrink: 0, padding: '4px 12px', border: '2px solid var(--warning)',
                      background: 'var(--warning)', color: 'var(--bg-base)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
                      boxShadow: 'var(--shadow-hard)',
                    }}
                  >
                    {t(`repair.fix.${verb}`, { defaultValue: REPAIR_FIX_FALLBACK[verb] ?? 'Fix' })}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// English fallbacks kept next to the component so a missing translation still
// renders sensible copy (the i18n JSON is the source of truth in every locale).
const REPAIR_PROBLEM_FALLBACK: Record<string, string> = {
  providerKey:   'Not connected — add this provider\'s API key to run it.',
  localModel:    'Local model "{{model}}" isn\'t downloaded.',
  engineOff:     'Model "{{model}}" is downloaded, but the local engine isn\'t running it.',
  folderEmpty:   'No folder picked yet — choose one to give the agent a workspace.',
  folderMissing: 'Folder not found on this machine: {{path}}',
  skillMissing:  'Skill "{{skill}}" isn\'t installed.',
  codexMissing:  'Codex isn\'t installed yet.',
  segmentLength: 'Chained scene asks for {{frames}} frames — chained video is capped at {{cap}} (~5 s) per scene and this one will be trimmed. Add another scene instead of a longer one.',
  rifeNoInput:   'Nothing that could produce a video is wired into this interpolate node — connect a video node, its result card, or another interpolate node.',
  rifeMissing:   'The frame-interpolation engine isn\'t installed. Install it on the node itself — it is a one-time download and the button shows the size.',
  generic:       'Needs setup before this flow will run.',
}

const REPAIR_FIX_FALLBACK: Record<string, string> = {
  providers:  'Add key',
  catalog:    'Open catalog',
  settings:   'Open settings',
  skills:     'Open skills',
  pickFolder: 'Pick folder',
  generic:    'Fix',
}
