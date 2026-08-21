// apps/desktop/src/pages/settings/SchedulerSection.tsx
//
// Settings → Advanced → SCHEDULED. The UI for the local scheduler (USER-PAINS
// #9 / T14 — "the 2am build never fires"): run a saved FLOW from the nodes tab
// or a plain PROMPT once, daily, weekly, or every N minutes — fully offline, no
// cloud cron, surviving app restarts and PC sleep.
//
// The one genuinely novel control here is the MISSED-RUN policy: an occurrence
// that came due while the app was closed or the machine was asleep either runs
// once on wake, or is skipped and rolls forward. It is a per-job choice because
// "build the nightly report" wants catch-up and "post the 9am standup" does not.
//
// Deep link: the Flows rail writes `tachi:schedule-flow` into sessionStorage and
// navigates here; we consume it once to pre-fill the form with that flow.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../../components/ConfirmProvider'
import type {
  JobSchedule,
  MissedRunPolicy,
  ScheduleType,
  ScheduledJob,
  ScheduledJobTarget,
} from '../../types/electron'

interface FlowMeta { filename: string; name: string; savedAt: string }

const btnBase: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, padding: '5px 12px',
  border: 'var(--border-width) solid var(--border)',
  cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  background: 'transparent', color: 'var(--text-muted)',
}
const chip: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, padding: '2px 6px',
  border: 'var(--border-width) solid var(--border)',
  textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
}
const fieldLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3, display: 'block',
}
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 8px',
  border: 'var(--border-width) solid var(--border)', background: 'var(--bg-base)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
  borderRadius: 0, outline: 'none',
}

/** epoch ms → the value shape `<input type="datetime-local">` expects (local). */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtWhen(ms: number | null | undefined, never: string): string {
  if (ms == null || !Number.isFinite(ms)) return never
  return new Date(ms).toLocaleString()
}

interface Draft {
  id?: string
  name: string
  target: ScheduledJobTarget
  flowFile: string
  prompt: string
  type: ScheduleType
  at: string          // datetime-local
  timeOfDay: string   // HH:MM
  weekday: number
  everyMinutes: number
  missedPolicy: MissedRunPolicy
}

function emptyDraft(): Draft {
  const soon = Date.now() + 60 * 60_000
  return {
    name: '', target: 'flow', flowFile: '', prompt: '',
    type: 'daily', at: toLocalInput(soon), timeOfDay: '09:00',
    weekday: 1, everyMinutes: 60, missedPolicy: 'run',
  }
}

function draftFromJob(job: ScheduledJob): Draft {
  const base = emptyDraft()
  return {
    ...base,
    id: job.id,
    name: job.name,
    target: job.target,
    flowFile: job.flowFile ?? '',
    prompt: job.prompt,
    type: job.schedule.type,
    at: job.schedule.at ? toLocalInput(job.schedule.at) : base.at,
    timeOfDay: job.schedule.timeOfDay ?? base.timeOfDay,
    weekday: job.schedule.weekday ?? base.weekday,
    everyMinutes: job.schedule.everyMinutes ?? base.everyMinutes,
    missedPolicy: job.missedPolicy,
  }
}

function scheduleFromDraft(d: Draft): JobSchedule {
  switch (d.type) {
    case 'once':     return { type: 'once', at: new Date(d.at).getTime() }
    case 'daily':    return { type: 'daily', timeOfDay: d.timeOfDay }
    case 'weekly':   return { type: 'weekly', timeOfDay: d.timeOfDay, weekday: d.weekday }
    case 'interval': return { type: 'interval', everyMinutes: d.everyMinutes }
  }
}

export function SchedulerSection() {
  const { t } = useTranslation('settings')
  const confirm = useConfirm()
  const [jobs, setJobs] = React.useState<ScheduledJob[]>([])
  const [flows, setFlows] = React.useState<FlowMeta[]>([])
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    window.tachi.scheduler.list()
      .then(r => { if (Array.isArray(r.jobs)) setJobs(r.jobs) })
      .catch(() => {})
  }, [])

  React.useEffect(() => {
    refresh()
    const off = window.tachi.scheduler.onChanged(p => { if (Array.isArray(p.jobs)) setJobs(p.jobs) })
    return () => { off() }
  }, [refresh])

  React.useEffect(() => {
    window.tachi.nodes.listFlows()
      .then(r => { if (r.ok && Array.isArray(r.flows)) setFlows(r.flows) })
      .catch(() => {})
  }, [])

  // Deep link from the Flows rail: open the form pre-filled with that flow.
  React.useEffect(() => {
    let picked: string | null = null
    try {
      picked = sessionStorage.getItem('tachi:schedule-flow')
      if (picked) sessionStorage.removeItem('tachi:schedule-flow')
    } catch { /* storage disabled — deep link simply does nothing */ }
    if (!picked) return
    setDraft({ ...emptyDraft(), target: 'flow', flowFile: picked, name: picked.replace(/\.tachi-flow\.json$/, '') })
  }, [])

  const save = async () => {
    if (!draft) return
    setError(null)
    const res = await window.tachi.scheduler.save({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      target: draft.target,
      ...(draft.target === 'flow' ? { flowFile: draft.flowFile } : {}),
      prompt: draft.prompt,
      schedule: scheduleFromDraft(draft),
      missedPolicy: draft.missedPolicy,
      enabled: true,
    }).catch(err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
    if (!res.ok) { setError(res.error); return }
    setDraft(null)
    refresh()
  }

  const remove = async (job: ScheduledJob) => {
    const ok = await confirm({ message: t('scheduler.confirmDelete', { name: job.name, defaultValue: `Delete the scheduled job "${job.name}"?` }) })
    if (!ok) return
    await window.tachi.scheduler.remove(job.id).catch(() => {})
    refresh()
  }

  const toggle = async (job: ScheduledJob) => {
    await window.tachi.scheduler.setEnabled(job.id, !job.enabled).catch(() => {})
    refresh()
  }

  const runNow = async (job: ScheduledJob) => {
    setBusyId(job.id); setError(null)
    try {
      const r = await window.tachi.scheduler.runNow(job.id)
      if (!r.ok && r.error) setError(r.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null); refresh()
    }
  }

  const weekdayName = (n: number) => t(`scheduler.weekdays.${n}`, { defaultValue: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][n] ?? '' })

  const summary = (job: ScheduledJob): string => {
    const s = job.schedule
    switch (s.type) {
      case 'once':     return t('scheduler.summaryOnce', { when: fmtWhen(s.at, '—'), defaultValue: `Once on ${fmtWhen(s.at, '—')}` })
      case 'daily':    return t('scheduler.summaryDaily', { time: s.timeOfDay, defaultValue: `Every day at ${s.timeOfDay}` })
      case 'weekly':   return t('scheduler.summaryWeekly', { day: weekdayName(s.weekday ?? 0), time: s.timeOfDay, defaultValue: `Every ${weekdayName(s.weekday ?? 0)} at ${s.timeOfDay}` })
      case 'interval': return t('scheduler.summaryInterval', { minutes: s.everyMinutes, defaultValue: `Every ${s.everyMinutes} minutes` })
    }
  }

  const statusLabel = (job: ScheduledJob): { text: string; color: string } | null => {
    if (!job.lastStatus) return null
    switch (job.lastStatus) {
      case 'ok':      return { text: t('scheduler.statusOk', { defaultValue: 'OK' }), color: 'var(--success, var(--accent))' }
      case 'error':   return { text: t('scheduler.statusError', { defaultValue: 'Failed' }), color: 'var(--destructive)' }
      case 'blocked': return { text: t('scheduler.statusBlocked', { defaultValue: 'Blocked' }), color: 'var(--warning, var(--destructive))' }
      case 'skipped': return { text: t('scheduler.statusSkipped', { defaultValue: 'Skipped' }), color: 'var(--text-muted)' }
    }
  }

  const cardStyle: React.CSSProperties = {
    border: 'var(--border-width) solid var(--border)',
    background: 'var(--bg-elevated)',
    boxShadow: 'var(--shadow-hard)',
    padding: 12,
    fontFamily: 'JetBrains Mono, monospace',
  }

  return (
    <div id="scheduler-card" style={cardStyle}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, color: 'var(--text-primary)' }}>
        {t('scheduler.title', { defaultValue: 'Scheduled runs' })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        {t('scheduler.intro', { defaultValue: 'Run a saved flow or a prompt on a timer — once, daily, weekly, or every N minutes. Everything runs locally on this machine; nothing is sent to a cloud scheduler. Scheduled runs respect PRIVATE MODE, your 30-day spend cap, and the unattended-safety gate (destructive shell commands and writes outside the workspace are refused because nobody is watching).' })}
      </div>

      {error && (
        <div style={{ fontSize: 9, color: 'var(--destructive)', marginBottom: 10, lineHeight: 1.5 }}>{error}</div>
      )}

      {/* ── Job list ── */}
      {jobs.length === 0 && !draft && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
          {t('scheduler.empty', { defaultValue: 'No scheduled jobs yet.' })}
        </div>
      )}

      {jobs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {jobs.map(job => {
            const status = statusLabel(job)
            return (
              <div key={job.id} style={{ border: 'var(--border-width) solid var(--border)', background: 'var(--bg-surface)', padding: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ ...chip, color: 'var(--text-muted)' }}>
                    {job.target === 'flow'
                      ? t('scheduler.targetFlow', { defaultValue: 'Flow' })
                      : job.target === 'loop'
                        ? t('scheduler.targetLoop', { defaultValue: 'Loop' })
                        : t('scheduler.targetPrompt', { defaultValue: 'Prompt' })}
                  </span>
                  <span title={job.name} style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {job.name}
                  </span>
                  {!job.enabled && (
                    <span style={{ ...chip, color: 'var(--text-muted)' }}>{t('scheduler.paused', { defaultValue: 'Paused' })}</span>
                  )}
                  {status && (
                    <span style={{ ...chip, color: status.color, borderColor: status.color }}>{status.text}</span>
                  )}
                </div>

                <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  <div>{summary(job)} · {job.missedPolicy === 'run'
                    ? t('scheduler.missedRun', { defaultValue: 'Run missed on wake' })
                    : t('scheduler.missedSkip', { defaultValue: 'Skip missed runs' })}</div>
                  <div>
                    {t('scheduler.nextRun', { defaultValue: 'Next' })}: <b style={{ color: 'var(--text-primary)' }}>
                      {job.enabled ? fmtWhen(job.nextRunAt, t('scheduler.never', { defaultValue: '—' })) : t('scheduler.paused', { defaultValue: 'Paused' })}
                    </b>
                    {'  ·  '}
                    {t('scheduler.lastRun', { defaultValue: 'Last' })}: <b style={{ color: 'var(--text-primary)' }}>{fmtWhen(job.lastRunAt, t('scheduler.never', { defaultValue: '—' }))}</b>
                  </div>
                  {job.lastDetail && (
                    <div title={job.lastDetail} style={{ marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {job.lastDetail}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <button onClick={() => runNow(job)} disabled={busyId !== null} style={{ ...btnBase, opacity: busyId !== null ? 0.5 : 1, cursor: busyId !== null ? 'default' : 'pointer' }}>
                    {busyId === job.id ? t('scheduler.running', { defaultValue: 'Running…' }) : t('scheduler.runNow', { defaultValue: 'Run now' })}
                  </button>
                  <button onClick={() => toggle(job)} style={btnBase}>
                    {job.enabled ? t('scheduler.pause', { defaultValue: 'Pause' }) : t('scheduler.resume', { defaultValue: 'Resume' })}
                  </button>
                  {/* A LOOP row is written by the harness's loop controller (its
                      resume point), not by this form — editing it here would
                      strip the resume state, so it is delete/pause/run-now only. */}
                  {job.target !== 'loop' && (
                    <button onClick={() => { setError(null); setDraft(draftFromJob(job)) }} style={btnBase}>
                      {t('scheduler.edit', { defaultValue: 'Edit' })}
                    </button>
                  )}
                  <button onClick={() => remove(job)} style={{ ...btnBase, color: 'var(--destructive)', borderColor: 'var(--destructive)' }}>
                    {t('scheduler.delete', { defaultValue: 'Delete' })}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Create / edit form ── */}
      {draft ? (
        <div style={{ border: 'var(--border-width) solid var(--accent)', background: 'var(--bg-surface)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label style={fieldLabel}>{t('scheduler.name', { defaultValue: 'Name' })}</label>
            <input
              style={input}
              value={draft.name}
              placeholder={t('scheduler.namePlaceholder', { defaultValue: 'Nightly report' })}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </div>

          <div>
            <label style={fieldLabel}>{t('scheduler.what', { defaultValue: 'What to run' })}</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              {(['flow', 'prompt'] as ScheduledJobTarget[]).map(tg => (
                <button
                  key={tg}
                  onClick={() => setDraft({ ...draft, target: tg })}
                  style={{
                    ...btnBase,
                    background: draft.target === tg ? 'var(--accent)' : 'transparent',
                    color: draft.target === tg ? '#fff' : 'var(--text-muted)',
                    borderColor: draft.target === tg ? 'var(--accent)' : 'var(--border)',
                  }}
                >
                  {tg === 'flow'
                    ? t('scheduler.targetFlow', { defaultValue: 'Flow' })
                    : t('scheduler.targetPrompt', { defaultValue: 'Prompt' })}
                </button>
              ))}
            </div>

            {draft.target === 'flow' ? (
              <>
                <select style={input} value={draft.flowFile} onChange={e => setDraft({ ...draft, flowFile: e.target.value })}>
                  <option value="">{t('scheduler.flowNone', { defaultValue: 'Pick a saved flow…' })}</option>
                  {flows.map(f => <option key={f.filename} value={f.filename}>{f.name}</option>)}
                </select>
                <div style={{ marginTop: 6 }}>
                  <label style={fieldLabel}>{t('scheduler.input', { defaultValue: 'Input (optional)' })}</label>
                  <input
                    style={input}
                    value={draft.prompt}
                    placeholder={t('scheduler.inputPlaceholder', { defaultValue: 'Text handed to the flow as its input' })}
                    onChange={e => setDraft({ ...draft, prompt: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <textarea
                style={{ ...input, minHeight: 64, resize: 'vertical' }}
                value={draft.prompt}
                placeholder={t('scheduler.promptPlaceholder', { defaultValue: 'Summarize what changed in my workspace today and write it to notes.md' })}
                onChange={e => setDraft({ ...draft, prompt: e.target.value })}
              />
            )}
          </div>

          <div>
            <label style={fieldLabel}>{t('scheduler.when', { defaultValue: 'When' })}</label>
            <select style={input} value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as ScheduleType })}>
              <option value="once">{t('scheduler.once', { defaultValue: 'Once' })}</option>
              <option value="daily">{t('scheduler.daily', { defaultValue: 'Every day' })}</option>
              <option value="weekly">{t('scheduler.weekly', { defaultValue: 'Every week' })}</option>
              <option value="interval">{t('scheduler.interval', { defaultValue: 'Every N minutes' })}</option>
            </select>

            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {draft.type === 'once' && (
                <input type="datetime-local" style={input} value={draft.at} onChange={e => setDraft({ ...draft, at: e.target.value })} />
              )}
              {draft.type === 'weekly' && (
                <select style={input} value={draft.weekday} onChange={e => setDraft({ ...draft, weekday: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{weekdayName(n)}</option>)}
                </select>
              )}
              {(draft.type === 'daily' || draft.type === 'weekly') && (
                <input type="time" style={input} value={draft.timeOfDay} onChange={e => setDraft({ ...draft, timeOfDay: e.target.value })} />
              )}
              {draft.type === 'interval' && (
                <input
                  type="number" min={5} step={5} style={input} value={draft.everyMinutes}
                  onChange={e => setDraft({ ...draft, everyMinutes: Number(e.target.value) })}
                />
              )}
            </div>
          </div>

          <div>
            <label style={fieldLabel}>{t('scheduler.missed', { defaultValue: 'If the run was missed (app closed / PC asleep)' })}</label>
            <select style={input} value={draft.missedPolicy} onChange={e => setDraft({ ...draft, missedPolicy: e.target.value as MissedRunPolicy })}>
              <option value="run">{t('scheduler.missedRun', { defaultValue: 'Run missed on wake' })}</option>
              <option value="skip">{t('scheduler.missedSkip', { defaultValue: 'Skip missed runs' })}</option>
            </select>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
              {t('scheduler.missedHint', { defaultValue: 'Run-on-wake fires once when the app comes back, however many occurrences were missed — it never stampedes.' })}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={save} style={{ ...btnBase, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', boxShadow: 'var(--shadow-hard)' }}>
              {t('scheduler.save', { defaultValue: 'Save' })}
            </button>
            <button onClick={() => { setDraft(null); setError(null) }} style={btnBase}>
              {t('scheduler.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setError(null); setDraft(emptyDraft()) }}
          style={{ ...btnBase, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', boxShadow: 'var(--shadow-hard)' }}
        >
          {t('scheduler.new', { defaultValue: 'New scheduled job' })}
        </button>
      )}

      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
        {t('scheduler.offlineNote', { defaultValue: 'The app must be running for a job to fire. Missed occurrences are handled by each job\'s policy the moment the app or the machine wakes up.' })}
      </div>
    </div>
  )
}
