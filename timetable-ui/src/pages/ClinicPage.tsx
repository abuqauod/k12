import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listClinicAlerts, listVisits, type AlertRow, type ClinicVisit } from '../lib/wellbeingApi'
import { VisitForm, VisitList } from '../components/wellbeing/Health'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/** The school clinic (backlog): the day's visits and the students whose
 * health needs watching. Needs `health.read`; recording needs `health.write`. */

type Tab = 'visits' | 'alerts'
const today = () => new Date().toISOString().slice(0, 10)

export function ClinicPage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'alerts' ? 'alerts' : 'visits'
  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.clinic')}</h1>
          <p className="page__subtitle">{t('wb.clinic.subtitle')}</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={t('nav.clinic')}>
        {(['visits', 'alerts'] as const).map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className="tabs__tab"
            onClick={() => setParams({ tab: x }, { replace: true })}
          >
            {t(`wb.clinic.tab.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="finance-panel">
        {tab === 'visits' ? <VisitsTab /> : <AlertsTab />}
      </div>
    </div>
  )
}

function VisitsTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [day, setDay] = useState(today())
  const [visits, setVisits] = useState<ClinicVisit[] | null>(null)
  const load = useCallback(async () => {
    const res = await listVisits(getAccessToken, { branchId: activeBranchId ?? undefined, from: day, to: day })
    setVisits(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, activeBranchId, day])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <>
      {can('health.write') && (
        <section className="card">
          <h2 className="card__title">{t('wb.visit.new')}</h2>
          <VisitForm branchId={activeBranchId ?? undefined} onSaved={() => void load()} />
        </section>
      )}
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">{t('wb.visits')}</h2>
          <input
            type="date"
            className="input input--sm"
            aria-label={t('wb.visit.when')}
            value={day}
            onChange={(e) => setDay(e.target.value || today())}
          />
        </div>
        {visits === null ? <div className="skeleton" style={{ height: 80 }} /> : <VisitList visits={visits} showStudent />}
      </section>
    </>
  )
}

function AlertsTab() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [rows, setRows] = useState<AlertRow[] | null>(null)
  useEffect(() => {
    void listClinicAlerts(getAccessToken, activeBranchId ?? undefined).then((r) => setRows(r.kind === 'ok' ? r.data : []))
  }, [getAccessToken, activeBranchId])
  return (
    <section className="card">
      <p className="card__hint">{t('wb.clinic.alertsHint')}</p>
      {rows === null ? (
        <div className="skeleton" style={{ height: 80 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('wb.clinic.noAlerts')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('wb.visit.student')}</th>
                <th>{t('wb.alerts')}</th>
                <th>{t('wb.atSchool')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId}>
                  <td>
                    <Link to={`/students/${r.studentId}?tab=health`}>{r.studentName}</Link>
                    <br />
                    <small className="card__hint mono">
                      {r.studentNumber} · {r.studentGroup}
                    </small>
                  </td>
                  <td>
                    <span className="docs__chips">
                      {r.alerts.map((a, i) => (
                        <span key={i} className={`chip ${a.severity === 'severe' ? 'chip--bad' : 'chip--warn'}`}>
                          {a.name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>{r.medicationsAtSchool.map((m) => [m.name, m.dose, m.schedule].filter(Boolean).join(' · ')).join('; ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
