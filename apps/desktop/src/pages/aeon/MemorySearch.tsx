// apps/desktop/src/pages/aeon/MemorySearch.tsx
//
// E4 — Aeon memory search panel.
//
// Debounces input (500 ms) and cancels in-flight requests via a request-id
// counter so rapid typing never overwrites a later result with an earlier one.
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { AeonMemoryEntry } from '../../types/electron'

// ── Shared card style tokens (mirrors SkillsList / RunsTable) ─────────────────

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontFamily: 'JetBrains Mono, monospace',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexShrink: 0,
  cursor: 'pointer',
  userSelect: 'none',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  outline: 'none',
  boxSizing: 'border-box',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return String(ts)
  }
}

// ── Result card ───────────────────────────────────────────────────────────────

function ResultCard({ entry }: { entry: AeonMemoryEntry }) {
  return (
    <div style={{
      border: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-elevated)',
      padding: '8px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--text-primary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {entry.title || entry.id}
      </div>
      {entry.snippet && (
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          color: 'var(--text-muted)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {entry.snippet}
        </div>
      )}
      <div style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 9,
        color: 'var(--text-dim)',
        marginTop: 2,
      }}>
        {fmtTs(entry.ts)}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function MemorySearch() {
  const { t } = useTranslation('aeon')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AeonMemoryEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Request-id counter: each search increments it, stale responses are dropped.
  const reqId = useRef(0)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(null)
      setLoading(false)
      setError(null)
      return
    }
    const myId = ++reqId.current
    setLoading(true)
    setError(null)
    try {
      const data = await window.tachi.aeon.searchMemory(q.trim())
      if (reqId.current !== myId) return   // a newer search arrived — discard
      setResults(data)
    } catch (err) {
      if (reqId.current !== myId) return
      setError(err instanceof Error ? err.message : String(err))
      setResults(null)
    } finally {
      if (reqId.current === myId) setLoading(false)
    }
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => runSearch(val), 500)
  }, [runSearch])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      runSearch(query)
    }
  }, [runSearch, query])

  // Cancel any pending debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [])

  return (
    <div style={cardStyle}>
      {/* Header / toggle */}
      <div style={headerStyle} onClick={() => setOpen(o => !o)}>
        <span>{t('memory.title')}</span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{open ? '[-]' : '[+]'}</span>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
          {/* Search input */}
          <input
            style={inputStyle}
            placeholder={t('memory.placeholder')}
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />

          {/* Status / results */}
          {loading && (
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              color: 'var(--text-muted)',
              padding: '4px 0',
            }}>
              {t('memory.searching')}
            </div>
          )}

          {!loading && error && (
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              color: 'var(--danger)',
              padding: '4px 0',
            }}>
              {t('memory.errorPrefix')} {error}
            </div>
          )}

          {!loading && !error && results !== null && results.length === 0 && (
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              color: 'var(--text-muted)',
              padding: '4px 0',
            }}>
              {t('memory.noResults')}
            </div>
          )}

          {!loading && !error && results && results.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {results.map(entry => (
                <ResultCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
