import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  archiveAnnouncement,
  createAnnouncement,
  getAnnouncement,
  getChannels,
  getCommunicationSettings,
  listAnnouncements,
  listDeliveryLog,
  listTemplates,
  previewReminders,
  publishAnnouncement,
  resetTemplate,
  retryAllFailed,
  retryMessage,
  saveCommunicationSettings,
  saveTemplate,
  sendExpiringDocuments,
  sendFeeReminders,
  testSend,
  updateAnnouncement,
  type Announcement,
  type AnnouncementInput,
  type AudienceType,
  type Channel,
  type ChannelStatus,
  type CommunicationSettings,
  type DueRow,
  type LogEntry,
  type Template,
} from '../lib/communicationApi'
import { listClasses } from '../lib/classesApi'
import type { SchoolClass } from '../domain/classes'
import { formatMinorUnits } from '../domain/finance'
import { useLookup } from '../lib/useLookup'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/**
 * Communication (SAMS Phase 6, staff side): announcements to families,
 * fee reminders, the delivery log, message templates and the automatic
 * notice settings. Each tab shows only with its scope.
 */

type Tab = 'announcements' | 'reminders' | 'log' | 'templates' | 'settings'
const TAB_SCOPE: Record<Tab, string> = {
  announcements: 'announcements.manage',
  reminders: 'finance.reminders',
  log: 'notifications.manage',
  templates: 'notifications.manage',
  settings: 'notifications.manage',
}
const TABS = Object.keys(TAB_SCOPE) as Tab[]

export function commError(t: (key: TranslationKey) => string, code: string): string {
  const key = `comm.error.${code}` as TranslationKey
  const text = t(key)
  return text === key ? t('billing.error.generic') : text
}

const STATUS_TONE: Record<string, string> = {
  draft: '',
  published: 'chip--ok',
  archived: '',
  pending: 'chip--on',
  processing: 'chip--on',
  sent: 'chip--ok',
  failed: 'chip--warn',
  dead: 'chip--bad',
  skipped: '',
}

export function CommunicationPage() {
  const { t } = useI18n()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const allowed = TABS.filter((x) => can(TAB_SCOPE[x]))
  const asked = params.get('tab') as Tab
  const tab = allowed.includes(asked) ? asked : allowed[0]
  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.communication')}</h1>
          <p className="page__subtitle">{t('comm.subtitle')}</p>
        </div>
      </header>
      {!tab ? (
        <div className="empty-state">{t('comm.noAccess')}</div>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label={t('nav.communication')}>
            {allowed.map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                className="tabs__tab"
                onClick={() =>
                  setParams(
                    (p) => {
                      p.set('tab', x)
                      return p
                    },
                    { replace: true },
                  )
                }
              >
                {t(`comm.tab.${x}` as TranslationKey)}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="finance-panel">
            {tab === 'announcements' && <AnnouncementsTab />}
            {tab === 'reminders' && <RemindersTab />}
            {tab === 'log' && <LogTab />}
            {tab === 'templates' && <TemplatesTab />}
            {tab === 'settings' && (
              <>
                <DeliveryChannels />
                <SettingsTab />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// --------------------------------------------------------- announcements --

const AUDIENCES: AudienceType[] = ['school', 'branch', 'grade', 'class', 'bus']

function emptyDraft(branchId: string | null): AnnouncementInput {
  return {
    title: '',
    body: '',
    titleAr: null,
    bodyAr: null,
    audience: {
      type: 'branch',
      branchId,
      gradeLevels: [],
      classIds: [],
      busIds: [],
    },
    channels: [],
  }
}

function AnnouncementsTab() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId, branches } = useApp()
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<Announcement[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    id: string | null
    draft: AnnouncementInput
  } | null>(null)

  const load = useCallback(async () => {
    const res = await listAnnouncements(getAccessToken, {
      status: status || undefined,
    })
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, status])
  useEffect(() => {
    void load()
  }, [load])

  const branchName = (id: string | null) => branches.find((b) => b.id === id)?.name ?? ''

  return (
    <section className="card">
      <div className="card__head">
        <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('comm.col.status')}>
          <option value="">{t('comm.ann.all')}</option>
          {(['draft', 'published', 'archived'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`comm.ann.status.${s}` as TranslationKey)}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {!editing && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => setEditing({ id: null, draft: emptyDraft(activeBranchId) })}
          >
            + {t('comm.ann.new')}
          </button>
        )}
      </div>
      {editing && (
        <AnnouncementForm
          initial={editing.draft}
          id={editing.id}
          onDone={(saved) => {
            setEditing(null)
            if (saved) setOpenId(saved)
            void load()
          }}
        />
      )}
      {rows === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('comm.ann.none')}</div>
      ) : (
        <ul className="record-list">
          {rows.map((a) => (
            <li key={a.id} className="record-list__item">
              <div className="record-list__row">
                <button
                  type="button"
                  className="record-list__main"
                  onClick={() => setOpenId(openId === a.id ? null : a.id)}
                  aria-expanded={openId === a.id}
                >
                  <b>{a.title}</b>
                  <span className="card__hint">
                    {' '}
                    — {t(`comm.aud.${a.audience.type}` as TranslationKey)}
                    {a.audience.branchId && ` · ${branchName(a.audience.branchId)}`}
                    {a.publishedAt && ` · ${new Date(a.publishedAt).toLocaleDateString()}`}
                  </span>
                </button>
                <span className={`chip ${STATUS_TONE[a.status]}`}>{t(`comm.ann.status.${a.status}` as TranslationKey)}</span>
              </div>
              {openId === a.id && (
                <AnnouncementDetail id={a.id} onEdit={(draft) => setEditing({ id: a.id, draft })} onChanged={() => void load()} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AnnouncementForm({ initial, id, onDone }: { initial: AnnouncementInput; id: string | null; onDone: (id: string | null) => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { branches, buses, activeBranchId } = useApp()
  const [f, setF] = useState<AnnouncementInput>(initial)
  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [arabic, setArabic] = useState(Boolean(initial.titleAr || initial.bodyAr))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const aud = f.audience
  const setAud = (patch: Partial<typeof aud>) => setF({ ...f, audience: { ...aud, ...patch } })

  useEffect(() => {
    if (!aud.branchId) return setClasses([])
    void listClasses(getAccessToken, { branchId: aud.branchId }).then((r) => setClasses(r.kind === 'ok' ? r.data : []))
  }, [getAccessToken, aud.branchId])

  const grades = useMemo(() => [...new Set(classes.map((c) => c.gradeLevel))].sort(), [classes])
  // Buses are loaded for the branch picked in the header.
  const busChoices = aud.branchId === activeBranchId ? buses : []
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value])

  const save = async () => {
    if (!f.title.trim() || !f.body.trim()) return setError(t('comm.error.titleBody'))
    setSaving(true)
    const body: AnnouncementInput = {
      ...f,
      title: f.title.trim(),
      body: f.body.trim(),
      titleAr: arabic ? f.titleAr?.trim() || null : null,
      bodyAr: arabic ? f.bodyAr?.trim() || null : null,
      audience: {
        ...aud,
        branchId: aud.type === 'school' ? null : aud.branchId,
      },
    }
    const res = id ? await updateAnnouncement(getAccessToken, id, body) : await createAnnouncement(getAccessToken, body)
    setSaving(false)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    onDone(res.data.id)
  }

  return (
    <div className="record-detail comm-form">
      <label className="field">
        <span>{t('comm.ann.title')}</span>
        <input className="input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </label>
      <label className="field">
        <span>{t('comm.ann.body')}</span>
        <textarea className="input" rows={5} value={f.body} maxLength={8000} onChange={(e) => setF({ ...f, body: e.target.value })} />
      </label>
      <label className="field field--inline">
        <input type="checkbox" checked={arabic} onChange={(e) => setArabic(e.target.checked)} />
        <span>{t('comm.ann.addArabic')}</span>
      </label>
      {arabic && (
        <>
          <label className="field">
            <span>{t('comm.ann.titleAr')}</span>
            <input
              className="input"
              dir="rtl"
              value={f.titleAr ?? ''}
              maxLength={200}
              onChange={(e) => setF({ ...f, titleAr: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('comm.ann.bodyAr')}</span>
            <textarea
              className="input"
              dir="rtl"
              rows={5}
              value={f.bodyAr ?? ''}
              maxLength={8000}
              onChange={(e) => setF({ ...f, bodyAr: e.target.value })}
            />
          </label>
        </>
      )}

      <fieldset className="comm-audience">
        <legend>{t('comm.ann.audience')}</legend>
        <div className="inline-form">
          <select
            className="input input--sm"
            value={aud.type}
            aria-label={t('comm.ann.audience')}
            onChange={(e) =>
              setAud({
                type: e.target.value as AudienceType,
                gradeLevels: [],
                classIds: [],
                busIds: [],
              })
            }
          >
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {t(`comm.aud.${a}` as TranslationKey)}
              </option>
            ))}
          </select>
          {aud.type !== 'school' && (
            <select
              className="input input--sm"
              value={aud.branchId ?? ''}
              aria-label={t('nav.branch')}
              onChange={(e) =>
                setAud({
                  branchId: e.target.value,
                  gradeLevels: [],
                  classIds: [],
                  busIds: [],
                })
              }
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {aud.type === 'grade' && (
          <div className="check-grid">
            {grades.length === 0 && <span className="card__hint">{t('comm.ann.noGrades')}</span>}
            {grades.map((g) => (
              <label key={g} className="field field--inline">
                <input
                  type="checkbox"
                  checked={aud.gradeLevels.includes(g)}
                  onChange={() => setAud({ gradeLevels: toggle(aud.gradeLevels, g) })}
                />
                <span>{g}</span>
              </label>
            ))}
          </div>
        )}
        {aud.type === 'class' && (
          <div className="check-grid">
            {classes.length === 0 && <span className="card__hint">{t('comm.ann.noClasses')}</span>}
            {classes.map((c) => (
              <label key={c.id} className="field field--inline">
                <input
                  type="checkbox"
                  checked={aud.classIds.includes(c.id)}
                  onChange={() => setAud({ classIds: toggle(aud.classIds, c.id) })}
                />
                <span>{c.label || `${c.gradeLevel} ${c.name}`}</span>
              </label>
            ))}
          </div>
        )}
        {aud.type === 'bus' && (
          <div className="check-grid">
            {busChoices.length === 0 && <span className="card__hint">{t('comm.ann.noBuses')}</span>}
            {busChoices.map((b) => (
              <label key={b.id} className="field field--inline">
                <input type="checkbox" checked={aud.busIds.includes(b.id)} onChange={() => setAud({ busIds: toggle(aud.busIds, b.id) })} />
                <span>{b.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="comm-audience">
        <legend>{t('comm.ann.channels')}</legend>
        <p className="card__hint">{t('comm.ann.channelsHint')}</p>
        <div className="check-grid">
          {(['email', 'sms'] as Channel[]).map((c) => (
            <label key={c} className="field field--inline">
              <input
                type="checkbox"
                checked={f.channels.includes(c)}
                onChange={() => setF({ ...f, channels: toggle(f.channels, c) as Channel[] })}
              />
              <span>{t(`comm.channel.${c}` as TranslationKey)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="login__error">{error}</p>}
      <div className="inline-form">
        <button type="button" className="btn btn--sm btn--primary" disabled={saving} onClick={() => void save()}>
          {t('comm.ann.saveDraft')}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onDone(null)}>
          {t('docs.cancel')}
        </button>
      </div>
    </div>
  )
}

function AnnouncementDetail({ id, onEdit, onChanged }: { id: string; onEdit: (draft: AnnouncementInput) => void; onChanged: () => void }) {
  const { t, n } = useI18n()
  const { getAccessToken } = useAuth()
  const [a, setA] = useState<Announcement | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await getAnnouncement(getAccessToken, id)
    if (res.kind === 'ok') setA(res.data)
  }, [getAccessToken, id])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: typeof publishAnnouncement) => {
    const res = await fn(getAccessToken, id)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setError(null)
    setConfirming(false)
    await load()
    onChanged()
  }

  if (!a) return <div className="skeleton" style={{ height: 60 }} />
  return (
    <div className="record-detail">
      <p className="comm-body">{a.body}</p>
      {a.bodyAr && (
        <p className="comm-body" dir="rtl">
          <b>{a.titleAr}</b>
          <br />
          {a.bodyAr}
        </p>
      )}
      <p className="card__hint">
        {a.status === 'draft' ? t('comm.ann.reach', { count: n(a.reach ?? 0) }) : t('comm.ann.sentTo', { count: n(a.students) })}
        {a.channels.length > 0 && ` · ${a.channels.map((c) => t(`comm.channel.${c}` as TranslationKey)).join(', ')}`}
      </p>
      {a.sent && (
        <p className="card__hint">
          {t('comm.delivered', {
            families: n(a.sent.families),
            inApp: n(a.sent.inApp),
            email: n(a.sent.email),
            sms: n(a.sent.sms),
          })}
        </p>
      )}
      {error && <p className="login__error">{error}</p>}
      <div className="inline-form">
        {a.status === 'draft' && !confirming && (
          <>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setConfirming(true)}>
              {t('comm.ann.publish')}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() =>
                onEdit({
                  title: a.title,
                  body: a.body,
                  titleAr: a.titleAr,
                  bodyAr: a.bodyAr,
                  audience: a.audience,
                  channels: a.channels,
                })
              }
            >
              {t('comm.ann.edit')}
            </button>
          </>
        )}
        {confirming && (
          <>
            <span>{t('comm.ann.confirmPublish', { count: n(a.reach ?? 0) })}</span>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void run(publishAnnouncement)}>
              {t('comm.ann.publishNow')}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirming(false)}>
              {t('docs.cancel')}
            </button>
          </>
        )}
        {a.status !== 'archived' && !confirming && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void run(archiveAnnouncement)}>
            {t('comm.ann.archive')}
          </button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------- reminders --

function RemindersTab() {
  const { t, n } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [days, setDays] = useState('')
  const [rows, setRows] = useState<DueRow[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    const res = await previewReminders(getAccessToken, {
      branchId: activeBranchId ?? undefined,
      daysBefore: days === '' ? undefined : Number(days),
    })
    const list = res.kind === 'ok' ? res.data : []
    setRows(list)
    setPicked(new Set(list.filter((r) => !r.recent).map((r) => r.invoiceId)))
  }, [getAccessToken, activeBranchId, days])
  useEffect(() => {
    void load()
  }, [load])

  const send = async () => {
    setSending(true)
    const res = await sendFeeReminders(getAccessToken, {
      branchId: activeBranchId ?? undefined,
      daysBefore: days === '' ? undefined : Number(days),
      invoiceIds: [...picked],
    })
    setSending(false)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setError(null)
    setResult(
      t('comm.rem.result', {
        invoices: n(res.data.invoices),
        families: n(res.data.families),
        skipped: n(res.data.skippedRecent),
        unreachable: n(res.data.unreachable),
      }),
    )
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <label className="field field--inline">
          <span>{t('comm.rem.daysBefore')}</span>
          <input
            type="number"
            min={0}
            max={60}
            className="input input--sm"
            style={{ width: 96 }}
            placeholder={t('comm.rem.default')}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--sm btn--primary" disabled={sending || picked.size === 0} onClick={() => void send()}>
          {t('comm.rem.send', { count: n(picked.size) })}
        </button>
      </div>
      <p className="card__hint">{t('comm.rem.hint')}</p>
      {result && <p className="notice">{result}</p>}
      {error && <p className="login__error">{error}</p>}
      {rows === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('comm.rem.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th aria-label={t('comm.rem.pick')} />
                <th>{t('comm.col.invoice')}</th>
                <th>{t('comm.col.student')}</th>
                <th>{t('comm.col.due')}</th>
                <th className="num">{t('comm.col.amount')}</th>
                <th>{t('comm.col.reminded')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.invoiceId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={r.invoiceNumber}
                      disabled={r.recent}
                      checked={picked.has(r.invoiceId)}
                      onChange={() => {
                        const next = new Set(picked)
                        if (next.has(r.invoiceId)) next.delete(r.invoiceId)
                        else next.add(r.invoiceId)
                        setPicked(next)
                      }}
                    />
                  </td>
                  <td className="mono">{r.invoiceNumber}</td>
                  <td>
                    <Link to={`/students/${r.studentId}?tab=finance`}>{r.studentName}</Link>
                  </td>
                  <td>
                    {r.dueDate} {r.overdue && <span className="chip chip--bad">{t('comm.rem.overdue')}</span>}
                  </td>
                  <td className="num mono">{formatMinorUnits(r.amountDue)}</td>
                  <td>{r.remindedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------- log --

const KINDS = [
  'absence',
  'announcement',
  'fee_reminder',
  'payment_received',
  'admission_decision',
  'document_rejected',
  'document_expiring',
  'report_ready',
  'clinic_visit',
  'incident',
] as const

function LogTab() {
  const { t, n } = useI18n()
  const { getAccessToken } = useAuth()
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [data, setData] = useState<{
    entries: LogEntry[]
    counts: { pending: number; failed: number; dead: number }
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listDeliveryLog(getAccessToken, {
      kind: kind || undefined,
      status: status || undefined,
    })
    setData(res.kind === 'ok' ? res.data : { entries: [], counts: { pending: 0, failed: 0, dead: 0 } })
  }, [getAccessToken, kind, status])
  useEffect(() => {
    void load()
  }, [load])

  const retryAll = async () => {
    const res = await retryAllFailed(getAccessToken, { kind: kind || undefined })
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setError(null)
    await load()
  }
  const retry = async (id: string) => {
    const res = await retryMessage(getAccessToken, id)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setError(null)
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <select className="input input--sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('comm.col.kind')}>
          <option value="">{t('comm.log.allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`comm.kind.${k}` as TranslationKey)}
            </option>
          ))}
        </select>
        <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('comm.col.status')}>
          <option value="">{t('comm.log.allStatuses')}</option>
          {(['pending', 'sent', 'failed', 'dead'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`comm.job.${s}` as TranslationKey)}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {data && data.counts.dead + data.counts.failed > 0 && (
          <button type="button" className="btn btn--sm" onClick={() => void retryAll()}>
            {t('comm.log.retryAll', { count: n(data.counts.dead + data.counts.failed) })}
          </button>
        )}
        {data && (
          <span className="card__hint">
            {t('comm.log.counts', {
              pending: n(data.counts.pending),
              failed: n(data.counts.failed),
              dead: n(data.counts.dead),
            })}
          </span>
        )}
      </div>
      {error && <p className="login__error">{error}</p>}
      {data === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : data.entries.length === 0 ? (
        <div className="empty-state">{t('comm.log.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('comm.col.when')}</th>
                <th>{t('comm.col.kind')}</th>
                <th>{t('comm.col.to')}</th>
                <th>{t('comm.col.subject')}</th>
                <th>{t('comm.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{t(`comm.kind.${e.kind}` as TranslationKey)}</td>
                  <td>
                    {e.recipientName}
                    <br />
                    <small className="card__hint">
                      {t(`comm.channel.${e.channel}` as TranslationKey)} · {e.to}
                    </small>
                  </td>
                  <td dir="auto">{e.subject}</td>
                  <td>
                    <span className={`chip ${STATUS_TONE[e.status]}`}>{t(`comm.job.${e.status}` as TranslationKey)}</span>
                    {e.error && (
                      <>
                        <br />
                        <small className="card__hint">{commError(t, e.error)}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {(e.status === 'dead' || e.status === 'failed') && (
                      <button type="button" className="btn btn--sm" onClick={() => void retry(e.id)}>
                        {t('comm.log.retry')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------- templates --

function TemplatesTab() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [list, setList] = useState<Template[] | null>(null)
  const [kind, setKind] = useState<string>('')
  const [draft, setDraft] = useState<Template | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listTemplates(getAccessToken)
    if (res.kind !== 'ok') return setList([])
    setList(res.data)
    setKind((k) => k || res.data[0]?.kind || '')
  }, [getAccessToken])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setDraft(list?.find((x) => x.kind === kind) ?? null)
    setSaved(false)
    setError(null)
  }, [list, kind])

  if (list === null) return <div className="skeleton" style={{ height: 100 }} />
  const field = (key: keyof Template, label: TranslationKey, rows = 1, rtl = false) => (
    <label className="field">
      <span>{t(label)}</span>
      {rows > 1 ? (
        <textarea
          className="input"
          rows={rows}
          dir={rtl ? 'rtl' : undefined}
          value={String(draft![key] ?? '')}
          onChange={(e) => setDraft({ ...draft!, [key]: e.target.value })}
        />
      ) : (
        <input
          className="input"
          dir={rtl ? 'rtl' : undefined}
          value={String(draft![key] ?? '')}
          onChange={(e) => setDraft({ ...draft!, [key]: e.target.value })}
        />
      )}
    </label>
  )
  const save = async () => {
    if (!draft) return
    const { kind: k, tokens: _tokens, customised: _c, ...body } = draft
    const res = await saveTemplate(getAccessToken, k, body)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setSaved(true)
    await load()
  }
  const reset = async () => {
    const res = await resetTemplate(getAccessToken, kind)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <select className="input input--sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('comm.col.kind')}>
          {list.map((x) => (
            <option key={x.kind} value={x.kind}>
              {t(`comm.kind.${x.kind}` as TranslationKey)}
              {x.customised ? ` · ${t('comm.tpl.customised')}` : ''}
            </option>
          ))}
        </select>
      </div>
      {draft && (
        <div className="comm-form">
          <p className="card__hint">
            {t('comm.tpl.tokens')} {draft.tokens.map((x) => `{${x}}`).join(' ')}
          </p>
          <label className="field field--inline">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            <span>{t('comm.tpl.enabled')}</span>
          </label>
          <div className="comm-columns">
            <div>
              <h3 className="card__title">{t('comm.tpl.english')}</h3>
              {field('subject', 'comm.tpl.subject')}
              {field('body', 'comm.tpl.body', 6)}
              {field('smsBody', 'comm.tpl.sms', 2)}
            </div>
            <div>
              <h3 className="card__title">{t('comm.tpl.arabic')}</h3>
              {field('subjectAr', 'comm.tpl.subject', 1, true)}
              {field('bodyAr', 'comm.tpl.body', 6, true)}
              {field('smsBodyAr', 'comm.tpl.sms', 2, true)}
            </div>
          </div>
          {error && <p className="login__error">{error}</p>}
          {saved && <p className="notice">{t('comm.tpl.saved')}</p>}
          <div className="inline-form">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()}>
              {t('comm.save')}
            </button>
            {draft.customised && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void reset()}>
                {t('comm.tpl.reset')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// -------------------------------------------------------------- settings --

/** Whether email and SMS are set up on the server, and a test message to
 * prove it. Credentials live in the server's environment, never here. */
function DeliveryChannels() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [status, setStatus] = useState<ChannelStatus | null>(null)
  const [channel, setChannel] = useState<Channel>('email')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null)
  useEffect(() => {
    void getChannels(getAccessToken).then((r) => r.kind === 'ok' && setStatus(r.data))
  }, [getAccessToken])
  const send = async () => {
    setBusy(true)
    setNote(null)
    const res = await testSend(getAccessToken, channel, to.trim())
    setBusy(false)
    if (res.kind === 'ok') return setNote({ text: t('comm.ch.sent'), warn: false })
    const reason = String(res.details?.reason ?? res.error)
    const code = reason.split(':')[0]!
    const key = `comm.ch.error.${code}` as TranslationKey
    setNote({ text: `${t(key) === key ? t('comm.ch.error.generic') : t(key)} (${reason})`, warn: true })
  }
  if (!status) return <div className="skeleton" style={{ height: 80 }} />
  const row = (label: TranslationKey, ok: boolean, detail: string | null) => (
    <div className="stat-row">
      <span>{t(label)}</span>
      <span>
        {detail && <span className="mono card__hint">{detail} </span>}
        <span className={`chip ${ok ? 'chip--ok' : 'chip--warn'}`}>{ok ? t('comm.ch.ready') : t('comm.ch.notSetUp')}</span>
      </span>
    </div>
  )
  return (
    <section className="card">
      <h2 className="card__title">{t('comm.ch.title')}</h2>
      {row('comm.ch.email', status.email.configured, status.email.from)}
      {row('comm.ch.sms', status.sms.configured, status.sms.provider && t(`comm.ch.provider.${status.sms.provider}` as TranslationKey))}
      {(!status.email.configured || !status.sms.configured) && <p className="card__hint">{t('comm.ch.howTo')}</p>}
      <div className="inline-form">
        <select className="input input--sm" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} aria-label={t('comm.ch.channel')}>
          <option value="email">{t('comm.ch.email')}</option>
          <option value="sms">{t('comm.ch.sms')}</option>
        </select>
        <input
          className="input input--sm"
          style={{ flex: 1, minWidth: 180 }}
          type={channel === 'email' ? 'email' : 'tel'}
          dir="ltr"
          placeholder={channel === 'email' ? 'name@example.com' : '07XXXXXXXX'}
          aria-label={t('comm.ch.to')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button type="button" className="btn btn--sm" disabled={busy || to.trim().length < 3} onClick={() => void send()}>
          {t('comm.ch.test')}
        </button>
      </div>
      {note && <p className={`notice${note.warn ? ' notice--warn' : ''}`}>{note.text}</p>}
    </section>
  )
}

function SettingsTab() {
  const { t, n } = useI18n()
  const { getAccessToken } = useAuth()
  const categories = useLookup('documentCategory')
  const [s, setS] = useState<CommunicationSettings | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getCommunicationSettings(getAccessToken).then((r) => r.kind === 'ok' && setS(r.data))
  }, [getAccessToken])

  if (!s) return <div className="skeleton" style={{ height: 100 }} />
  const save = async () => {
    const res = await saveCommunicationSettings(getAccessToken, {
      feeReminders: s.feeReminders,
      documentExpiry: s.documentExpiry,
      portalDocumentCategories: s.portalDocumentCategories,
    })
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setS(res.data)
    setError(null)
    setNote(t('comm.settings.saved'))
  }
  const sendDocs = async () => {
    const res = await sendExpiringDocuments(getAccessToken, s.documentExpiry.daysBefore)
    if (res.kind !== 'ok') return setError(commError(t, res.error))
    setNote(
      t('comm.settings.docsSent', {
        documents: n(res.data.documents),
        families: n(res.data.families),
      }),
    )
  }
  const num = (value: number, onChange: (v: number) => void, max: number) => (
    <input
      type="number"
      min={0}
      max={max}
      className="input input--sm"
      style={{ width: 70 }}
      value={value}
      onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
    />
  )

  return (
    <section className="card comm-form">
      <h3 className="card__title">{t('comm.settings.fee')}</h3>
      <label className="field field--inline">
        <input
          type="checkbox"
          checked={s.feeReminders.auto}
          onChange={(e) =>
            setS({
              ...s,
              feeReminders: { ...s.feeReminders, auto: e.target.checked },
            })
          }
        />
        <span>{t('comm.settings.feeAuto')}</span>
      </label>
      <div className="inline-form">
        <label className="field field--inline">
          <span>{t('comm.rem.daysBefore')}</span>
          {num(
            s.feeReminders.daysBefore,
            (v) =>
              setS({
                ...s,
                feeReminders: { ...s.feeReminders, daysBefore: v },
              }),
            60,
          )}
        </label>
        <label className="field field--inline">
          <span>{t('comm.settings.repeat')}</span>
          {num(
            s.feeReminders.repeatDays,
            (v) =>
              setS({
                ...s,
                feeReminders: { ...s.feeReminders, repeatDays: Math.max(1, v) },
              }),
            90,
          )}
        </label>
      </div>

      <h3 className="card__title">{t('comm.settings.docs')}</h3>
      <label className="field field--inline">
        <input
          type="checkbox"
          checked={s.documentExpiry.auto}
          onChange={(e) =>
            setS({
              ...s,
              documentExpiry: { ...s.documentExpiry, auto: e.target.checked },
            })
          }
        />
        <span>{t('comm.settings.docsAuto')}</span>
      </label>
      <div className="inline-form">
        <label className="field field--inline">
          <span>{t('comm.rem.daysBefore')}</span>
          {num(
            s.documentExpiry.daysBefore,
            (v) =>
              setS({
                ...s,
                documentExpiry: {
                  ...s.documentExpiry,
                  daysBefore: Math.max(1, v),
                },
              }),
            180,
          )}
        </label>
        <button type="button" className="btn btn--sm" onClick={() => void sendDocs()}>
          {t('comm.settings.docsNow')}
        </button>
      </div>

      <h3 className="card__title">{t('comm.settings.portalDocs')}</h3>
      <p className="card__hint">{t('comm.settings.portalDocsHint')}</p>
      <div className="check-grid">
        {categories.active.map((c) => (
          <label key={c.code} className="field field--inline">
            <input
              type="checkbox"
              checked={s.portalDocumentCategories.includes(c.code)}
              onChange={() =>
                setS({
                  ...s,
                  portalDocumentCategories: s.portalDocumentCategories.includes(c.code)
                    ? s.portalDocumentCategories.filter((x) => x !== c.code)
                    : [...s.portalDocumentCategories, c.code],
                })
              }
            />
            <span>{categories.label(c.code)}</span>
          </label>
        ))}
      </div>

      {s.lastRunDate && <p className="card__hint">{t('comm.settings.lastRun', { date: s.lastRunDate })}</p>}
      {error && <p className="login__error">{error}</p>}
      {note && <p className="notice">{note}</p>}
      <div className="inline-form">
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()}>
          {t('comm.save')}
        </button>
      </div>
    </section>
  )
}
