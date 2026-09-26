import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { STATUS_TONE, listApplications, type Application, type ApplicationStatus } from '../lib/admissionsApi'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type View = 'open' | 'accepted' | 'all' | 'closed'

const VIEW_STATUSES: Record<View, ApplicationStatus[] | null> = {
  open: ['draft', 'submitted', 'under_review', 'waitlisted'],
  accepted: ['accepted'],
  closed: ['converted', 'rejected', 'withdrawn'],
  all: null,
}

/** Applications for the active branch (SAMS 2.5): open work first. */
export function AdmissionsPage() {
  const { t, n, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const navigate = useNavigate()
  const [apps, setApps] = useState<Application[] | null>(null)
  const [years, setYears] = useState<AcademicYear[]>([])
  const [view, setView] = useState<View>('open')
  const [search, setSearch] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    setApps(null)
    void listApplications(getAccessToken, { branchId: activeBranchId ?? undefined }).then((res) => {
      if (!live) return
      if (res.kind === 'ok') setApps(res.data)
      else setError(true)
    })
    return () => {
      live = false
    }
  }, [getAccessToken, activeBranchId])

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((res) => {
      if (res.kind === 'ok') setYears(res.data)
    })
  }, [getAccessToken])

  const counts = useMemo(() => {
    const c: Record<View, number> = { open: 0, accepted: 0, closed: 0, all: apps?.length ?? 0 }
    for (const a of apps ?? []) {
      for (const v of ['open', 'accepted', 'closed'] as const) if (VIEW_STATUSES[v]!.includes(a.status)) c[v]++
    }
    return c
  }, [apps])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const statuses = VIEW_STATUSES[view]
    return (apps ?? []).filter((a) => {
      if (statuses && !statuses.includes(a.status)) return false
      if (!needle) return true
      return [a.applicationNumber, a.applicant.givenName, a.applicant.familyName, ...a.guardians.map((g) => `${g.fullName} ${g.phone}`)]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [apps, view, search])

  const yearName = (id: string) => years.find((y) => y.id === id)?.name ?? '—'

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.admissions')}</h1>
          <p className="page__subtitle">{t('admissions.subtitle')}</p>
        </div>
        {can('admissions.manage') && (
          <div className="page__actions">
            <button type="button" className="btn btn--primary" onClick={() => navigate('/admissions/new')}>
              + {t('admissions.new')}
            </button>
          </div>
        )}
      </header>

      <div className="card">
        <div className="page__actions" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <div className="segmented" role="group" aria-label={t('admissions.view')}>
            {(['open', 'accepted', 'closed', 'all'] as View[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                {t(`admissions.view.${v}` as TranslationKey)} <span className="mono">{n(counts[v])}</span>
              </button>
            ))}
          </div>
          <input
            className="input"
            style={{ flex: 1, minWidth: 200 }}
            placeholder={t('admissions.search')}
            aria-label={t('admissions.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {error ? (
          <div className="empty-state">{t('profile.error.generic')}</div>
        ) : apps === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : rows.length === 0 ? (
          <div className="empty-state">{t('admissions.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>{t('admissions.col.number')}</th>
                  <th>{t('admissions.col.applicant')}</th>
                  <th>{t('admissions.col.grade')}</th>
                  <th>{t('admissions.col.year')}</th>
                  <th>{t('admissions.col.status')}</th>
                  <th>{t('admissions.col.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">
                      <Link to={`/admissions/${a.id}`}>{a.applicationNumber}</Link>
                    </td>
                    <td>
                      <Link to={`/admissions/${a.id}`}>
                        {a.applicant.givenName} {a.applicant.familyName}
                      </Link>
                      {a.guardians[0] && <div className="docs__meta">{a.guardians[0].fullName}</div>}
                    </td>
                    <td>{a.gradeLevel}</td>
                    <td>{yearName(a.academicYearId)}</td>
                    <td>
                      <span className={`chip ${STATUS_TONE[a.status]}`}>{t(`admissions.status.${a.status}` as TranslationKey)}</span>
                    </td>
                    <td className="docs__meta">{new Date(a.updatedAt).toLocaleDateString(lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
