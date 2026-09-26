import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  billEvent,
  cancelRegistration,
  createEvent,
  getEvent,
  listEvents,
  markEventAttendance,
  registerForEvent,
  setEventCosts,
  setEventStatus,
  type EventStatus,
  type SchoolEvent,
} from '../lib/opsApi'
import { EVENT_TONE, opsError } from '../lib/opsUi'
import { useLookup } from '../lib/useLookup'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { PersonPicker } from '../components/ops/PersonPicker'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/** Events and activities (SAMS 5.6): the list, and one event. */

export function EventsPage() {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const types = useLookup('eventType')
  const navigate = useNavigate()
  const [upcoming, setUpcoming] = useState(true)
  const [rows, setRows] = useState<SchoolEvent[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ title: '', typeCode: '', startDate: '', endDate: '', capacity: '', fee: '', grades: '', location: '' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setRows(null)
    void listEvents(getAccessToken, { branchId: activeBranchId ?? undefined, upcoming }).then(
      (res) => live && setRows(res.kind === 'ok' ? res.data : []),
    )
    return () => {
      live = false
    }
  }, [getAccessToken, activeBranchId, upcoming])

  const add = async () => {
    if (!activeBranchId || !f.title.trim() || !f.startDate) return setError(t('ev.error.form'))
    const res = await createEvent(getAccessToken, {
      branchId: activeBranchId,
      title: f.title.trim(),
      typeCode: f.typeCode || types.active[0]?.code,
      startDate: f.startDate,
      endDate: f.endDate || f.startDate,
      capacity: f.capacity ? Number(f.capacity) : null,
      fee: f.fee.trim() ? parseMinorUnits(f.fee) : null,
      gradeLevels: f.grades
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
      location: f.location.trim() || null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    navigate(`/events/${res.data.id}`)
  }

  const title = (e: SchoolEvent) => (lang === 'ar' && e.titleAr) || e.title
  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.events')}</h1>
          <p className="page__subtitle">{t('ev.subtitle')}</p>
        </div>
        {can('ops.events.manage') && !adding && (
          <div className="page__actions">
            <button type="button" className="btn btn--primary" disabled={!activeBranchId} onClick={() => setAdding(true)}>
              + {t('ev.new')}
            </button>
          </div>
        )}
      </header>
      {adding && (
        <section className="card">
          <h2 className="card__title">{t('ev.new')}</h2>
          <div className="field-grid">
            <label className="field">
              <span>{t('ev.title')}</span>
              <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('ev.type')}</span>
              <select className="input" value={f.typeCode} onChange={(e) => setF({ ...f, typeCode: e.target.value })}>
                {types.active.map((c) => (
                  <option key={c.code} value={c.code}>
                    {types.label(c.code)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('ev.start')}</span>
              <input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('ev.end')}</span>
              <input className="input" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('ev.location')}</span>
              <input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('ev.capacity')}</span>
              <input className="input" inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('ev.fee')}</span>
              <input className="input" inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('ev.grades')}</span>
              <input
                className="input"
                placeholder="Grade 5, Grade 6"
                value={f.grades}
                onChange={(e) => setF({ ...f, grades: e.target.value })}
              />
            </label>
          </div>
          {error && <p className="login__error">{error}</p>}
          <div className="page__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setAdding(false)}>
              {t('approvals.cancel')}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void add()}>
              {t('ev.create')}
            </button>
          </div>
        </section>
      )}
      <section className="card">
        <div className="card__head">
          <div className="segmented" role="group" aria-label={t('nav.events')}>
            <button type="button" aria-pressed={upcoming} onClick={() => setUpcoming(true)}>
              {t('ev.upcoming')}
            </button>
            <button type="button" aria-pressed={!upcoming} onClick={() => setUpcoming(false)}>
              {t('ev.all')}
            </button>
          </div>
        </div>
        {rows === null ? (
          <div className="skeleton" style={{ height: 100 }} />
        ) : rows.length === 0 ? (
          <div className="empty-state">{t('ev.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>{t('ev.title')}</th>
                  <th>{t('ev.dates')}</th>
                  <th>{t('ev.places')}</th>
                  <th>{t('hr.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link to={`/events/${e.id}`}>{title(e)}</Link>
                      <div className="docs__meta">{types.label(e.typeCode)}</div>
                    </td>
                    <td className="mono">{e.startDate === e.endDate ? e.startDate : `${e.startDate} → ${e.endDate}`}</td>
                    <td className="mono">
                      {e.registered}
                      {e.capacity !== null && ` / ${e.capacity}`}
                      {e.waitlisted > 0 && <span className="card__hint"> (+{e.waitlisted})</span>}
                    </td>
                    <td>
                      <span className={`chip ${EVENT_TONE[e.status]}`}>{t(`ev.status.${e.status}` as TranslationKey)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

const NEXT: Record<EventStatus, EventStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['open', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

export function EventPage() {
  const { id = '' } = useParams()
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const types = useLookup('eventType')
  const [event, setEvent] = useState<SchoolEvent | null>(null)
  const [years, setYears] = useState<AcademicYear[]>([])
  const [costs, setCosts] = useState<{ label: string; amount: string }[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const canManage = can('ops.events.manage')

  const load = useCallback(async () => {
    const res = await getEvent(getAccessToken, id)
    if (res.kind === 'ok') {
      setEvent(res.data)
      setCosts(res.data.costs.map((c) => ({ label: c.label, amount: formatMinorUnits(c.amount) })))
    }
  }, [getAccessToken, id])
  useEffect(() => {
    void load()
    void listAcademicYears(getAccessToken).then((r) => r.kind === 'ok' && setYears(r.data))
  }, [load, getAccessToken])

  const done = async (res: { kind: 'ok' } | { kind: 'error'; error: string }, ok?: string) => {
    if (res.kind !== 'ok') return setMsg({ ok: false, text: opsError(t, res.error) })
    setMsg(ok ? { ok: true, text: ok } : null)
    await load()
  }

  if (!event)
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    )
  const regs = event.registrations ?? []
  const started = event.startDate <= new Date().toISOString().slice(0, 10)
  const year = years.find((y) => y.startDate <= event.startDate && y.endDate >= event.startDate) ?? years.find((y) => y.current)

  return (
    <div className="page ops-page">
      <Link to="/events" className="card__link student-page__back">
        ← {t('nav.events')}
      </Link>
      <header className="page__head">
        <div>
          <h1 className="page__title">{(lang === 'ar' && event.titleAr) || event.title}</h1>
          <div className="docs__chips">
            <span className="chip">{types.label(event.typeCode)}</span>
            <span className="chip mono">
              {event.startDate === event.endDate ? event.startDate : `${event.startDate} → ${event.endDate}`}
            </span>
            {event.location && <span className="chip">{event.location}</span>}
            {event.gradeLevels.length > 0 && <span className="chip">{event.gradeLevels.join(', ')}</span>}
            <span className={`chip ${EVENT_TONE[event.status]}`}>{t(`ev.status.${event.status}` as TranslationKey)}</span>
          </div>
        </div>
        {canManage && (
          <div className="page__actions">
            {NEXT[event.status].map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn--sm ${s === 'cancelled' ? 'btn--ghost' : ''}`}
                onClick={() => void setEventStatus(getAccessToken, id, s).then((r) => done(r))}
              >
                {t(`ev.to.${s}` as TranslationKey)}
              </button>
            ))}
          </div>
        )}
      </header>
      {msg && <p className={msg.ok ? 'card__hint' : 'login__error'}>{msg.text}</p>}

      <div className="tile-grid">
        <div className="stat-tile stat-tile--ok stat-tile--plain">
          <span className="stat-tile__label">{t('ev.registered')}</span>
          <b className="stat-tile__value">
            {event.registered}
            {event.capacity !== null && ` / ${event.capacity}`}
          </b>
        </div>
        <div className="stat-tile stat-tile--neutral stat-tile--plain">
          <span className="stat-tile__label">{t('ev.waitlisted')}</span>
          <b className="stat-tile__value">{event.waitlisted}</b>
        </div>
        <div className="stat-tile stat-tile--neutral stat-tile--plain">
          <span className="stat-tile__label">{t('ev.attended')}</span>
          <b className="stat-tile__value">{event.attended}</b>
        </div>
        <div className={`stat-tile stat-tile--${event.budget.net >= 0 ? 'ok' : 'bad'} stat-tile--plain`}>
          <span className="stat-tile__label">{t('ev.net')}</span>
          <b className="stat-tile__value">{formatMinorUnits(event.budget.net)}</b>
        </div>
      </div>

      <div className="card-row card-row--wide-first">
        <section className="card">
          <h2 className="card__title">{t('ev.registrations')}</h2>
          {canManage && event.status === 'open' && (
            <PersonPicker
              branchId={event.branchId}
              onPick={(p) =>
                void registerForEvent(getAccessToken, id, p.id).then((r) =>
                  done(r, r.kind === 'ok' ? t(r.data.status === 'waitlisted' ? 'ev.waitlistedMsg' : 'ev.registeredMsg') : undefined),
                )
              }
            />
          )}
          {regs.length === 0 && <p className="card__empty">{t('ev.noRegistrations')}</p>}
          {regs.map((r) => (
            <div key={r.id} className="stat-row">
              <span>
                {r.studentName} <span className="mono card__hint">{r.studentNumber}</span>
                {r.status === 'waitlisted' && (
                  <span className="chip chip--warn" style={{ marginInlineStart: 6 }}>
                    {t('ev.waitlist')}
                  </span>
                )}
              </span>
              <span className="row-actions">
                {canManage && started && r.status === 'registered' && (
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={!!r.attended}
                      onChange={(e) =>
                        void markEventAttendance(getAccessToken, id, [{ registrationId: r.id, attended: e.target.checked }]).then((x) =>
                          done(x),
                        )
                      }
                    />
                    {t('ev.attendedBox')}
                  </label>
                )}
                {canManage && !['completed', 'cancelled'].includes(event.status) && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() =>
                      void cancelRegistration(getAccessToken, id, r.id).then((x) =>
                        done(x, x.kind === 'ok' && x.data.promoted > 0 ? t('ev.promoted', { n: x.data.promoted }) : undefined),
                      )
                    }
                  >
                    {t('ev.remove')}
                  </button>
                )}
              </span>
            </div>
          ))}
        </section>
        <section className="card">
          <h2 className="card__title">{t('ev.budget')}</h2>
          <div className="stat-row">
            <span>{t('ev.income', { n: event.registered, fee: formatMinorUnits(event.fee ?? 0) })}</span>
            <b className="mono">{formatMinorUnits(event.budget.income)}</b>
          </div>
          {costs.map((c, i) => (
            <div key={i} className="inline-form" style={{ padding: 0 }}>
              <input
                className="input input--sm"
                style={{ flex: 1 }}
                disabled={!canManage}
                value={c.label}
                aria-label={t('ev.costLabel')}
                onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <input
                className="input input--sm"
                style={{ maxWidth: 100 }}
                disabled={!canManage}
                inputMode="decimal"
                value={c.amount}
                aria-label={t('billing.col.amount')}
                onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              {canManage && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('ev.removeCost')}
                  onClick={() => setCosts(costs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {canManage && (
            <div className="page__actions">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setCosts([...costs, { label: '', amount: '' }])}>
                + {t('ev.addCost')}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  void setEventCosts(
                    getAccessToken,
                    id,
                    costs.filter((c) => c.label.trim()).map((c) => ({ label: c.label.trim(), amount: parseMinorUnits(c.amount) ?? 0 })),
                  ).then((r) => done(r, t('hr.saved')))
                }
              >
                {t('hr.save')}
              </button>
            </div>
          )}
          <div className="stat-row">
            <span>{t('ev.net')}</span>
            <b className="mono">{formatMinorUnits(event.budget.net)}</b>
          </div>
          {event.fee && can('finance.invoice.lineItems') && canManage && year && ['open', 'closed', 'completed'].includes(event.status) && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() =>
                void billEvent(getAccessToken, id, year.id).then((r) =>
                  done(r, r.kind === 'ok' ? t('ev.billed', { n: r.data.charged, missing: r.data.noInvoice.length }) : undefined),
                )
              }
            >
              {t('ev.bill', { year: year.name })}
            </button>
          )}
        </section>
      </div>
    </div>
  )
}
