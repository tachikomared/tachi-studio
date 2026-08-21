// apps/desktop/src/pages/settings/ConnectionsRail.tsx
//
// Sticky anchor rail for the Settings → Connections tab. The tab renders
// ~25 heterogeneous cards in one long scroll; this rail gives it a map:
// five fixed glossary sections (LOCAL SERVERS / PROVIDERS / AGENTS / SEARCH /
// SIGN-IN · OTHER) that smooth-scroll to the matching section wrapper
// (#settings-section-<id>) plus a filter-by-name input (CatalogPage pattern).
//
// Purely presentational — filter state, scroll-spy and the card→section
// grouping live in SettingsPage. Brutalist idiom: 2px borders, JetBrains
// Mono, uppercase 10px labels, hard shadow on the active item.

import React from 'react'
import { useTranslation } from 'react-i18next'

// `api-keys` was split out of `search` on 2026-07-31. The Civitai key card had
// been filed next to Brave and Tavily — technically "the non-provider keys",
// but nobody hunting for a MODEL-HOST credential looks under Search, and the
// owner's report was literally "I don't see where I can add my civitai and
// huggingface API keys". A section named after what the user is carrying (an
// API key) rather than after what we internally classify it as.
export type RailSectionId = 'local' | 'providers' | 'agents' | 'api-keys' | 'search' | 'other'

export interface ConnectionsRailItem {
  id: RailSectionId
  label: string
  /** Number of cards in this section that survive the current filter. */
  visibleCount: number
}

export function ConnectionsRail({ items, activeId, filter, onFilterChange, onJump }: {
  items: ConnectionsRailItem[]
  activeId: RailSectionId
  filter: string
  onFilterChange: (value: string) => void
  onJump: (id: RailSectionId) => void
}) {
  const { t } = useTranslation('settings')
  const filtering = filter.trim() !== ''

  return (
    <nav
      aria-label={t('connections.railLabel', { defaultValue: 'Connection sections' })}
      style={{
        width: 168, flexShrink: 0,
        position: 'sticky', top: 0, alignSelf: 'flex-start',
        display: 'flex', flexDirection: 'column', gap: 8,
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <input
        value={filter}
        onChange={e => onFilterChange(e.target.value)}
        placeholder={t('connections.filterPlaceholder', { defaultValue: 'Filter by name…' })}
        data-testid="connections-filter"
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '6px 8px', fontSize: 10,
          border: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-base)', color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace', outline: 'none',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map(item => {
          // While filtering, drop rail entries for sections with zero matches —
          // mirrors the content column, which hides those section headers.
          if (filtering && item.visibleCount === 0) return null
          const active = item.id === activeId
          return (
            <button
              key={item.id}
              onClick={() => onJump(item.id)}
              aria-current={active ? 'true' : undefined}
              data-testid={`connections-rail-${item.id}`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                width: '100%', textAlign: 'left',
                padding: '6px 8px',
                border: `var(--border-width) solid ${active ? 'var(--border)' : 'transparent'}`,
                background: active ? 'var(--bg-elevated)' : 'transparent',
                boxShadow: active ? 'var(--shadow-hard)' : 'none',
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.08em',
                cursor: 'pointer',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </span>
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', flexShrink: 0 }}>
                {item.visibleCount}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

export default ConnectionsRail
