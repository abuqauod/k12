import { useCallback, useEffect, useState } from 'react'
import type { Student } from '../../domain/students'
import type { SchoolClass } from '../../domain/classes'
import { getEnrollments, transferStudent, withdrawStudent, type Enrollment } from '../../lib/enrollmentsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

/** Transfer / withdraw, and the enrollment history they produce. */
export function EnrollmentTab({
  student,
  classes,
  onChanged,
}: {
  student: Student
  classes: SchoolClass[]
  onChanged: (updated: Student) => void
}) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [history, setHistory] = useState<Enrollment[] | null>(null)
  const [toClassId, setToClassId] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [wStatus, setWStatus] = useState<'withdrawn' | 'graduated'>('withdrawn')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await getEnrollments(getAccessToken, student.id)
    setHistory(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, student.id])

  useEffect(() => {
    void load()
  }, [load])

  const errorText = (code: string) => t(`enroll.error.${code}` as TranslationKey, {}) || t('enroll.error.generic')

  const doTransfer = async () => {
    if (!toClassId) return
    setBusy(true)
    setError(null)
    const res = await transferStudent(getAccessToken, student.id, { toClassId, effectiveDate, reason: reason.trim() || null })
    setBusy(false)
    if (res.kind !== 'ok') return setError(errorText(res.error))
    setReason('')
    setToClassId('')
    await load()
    onChanged({ ...student, classId: toClassId, branchId: res.data.to.branchId })
  }

  const doWithdraw = async () => {
    // A withdrawal must say why (the server requires it and audits it).
    if (wStatus === 'withdrawn' && reason.trim().length < 3) return setError(t('enroll.error.REASON_REQUIRED'))
    setBusy(true)
    setError(null)
    const res = await withdrawStudent(getAccessToken, student.id, { status: wStatus, effectiveDate, reason: reason.trim() || null })
    setBusy(false)
    if (res.kind !== 'ok') return setError(errorText(res.error))
    setReason('')
    await load()
    onChanged({ ...student, status: wStatus, active: false })
  }

  const canTransfer = can('enrollments.transfer')
  const canWithdraw = can('enrollments.withdraw')

  return (
    <div className="profile-grid">
      {(canTransfer || canWithdraw) && student.status === 'enrolled' && (
        <section className="card profile-card profile-card--full">
          <h2 className="card__title">
            {t('enroll.transfer')} / {t('enroll.withdraw')}
          </h2>
          <div className="field-grid">
            <label className="field">
              <span>{t('enroll.effectiveDate')}</span>
              <input type="date" className="input" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
            </label>
            <label className="field field--wide">
              <span>{t('enroll.reason')}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
          <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {canTransfer && (
              <>
                <select className="input input--sm" value={toClassId} onChange={(e) => setToClassId(e.target.value)} aria-label={t('enroll.toClass')}>
                  <option value="">{t('enroll.toClass')}…</option>
                  {classes
                    .filter((c) => c.id !== student.classId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                </select>
                <button type="button" className="btn btn--sm" disabled={busy || !toClassId} onClick={() => void doTransfer()}>
                  {t('enroll.confirmTransfer')}
                </button>
              </>
            )}
            {canWithdraw && (
              <>
                <select className="input input--sm" value={wStatus} onChange={(e) => setWStatus(e.target.value as 'withdrawn' | 'graduated')} aria-label={t('enroll.withdraw')}>
                  <option value="withdrawn">{t('enroll.status.withdrawn')}</option>
                  <option value="graduated">{t('enroll.status.graduated')}</option>
                </select>
                <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void doWithdraw()}>
                  {t('enroll.withdraw')}
                </button>
              </>
            )}
          </div>
          {error && <p className="login__error">{error}</p>}
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
            <table className="table" style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>{t('enroll.effectiveDate')}</th>
                  <th>{t('lessons.col.cohort')}</th>
                  <th>{t('logs.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.startDate}
                      {e.endDate ? ` → ${e.endDate}` : ` (${t('enroll.current')})`}
                    </td>
                    <td>{classes.find((c) => c.id === e.classId)?.label ?? e.classId}</td>
                    <td>{t(`enroll.status.${e.status}` as TranslationKey)}</td>
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
