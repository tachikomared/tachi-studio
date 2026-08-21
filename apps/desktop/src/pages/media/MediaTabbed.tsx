// apps/desktop/src/pages/media/MediaTabbed.tsx
//
// Media tab shell: a thin sub-tab strip over the three media surfaces —
//   • Generate       → the Surplus/Venice media studio (MediaPage)
//   • Audio Overview → notes → two-host podcast, local piper voices (AudioOverviewPanel)
//   • Artifacts      → the persistent generated-media library (ArtifactsPage)
//
// Artifacts used to be its own top-level sidebar tab; it now lives here as a
// sub-tab of Media. Routed for both /media (Generate) and /artifacts (Artifacts).
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MediaPage } from './MediaPage'
import { AudioOverviewPanel } from './AudioOverviewPanel'
import { ArtifactsPage } from '../artifacts/ArtifactsPage'
import { useAudioOverviewStore, isAudioOverviewBusy } from '../../store/audioOverview.store'

type MediaTab = 'generate' | 'audio-overview' | 'artifacts'

const TABS: { id: MediaTab; labelKey: string }[] = [
  { id: 'generate',       labelKey: 'tabs.generate' },
  { id: 'audio-overview', labelKey: 'tabs.audioOverview' },
  { id: 'artifacts',      labelKey: 'tabs.artifacts' },
]

export function MediaTabbed({ initialTab = 'generate' }: { initialTab?: MediaTab }) {
  const { t } = useTranslation('media')
  // A podcast render in flight OWNS this tab shell: the activity rail's row
  // points at /media, and landing on Generate while the run the user clicked
  // through to is one sub-tab away would be the same "where did my work go"
  // the run slice exists to answer. Only while it is actually running.
  const [tab, setTab] = useState<MediaTab>(
    () => (isAudioOverviewBusy(useAudioOverviewStore.getState()) ? 'audio-overview' : initialTab),
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Sub-tab strip */}
      <div style={{
        display: 'flex',
        flexShrink: 0,
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-surface)',
      }}>
        {TABS.map(t2 => {
          const active = tab === t2.id
          return (
            <button
              key={t2.id}
              onClick={() => setTab(t2.id)}
              style={{
                padding: '7px 18px',
                border: 'none',
                borderRight: '2px solid var(--border)',
                background: active ? 'var(--accent-muted)' : 'transparent',
                color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                fontWeight: active ? 700 : 400,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {t(t2.labelKey)}
            </button>
          )
        })}
      </div>

      {/* Active surface fills the rest. All pages render their own PageTopbar. */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'generate' ? <MediaPage /> : tab === 'audio-overview' ? <AudioOverviewPanel /> : <ArtifactsPage />}
      </div>
    </div>
  )
}
