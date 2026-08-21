// apps/desktop/src/components/RootErrorBoundary.tsx
//
// App-level error boundary — the structural fix for the 2026-07-19 white
// screen: ONE component throwing at mount (a Promise iterated as an array in
// the command palette) blanked the ENTIRE app with zero explanation. React
// unmounts the whole tree on an uncaught render error unless a boundary
// catches it; this is that boundary. It must never happen again that a user
// stares at a white rectangle: they get the error, a RELOAD button, and the
// app name — in the brutalist idiom, no i18n (i18n itself may be the thing
// that crashed).
import React from 'react'

interface State { error: Error | null }

export class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface in the console for CDP probes / bug reports.
    console.error('[root-error-boundary]', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#111', color: '#eee', fontFamily: 'JetBrains Mono, monospace', padding: 24,
      }}>
        <div style={{ maxWidth: 560, border: '2px solid #f43f5e', padding: '20px 24px', boxShadow: '6px 6px 0 rgba(0,0,0,0.5)' }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', color: '#f43f5e', marginBottom: 10 }}>
            TACHI STUDIO — RENDER ERROR
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 6 }}>
            The interface crashed while rendering. Your data is safe — sessions, chats and settings live on disk.
          </div>
          <pre style={{
            fontSize: 10, color: '#fca5a5', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: '#1a1a1a', border: '1px solid #333', padding: '8px 10px', maxHeight: 160, overflowY: 'auto', margin: '10px 0',
          }}>
            {String(this.state.error?.stack ?? this.state.error).slice(0, 900)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 18px', border: '2px solid #eee', background: '#eee', color: '#111',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 800, letterSpacing: '0.1em',
              textTransform: 'uppercase', cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
