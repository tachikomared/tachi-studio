// apps/desktop/src/pages/settings/ModelStorageSection.tsx
//
// Settings → Advanced → MODEL WEIGHTS. The storage dashboard for local
// inference weights (llama.cpp / Stable Diffusion / Whisper / Piper) that
// otherwise silently pile up on the system drive (USER-PAINS T5+T6). Shows
// per-engine disk usage, one-click REMOVE, and the "Move models to storage
// root" relocation with live progress.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../../components/ConfirmProvider'
import type {
  ModelStorageUsage, ModelMigrateProgress, EngineUsage, ModelUsageItem, ModelStorageFile,
  StagingInventory, StagingFile,
} from '../../types/electron'

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  const rounded = v >= 100 || u === 0 ? Math.round(v) : Math.round(v * 10) / 10
  return `${rounded} ${units[u]}`
}

const btnBase: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, padding: '5px 12px',
  border: 'var(--border-width) solid var(--border)',
  cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
  textTransform: 'uppercase', letterSpacing: '0.08em',
}
const chip: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, padding: '2px 6px',
  border: 'var(--border-width) solid var(--border)',
  textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
}

export function ModelStorageSection() {
  const { t } = useTranslation('settings')
  const confirm = useConfirm()
  const [usage, setUsage] = React.useState<ModelStorageUsage | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState<ModelMigrateProgress | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const unsubRef = React.useRef<(() => void) | null>(null)

  const refresh = React.useCallback((force = false) => {
    window.tachi.modelStorage.usage(force).then(setUsage).catch(() => {})
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  React.useEffect(() => () => { unsubRef.current?.() }, [])

  const runMigrate = async (engine?: string) => {
    setBusy(true); setError(null); setProgress(null)
    unsubRef.current = window.tachi.modelStorage.onMigrateProgress(ev => setProgress(ev as ModelMigrateProgress))
    try {
      const res = await window.tachi.modelStorage.migrate(engine)
      const failed = res.results.find(r => !r.ok && !r.skipped && !r.aborted)
      if (failed?.error) setError(failed.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      unsubRef.current?.(); unsubRef.current = null
      setBusy(false); setProgress(null); refresh(true)
    }
  }

  const abort = () => { window.tachi.modelStorage.abort().catch(() => {}) }

  // The storage-root picker, right here next to the Move button. It used to
  // live only in a different Settings card, which made the dashboard's central
  // advice ("move them off your system drive") impossible to act on from the
  // place that gives it — and the DEFAULT root is on the system drive, so for
  // most users Move alone cannot deliver what the card promises.
  const chooseFolder = async () => {
    try {
      const res = await window.tachi.storage.choose()
      if (res?.root) refresh(true)
    } catch { /* picker cancelled / unavailable */ }
  }

  const remove = async (engine: string, id: string, displayName: string) => {
    const ok = await confirm({ message: t('modelStorage.confirmRemove', { id: displayName, defaultValue: `Delete "${displayName}"? You can re-download it later.` }) })
    if (!ok) return
    await window.tachi.modelStorage.remove(engine, id).catch(() => {})
    refresh(true)
  }

  // Per-file removal inside an sd adapter container ('loras'/'embeddings'/
  // 'vae'): `${containerId}/${file.name}` is the compound id
  // model-storage.ts's removeModelItem splits back apart, so ONE file is
  // deleted instead of the whole shared directory (the footgun this lane
  // exists to close — a row literally named "loras" used to carry a Remove
  // that took out every LoRA on the machine).
  const removeFile = async (engine: string, containerId: string, file: ModelStorageFile) => {
    const ok = await confirm({ message: t('modelStorage.confirmRemove', { id: file.displayName, defaultValue: `Delete "${file.displayName}"? You can re-download it later.` }) })
    if (!ok) return
    await window.tachi.modelStorage.remove(engine, `${containerId}/${file.name}`).catch(() => {})
    refresh(true)
  }

  // Bulk removal of an ENTIRE container — the one case where the old
  // whole-directory Remove is still the right call (clearing every LoRA on
  // purpose). Never silent: the confirm names the exact file count, never a
  // bare "Remove".
  const removeAllContainer = async (engine: string, item: ModelUsageItem, label: string) => {
    const count = item.containerFiles?.length ?? 0
    const ok = await confirm({ message: t('modelStorage.confirmRemoveAllContainer', { count, label }) })
    if (!ok) return
    await window.tachi.modelStorage.remove(engine, item.id).catch(() => {})
    refresh(true)
  }

  const cardStyle: React.CSSProperties = {
    border: 'var(--border-width) solid var(--border)',
    background: 'var(--bg-elevated)',
    boxShadow: 'var(--shadow-hard)',
    padding: 12,
    fontFamily: 'JetBrains Mono, monospace',
  }

  if (!usage) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('modelStorage.loading', { defaultValue: 'Reading disk usage…' })}</div>
      </div>
    )
  }

  const enginesWithModels = usage.engines.filter(e => e.items.length > 0)
  const pct = usage.storageTotalBytes && usage.storageFreeBytes != null
    ? Math.max(0, Math.min(100, Math.round((1 - usage.storageFreeBytes / usage.storageTotalBytes) * 100)))
    : null

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, color: 'var(--text-primary)' }}>
        {t('modelStorage.title', { defaultValue: 'Model weights' })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        {t('modelStorage.intro', { defaultValue: 'Local model weights (llama.cpp, Stable Diffusion, Whisper, Piper) can grow to tens of gigabytes. Move them off your system drive into the Storage folder.' })}
      </div>

      {/* Current target + disk free */}
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        {t('modelStorage.location', { defaultValue: 'Weights location' })}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch', marginBottom: 8 }}>
        <div title={usage.modelsRoot} style={{
          flex: 1, minWidth: 0,
          fontSize: 10, color: 'var(--text-primary)',
          border: 'var(--border-width) solid var(--border)',
          background: 'var(--bg-base)', padding: '5px 8px',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          display: 'flex', alignItems: 'center',
        }}>
          {usage.modelsRoot}
        </div>
        <button
          onClick={chooseFolder}
          disabled={busy}
          style={{ ...btnBase, background: 'transparent', color: 'var(--text-primary)', opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
        >{t('modelStorage.changeFolder', { defaultValue: 'Change folder' })}</button>
      </div>

      {/*
        THE HONEST WARNING. `<storage root>` defaults to Documents\Tachi Studio,
        which on a stock Windows install is the SAME DRIVE as %APPDATA% — so
        "Move all to storage root" would shuffle tens of gigabytes from C: to C:,
        need the whole payload free on C: to do it, and free nothing at all. Say
        so before the user starts, and point at the fix (pick a folder on another
        drive) instead of letting them discover it after an hour of copying.
      */}
      {usage.canRelocate && !usage.moveChangesDrive && (
        <div style={{
          fontSize: 9, lineHeight: 1.5, marginBottom: 10, padding: '6px 8px',
          border: 'var(--border-width) solid var(--destructive)',
          color: 'var(--text-primary)', background: 'var(--bg-base)',
        }}>
          {t('modelStorage.sameDriveWarning', {
            defaultValue: 'This folder is on the SAME drive as the app-data folder, so moving will not free any space there. Choose a folder on another drive first — then Move.',
          })}
        </div>
      )}

      {pct != null && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginBottom: 3 }}>
            <span>{t('modelStorage.diskUsed', { defaultValue: 'Disk used' })}</span>
            <span>{fmtBytes(usage.storageFreeBytes ?? 0)} {t('modelStorage.free', { defaultValue: 'free' })}</span>
          </div>
          <div style={{ height: 6, border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct > 90 ? 'var(--destructive)' : 'var(--accent)' }} />
          </div>
        </div>
      )}

      {/* Move-all action + progress */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {/* Primary ONLY when moving would actually change drive. When the target
            is on the same drive the move is legal but pointless, so it must not
            look like the recommended action — CHANGE FOLDER is. */}
        <button
          onClick={() => runMigrate()}
          disabled={busy || !usage.canRelocate}
          title={
            !usage.canRelocate
              ? t('modelStorage.allMovedTitle', { defaultValue: 'All weights already live in the Storage folder.' })
              : !usage.moveChangesDrive
                ? t('modelStorage.sameDriveWarning', { defaultValue: 'This folder is on the SAME drive as the app-data folder, so moving will not free any space there. Choose a folder on another drive first — then Move.' })
                : undefined
          }
          style={{
            ...btnBase,
            background: usage.canRelocate && usage.moveChangesDrive ? 'var(--accent)' : 'transparent',
            color: usage.canRelocate && usage.moveChangesDrive ? '#fff' : 'var(--text-muted)',
            boxShadow: usage.canRelocate && usage.moveChangesDrive ? 'var(--shadow-hard)' : 'none',
            cursor: busy || !usage.canRelocate ? 'default' : 'pointer',
            opacity: busy || !usage.canRelocate ? 0.5 : 1,
          }}
        >{t('modelStorage.moveAll', { defaultValue: 'Move all to storage root' })}</button>
        {busy && (
          <button onClick={abort} style={{ ...btnBase, background: 'transparent', color: 'var(--destructive)', borderColor: 'var(--destructive)' }}>
            {t('modelStorage.cancel', { defaultValue: 'Cancel' })}
          </button>
        )}
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          {t('modelStorage.total', { defaultValue: 'Total' })}: <b style={{ color: 'var(--text-primary)' }}>{fmtBytes(usage.totalBytes)}</b>
        </span>
      </div>

      {progress && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {progress.phase === 'copy'
              ? t('modelStorage.copying', { engine: progress.engine, done: progress.filesDone, total: progress.filesTotal, defaultValue: `Copying ${progress.engine} — ${progress.filesDone}/${progress.filesTotal}` })
              : progress.phase === 'delete'
                ? t('modelStorage.removingOriginals', { engine: progress.engine, defaultValue: `Removing ${progress.engine} originals…` })
                : progress.phase === 'preflight'
                  ? t('modelStorage.checking', { defaultValue: 'Checking destination…' })
                  : progress.message ?? progress.phase}
          </div>
          <div style={{ height: 6, border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)' }}>
            <div style={{ height: '100%', width: `${progress.bytesTotal > 0 ? Math.round((progress.bytesDone / progress.bytesTotal) * 100) : 0}%`, background: 'var(--accent)' }} />
          </div>
        </div>
      )}
      {error && <div style={{ fontSize: 9, color: 'var(--destructive)', marginBottom: 10 }}>{error}</div>}

      {/* Leftover download staging — the space this card could not previously
          account for. See StagingBlock. */}
      <StagingBlock busy={busy} onChanged={() => refresh(true)} t={t} confirm={confirm} />

      {/* Per-engine breakdown */}
      {enginesWithModels.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {t('modelStorage.empty', { defaultValue: 'No local model weights downloaded yet.' })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {enginesWithModels.map(e => (
            <EngineGroup
              key={e.engine} usage={e} busy={busy} onMove={() => runMigrate(e.engine)}
              onRemove={remove} onRemoveFile={removeFile} onRemoveAllContainer={removeAllContainer} t={t}
            />
          ))}
        </div>
      )}

      {/* This used to read "New downloads land in the app-data folder; run Move
          again to relocate them." That stopped being true when new downloads
          started targeting the storage root, and it was actively harmful: it
          told the user their disk problem would keep coming back. */}
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
        {t('modelStorage.hint', { defaultValue: 'New downloads go straight to the folder above — moving is a one-time cleanup of models downloaded earlier. Engines pause only while their own weights are moving.' })}
      </div>
    </div>
  )
}

// ── Leftover download staging ────────────────────────────────────────────────
//
// The card above counts MODEL ITEMS. An interrupted transfer is not a model, so
// for as long as this card has existed it has been blind to its own engines'
// staging directories — and on the machine this was written on, that blindness
// was 5.6 GB on a system drive with 9.1 GB free, including one 4.76 GB `.tmp`
// from a download abandoned eight weeks earlier that no code path could resume.
//
// Two kinds, never merged, because the cost of pressing the button is different:
// an abandoned partial costs NOTHING (nothing can resume it), while a cached
// installer archive costs a re-download if that engine is ever reinstalled.
// The rows say which, and the confirm says it again with the byte count.
function StagingBlock({ busy, onChanged, t, confirm }: {
  busy: boolean
  onChanged: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
  confirm: (opts: { message: string }) => Promise<boolean>
}) {
  const [inv, setInv] = React.useState<StagingInventory | null>(null)
  const [working, setWorking] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    window.tachi.modelStorage.staging().then(setInv).catch(() => setInv(null))
  }, [])
  React.useEffect(() => { load() }, [load])

  const reclaim = async (files: StagingFile[]) => {
    if (files.length === 0) return
    const bytes = files.reduce((s, f) => s + f.bytes, 0)
    const ok = await confirm({
      message: t('modelStorage.staging.confirm', {
        count: files.length,
        size: fmtBytes(bytes),
        defaultValue: `Delete ${files.length} leftover file(s), freeing ${fmtBytes(bytes)}? Interrupted transfers cannot be resumed either way; installer archives would be re-downloaded if needed.`,
      }),
    })
    if (!ok) return
    setWorking(true); setNote(null)
    try {
      const res = await window.tachi.modelStorage.reclaimStaging(files.map(f => f.path))
      // Report what ACTUALLY happened, including the two silent cases: a file a
      // fresh scan would no longer offer (a download claimed it while the list
      // sat on screen) and a delete the OS refused.
      const parts = [t('modelStorage.staging.freed', { size: fmtBytes(res.freedBytes), defaultValue: `Freed ${fmtBytes(res.freedBytes)}.` })]
      if (res.refused.length > 0) parts.push(t('modelStorage.staging.refused', { count: res.refused.length, defaultValue: `${res.refused.length} skipped — in use since the list was read.` }))
      if (res.failed.length > 0) parts.push(res.failed[0].error)
      setNote(parts.join(' '))
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
      load()
      onChanged()
    }
  }

  // `|| note` is load-bearing, and it was missing on the first cut: reclaiming
  // everything empties the inventory, so the block that owns the outcome line
  // unmounted in the same render that produced it — "Freed 5.66 GB" could never
  // be seen, and neither could "1 skipped, in use since the list was read".
  // A driver hit exactly that: the delete worked, the guard refused a stale
  // path correctly, and the UI said nothing about either. Same shape as the
  // runtime card that carried a reason for a degraded verdict and rendered
  // nothing — an honest state with no voice.
  if ((!inv || inv.files.length === 0) && !note) return null
  const files = inv?.files ?? []
  const totalBytes = inv?.totalBytes ?? 0
  const withheldCount = inv?.withheldCount ?? 0
  const disabled = busy || working

  return (
    <div style={{
      marginBottom: 10, padding: '8px 10px',
      border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
          {t('modelStorage.staging.title', { defaultValue: 'Leftover download files' })}
        </span>
        {files.length > 0 && (
          <>
            <span style={{ fontSize: 10, color: 'var(--warning)', fontWeight: 700 }}>{fmtBytes(totalBytes)}</span>
            <button
              onClick={() => reclaim(files)}
              disabled={disabled}
              style={{ ...btnBase, marginLeft: 'auto', background: 'transparent', color: 'var(--destructive)', borderColor: 'var(--destructive)', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}
            >{t('modelStorage.staging.reclaimAll', { defaultValue: 'Reclaim all' })}</button>
          </>
        )}
      </div>
      {files.length > 0 && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 6 }}>
          {t('modelStorage.staging.intro', {
            defaultValue: 'Files left behind by downloads and installers. They are not models, so the totals above never counted them.',
          })}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {files.map(f => (
          <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span title={f.path} style={{ fontSize: 9, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.owner}/{f.name}
            </span>
            <span style={{
              ...chip,
              color: f.kind === 'abandoned-partial' ? 'var(--success)' : 'var(--text-dim)',
              borderColor: f.kind === 'abandoned-partial' ? 'var(--success)' : 'var(--border)',
            }}>
              {f.kind === 'abandoned-partial'
                ? t('modelStorage.staging.kindDead', { defaultValue: 'nothing to lose' })
                : t('modelStorage.staging.kindCached', { defaultValue: 're-downloadable' })}
            </span>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', minWidth: 56, textAlign: 'right' }}>{fmtBytes(f.bytes)}</span>
            <button
              onClick={() => reclaim([f])}
              disabled={disabled}
              style={{ ...btnBase, padding: '2px 8px', background: 'transparent', color: 'var(--text-muted)', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}
            >{t('modelStorage.staging.reclaim', { defaultValue: 'Delete' })}</button>
          </div>
        ))}
      </div>
      {/* Withheld files are NAMED as withheld rather than silently missing: a
          count that does not match what the user sees in Explorer is exactly
          how a dashboard stops being believed. */}
      {withheldCount > 0 && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 5 }}>
          {t('modelStorage.staging.withheld', {
            count: withheldCount,
            defaultValue: `${withheldCount} more left alone — too recent, or a download still owns it.`,
          })}
        </div>
      )}
      {note && <div style={{ fontSize: 9, color: 'var(--text-primary)', marginTop: 5 }}>{note}</div>}
    </div>
  )
}

function EngineGroup({ usage, busy, onMove, onRemove, onRemoveFile, onRemoveAllContainer, t }: {
  usage: EngineUsage
  busy: boolean
  onMove: () => void
  onRemove: (engine: string, id: string, displayName: string) => void
  onRemoveFile: (engine: string, containerId: string, file: ModelStorageFile) => void
  onRemoveAllContainer: (engine: string, item: ModelUsageItem, label: string) => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  return (
    <div style={{ border: 'var(--border-width) solid var(--border)', background: 'var(--bg-surface)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '6px 8px', borderBottom: 'var(--border-width) solid var(--border)',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {usage.label}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtBytes(usage.totalBytes)}</span>
          {usage.hasLegacy && (
            <button
              onClick={onMove}
              disabled={busy}
              style={{ ...btnBase, padding: '3px 8px', background: 'transparent', color: 'var(--accent)', borderColor: 'var(--accent)', opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
            >{t('modelStorage.move', { defaultValue: 'Move' })}</button>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {usage.items.map(item => (
          item.adapterKind
            ? (
              <AdapterContainerRow
                key={item.id} engine={usage.engine} item={item} busy={busy}
                onRemoveFile={onRemoveFile} onRemoveAllContainer={onRemoveAllContainer} t={t}
              />
            )
            : (
              <CheckpointRow key={item.id} engine={usage.engine} item={item} busy={busy} onRemove={onRemove} t={t} />
            )
        ))}
      </div>
    </div>
  )
}

/** One installed sd.cpp checkpoint (or an llama/whisper/piper item — same
 *  row shape). Shows the RESOLVED name, never the raw `civitai-<id>`, and a
 *  "shares components with X" note when this row's bytes are not all its
 *  own (the checkpoint-dedup honesty label). */
function CheckpointRow({ engine, item, busy, onRemove, t }: {
  engine: string
  item: ModelUsageItem
  busy: boolean
  onRemove: (engine: string, id: string, displayName: string) => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      padding: '5px 8px', borderBottom: 'var(--border-width) solid var(--border)',
    }}>
      <span title={item.id} style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.displayName}
        </div>
        {item.sharedWith && item.sharedWith.length > 0 && (
          <div style={{ fontSize: 8, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t('modelStorage.sharedWith', { models: item.sharedWith.join(', '), defaultValue: `shares components with ${item.sharedWith.join(', ')}` })}
          </div>
        )}
      </span>
      <span style={{ ...chip, color: item.location === 'root' ? 'var(--success, var(--accent))' : 'var(--text-muted)', borderColor: item.location === 'root' ? 'var(--success, var(--accent))' : 'var(--border)' }}>
        {item.location === 'root' ? t('modelStorage.locRoot', { defaultValue: 'Storage' }) : t('modelStorage.locLegacy', { defaultValue: 'App data' })}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 56, textAlign: 'right' }}>{fmtBytes(item.bytes)}</span>
      <button
        onClick={() => onRemove(engine, item.id, item.displayName)}
        disabled={busy}
        style={{ ...btnBase, padding: '3px 8px', background: 'transparent', color: 'var(--destructive)', borderColor: 'var(--destructive)', opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
      >{t('modelStorage.remove', { defaultValue: 'Remove' })}</button>
    </div>
  )
}

const CONTAINER_LABEL_KEY: Record<'lora' | 'embedding' | 'vae', { key: string; fallback: string }> = {
  lora:      { key: 'modelStorage.containerLora',      fallback: 'All LoRAs' },
  embedding: { key: 'modelStorage.containerEmbedding',  fallback: 'All textual inversions' },
  vae:       { key: 'modelStorage.containerVae',        fallback: 'All VAE swaps' },
}

/**
 * One sd adapter container ('loras'/'embeddings'/'vae') — every installed
 * adapter of one kind, sharing a directory the engine scans by file stem.
 * NEVER a single Remove on the whole thing by default: the row is collapsed
 * to a summary + an explicit expand, and only an explicit "delete all N
 * files" confirm can clear the lot.
 */
function AdapterContainerRow({ engine, item, busy, onRemoveFile, onRemoveAllContainer, t }: {
  engine: string
  item: ModelUsageItem
  busy: boolean
  onRemoveFile: (engine: string, containerId: string, file: ModelStorageFile) => void
  onRemoveAllContainer: (engine: string, item: ModelUsageItem, label: string) => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  const [expanded, setExpanded] = React.useState(false)
  const files = item.containerFiles ?? []
  const kind = item.adapterKind ?? 'lora'
  const labelInfo = CONTAINER_LABEL_KEY[kind]
  const label = t(labelInfo.key, { defaultValue: labelInfo.fallback })
  const summary = t('modelStorage.containerSummary', { count: files.length, label, size: fmtBytes(item.bytes) })

  return (
    <div style={{ borderBottom: 'var(--border-width) solid var(--border)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '5px 8px',
      }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 10, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {summary}
        </span>
        <span style={{ ...chip, color: item.location === 'root' ? 'var(--success, var(--accent))' : 'var(--text-muted)', borderColor: item.location === 'root' ? 'var(--success, var(--accent))' : 'var(--border)' }}>
          {item.location === 'root' ? t('modelStorage.locRoot', { defaultValue: 'Storage' }) : t('modelStorage.locLegacy', { defaultValue: 'App data' })}
        </span>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ ...btnBase, padding: '3px 8px', background: 'transparent', color: 'var(--text-primary)' }}
        >{expanded ? t('modelStorage.hideFiles', { defaultValue: 'Hide files' }) : t('modelStorage.showFiles', { defaultValue: 'Show files' })}</button>
        {files.length > 1 && (
          <button
            onClick={() => onRemoveAllContainer(engine, item, label)}
            disabled={busy}
            style={{ ...btnBase, padding: '3px 8px', background: 'transparent', color: 'var(--destructive)', borderColor: 'var(--destructive)', opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
          >{t('modelStorage.removeAll', { defaultValue: 'Remove all' })}</button>
        )}
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', paddingLeft: 12 }}>
          {files.map(f => (
            <div key={f.name} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              padding: '4px 8px', borderTop: 'var(--border-width) solid var(--border)',
            }}>
              <span title={f.name} style={{ flex: 1, minWidth: 0, fontSize: 9, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {f.displayName}
              </span>
              <span style={{ ...chip, color: f.location === 'root' ? 'var(--success, var(--accent))' : 'var(--text-muted)', borderColor: f.location === 'root' ? 'var(--success, var(--accent))' : 'var(--border)' }}>
                {f.location === 'root' ? t('modelStorage.locRoot', { defaultValue: 'Storage' }) : t('modelStorage.locLegacy', { defaultValue: 'App data' })}
              </span>
              <span style={{ fontSize: 9, color: 'var(--text-muted)', minWidth: 56, textAlign: 'right' }}>{fmtBytes(f.bytes)}</span>
              <button
                onClick={() => onRemoveFile(engine, item.id, f)}
                disabled={busy}
                style={{ ...btnBase, padding: '3px 8px', background: 'transparent', color: 'var(--destructive)', borderColor: 'var(--destructive)', opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
              >{t('modelStorage.remove', { defaultValue: 'Remove' })}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
