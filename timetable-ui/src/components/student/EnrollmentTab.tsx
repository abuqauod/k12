import { useCallback, useEffect, useState } from 'react'
import type { Student } from '../../domain/students'
import type { SchoolClass } from '../../domain/classes'
import {
  activateEnrollment,
  cancelEnrollment,
  getEnrollments,
  openEnrollment,
  transferStudent,
  withdrawStudent,
  type Enrollment,
} from '../../lib/enrollmentsApi'
import { listAcademicYears, type AcademicYear } from '../../lib/academicYearsApi'
import { listLookups, lookupLabel, type LookupItem } from '../../lib/settingsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { ReasonDialog } from '../ReasonDialog'

const TONE: Partial<Record<Enrollment['status'], string>> = {
  active: 'chip--ok',
  pending: 'chip--warn',
  withdrawn: 'chip--bad',
  cancelled: '',
}

/**
 * Where the student is and has been: transfer / withdraw (with a reason
 * from the settings list), re-enroll after leaving, plan next year's place,
 * and start or call off a planned place (SAMS 2.4). Every change is a new
 * history row; none is ever edited away.
 */
export function EnrollmentTab({
  student,
  classes,
  onChanged,
}: {
  student: Student
  classes: SchoolClass[]
  onChanged: (updated: Student) => void
}) {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [history, setHistory] = useState<Enrollment[] | null>(null)
  const [years, setYears] = useState<AcademicYear[]>([])
  const [reasons, setReasons] = useState<LookupItem[]>([])
  const [toClassId, setToClassId] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [wStatus, setWStatus] = useState<'withdrawn' | 'graduated'>('withdrawn')
  const [reasonCode, setReasonCode] = useState('')
  const [placeClassId, setPlaceClassId] = useState('')
  const [placeDate, setPlaceDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<Enrollment | null>(null)

  const load = useCallback(async () => {
    const res = await getEnrollments(getAccessToken, student.id)
    setHistory(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, student.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((res) => {
      if (res.kind === 'ok') setYears(res.data)
    })
    void listLookups(getAccessToken, 'withdrawalReason', true).then((res) => {
      if (res.kind === 'ok') setReasons(res.data)
    })
  }, [getAccessToken])

  const errorText = (code: string) => {
    const key = `enroll.error.${code}` as TranslationKey
    const text = t(key)
    return text === key ? t('enroll.error.generic') : text
  }
  const yearName = (id: string | null) => years.find((y) => y.id === id)?.name ?? ''
  const classOption = (c: SchoolClass) => `${c.label}${c.academicYearId ? ` · ${yearName(c.academicYearId)}` : ''}`
  const classLabel = (id: string) => {
    const c = classes.find((x) => x.id === id)
    return c ? classOption(c) : id
  }

  /** Runs a change, then reloads the history and tells the page. */
  const run = async (action: () => Promise<{ kind: 'ok' } | { kind: 'error'; error: string }>, after?: () => void) => {
    setBusy(true)
    setError(null)
    const res = await action()
    setBusy(false)
    if (res.kind !== 'ok') {
      setError(errorText(res.error))
      return false
    }
    await load()
    after?.()
    return true
  }

  const doTransfer = () =>
    run(
      () => transferStudent(getAccessToken, student.id, { toClassId, effectiveDate, reason: note.trim() || null }),
      () => {
        setNote('')
        setToClassId('')
        const klass = classes.find((c) => c.id === toClassId)
        onChanged({ ...student, classId: toClassId, branchId: klass?.branchId ?? student.branchId })
      },
    )

  const doWithdraw = () => {
    if (wStatus === 'withdrawn' && !reasonCode) return setError(t('enroll.error.REASON_REQUIRED'))
    return run(
      () =>
        withdrawStudent(getAccessToken, student.id, {
          status: wStatus,
          effectiveDate,
          reason: note.trim() || null,
          reasonCode: wStatus === 'withdrawn' ? reasonCode : null,
        }),
      () => {
        setNote('')
        onChanged({ ...student, status: wStatus, active: false })
      },
    )
  }

  const doOpen = (pending: boolean) =>
    run(
      () => openEnrollment(getAccessToken, student.id, { classId: placeClassId, startDate: placeDate, pending }),
      () => {
        setPlaceClassId('')
        if (!pending) {
          const klass = classes.find((c) => c.id === placeClassId)
          onChanged({ ...student, classId: placeClassId, branchId: klass?.branchId ?? student.branchId, status: 'enrolled', active: true })
        }
      },
    )

  const doActivate = (row: Enrollment) =>
    run(
      () => activateEnrollment(getAccessToken, row.id),
      () => onChanged({ ...student, classId: row.classId, branchId: row.branchId, status: 'enrolled', active: true }),
    )

  const enrolled = (student.status ?? 'enrolled') === 'enrolled'
  // Left the school (as opposed to admitted and not yet started).
  const returning = student.status === 'withdrawn' || student.status === 'graduated'
  const canTransfer = can('enrollments.transfer')
  const canWithdraw = can('enrollments.withdraw')
  const canAssign = can('enrollments.assign')
  const activeReasons = reasons.filter((r) => r.active)

  return (
    <div className="profile-grid">
      {error && (
        <p className="login__error profile-card--full" role="alert">
          {error}
        </p>
      )}

      {enrolled && (canTransfer || canWithdraw) && (
        <section className="card profile-card">
          <h2 className="card__title">
            {t('enroll.transfer')} / {t('enroll.withdraw')}
          </h2>
          <div className="field-grid">
            <label className="field">
              <span>{t('enroll.effectiveDate')}</span>
              <input type="date" className="input" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('enroll.note')}</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          {canTransfer && (
            <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <select className="input input--sm" value={toClassId} onChange={(e) => setToClassId(e.target.value)} aria-label={t('enroll.toClass')}>
                <option value="">{t('enroll.toClass')}…</option>
                {classes
                  .filter((c) => c.id !== student.classId && (!c.academicYearId || c.academicYearId === student.academicYearId))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {classOption(c)}
                    </option>
                  ))}
              </select>
              <button type="button" className="btn btn--sm" disabled={busy || !toClassId} onClick={() => void doTransfer()}>
                {t('enroll.confirmTransfer')}
              </button>
            </div>
          )}
          {canWithdraw && (
            <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <select
                className="input input--sm"
                value={wStatus}
                onChange={(e) => setWStatus(e.target.value as 'withdrawn' | 'graduated')}
                aria-label={t('enroll.withdraw')}
              >
                <option value="withdrawn">{t('enroll.status.withdrawn')}</option>
                <option value="graduated">{t('enroll.status.graduated')}</option>
              </select>
              {wStatus === 'withdrawn' && (
                <select className="input input--sm" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} aria-label={t('enroll.reasonCode')}>
                  <option value="">{t('enroll.reasonCode')}…</option>
                  {activeReasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {lookupLabel(reasons, r.code, lang)}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy || (wStatus === 'withdrawn' && !reasonCode)}
                onClick={() => void doWithdraw()}
              >
                {t('enroll.withdraw')}
              </button>
            </div>
          )}
        </section>
      )}

      {canAssign && (
        <section className="card profile-card">
          <h2 className="card__title">{returning ? t('enroll.reenroll.title') : t('enroll.plan.title')}</h2>
          <p className="card__hint" style={{ margin: 0 }}>
            {returning ? t('enroll.reenroll.hint') : enrolled ? t('enroll.plan.hint') : t('enroll.admitted.hint')}
          </p>
          <div className="field-grid">
            <label className="field">
              <span>{t('enroll.class')}</span>
              <select className="input" value={placeClassId} onChange={(e) => setPlaceClassId(e.target.value)}>
                <option value="">—</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {classOption(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('enroll.startDate')}</span>
              <input type="date" className="input" value={placeDate} onChange={(e) => setPlaceDate(e.target.value)} />
            </label>
          </div>
          <div className="page__actions">
            {returning && (
              <button type="button" className="btn btn--sm btn--primary" disabled={busy || !placeClassId} onClick={() => void doOpen(false)}>
                {t('enroll.reenroll.now')}
              </button>
            )}
            <button type="button" className="btn btn--sm" disabled={busy || !placeClassId} onClick={() => void doOpen(true)}>
              {t('enroll.plan.save')}
            </button>
          </div>
        </section>
      )}

      <section className="card profile-card profile-card--full">
        <h2 className="card__title">{t('enroll.history')}</h2>
        {history === null ? (
          <div className="skeleton" style={{ height: 56 }} />
        ) : history.length === 0 ? (
          <div className="empty-state">{t('profile.enrollment.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>{t('enroll.effectiveDate')}</th>
                  <th>{t('lessons.col.cohort')}</th>
                  <th>{t('logs.col.status')}</th>
                  <th>{t('enroll.why')}</th>
                  {canAssign && <th style={{ width: 180 }} />}
                </tr>
              </thead>
              <tbody>
                {history.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.startDate}
                      {e.endDate ? ` → ${e.endDate}` : e.status === 'active' ? ` (${t('enroll.current')})` : ''}
                    </td>
                    <td>{classLabel(e.classId)}</td>
                    <td>
                      <span className={`chip ${TONE[e.status] ?? ''}`}>{t(`enroll.status.${e.status}` as TranslationKey)}</span>
                    </td>
                    <td className="docs__meta">
                      {[e.reasonCode && lookupLabel(reasons, e.reasonCode, lang), e.reason].filter(Boolean).join(' — ')}
                    </td>
                    {canAssign && (
                      <td>
                        {e.status === 'pending' && (
                          <span className="row-actions">
                            <button type="button" className="btn btn--sm" disabled={busy || enrolled} title={enrolled ? t('enroll.activate.blocked') : undefined} onClick={() => void doActivate(e)}>
                              {t('enroll.activate')}
                            </button>
                            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setCancelling(e)}>
                              {t('enroll.cancel')}
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canAssign && enrolled && history?.some((e) => e.status === 'pending') && (
          <p className="card__hint" style={{ margin: 0 }}>
            {t('enroll.activate.blocked')}
          </p>
        )}
      </section>

      {cancelling && (
        <ReasonDialog
          title={t('enroll.cancel.title', { class: classLabel(cancelling.classId) })}
          confirmLabel={t('enroll.cancel')}
          onClose={() => setCancelling(null)}
          onConfirm={async (reason) => {
            const res = await cancelEnrollment(getAccessToken, cancelling.id, reason)
            if (res.kind !== 'ok') return errorText(res.error)
            setCancelling(null)
            await load()
            return null
          }}
        />
      )}
    </div>
  )
}
