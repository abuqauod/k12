import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DiscountType, Scholarship } from '../../domain/finance'
import { formatMinorUnits, parseMinorUnits } from '../../domain/finance'
import { listScholarships, requestScholarship, revokeScholarship } from '../../lib/financeApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { DocumentsPanel } from '../DocumentsPanel'
import { ReasonDialog } from '../ReasonDialog'
import { RECORD_TONE, financeError } from './shared'

/**
 * SAMS 3.2 scholarships: for one student (their billing tab, where new
 * ones are requested) or for a branch (the Finance page). Each opens to
 * its supporting documents. Deciding happens on the Approvals page.
 */
export function ScholarshipsPanel({ studentId, branchId }: { studentId?: string; branchId?: string }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [rows, setRows] = useState<Scholarship[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<DiscountType>('percent')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [revoking, setRevoking] = useState<Scholarship | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listScholarships(getAccessToken, { studentId, branchId })
    if (res.kind === 'ok') setRows(res.data)
  }, [getAccessToken, studentId, branchId])
  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    if (!studentId) return
    const v = type === 'percent' ? Number(value) : parseMinorUnits(value)
    if (!name.trim() || !reason.trim() || v === null || !Number.isInteger(v) || v <= 0 || (type === 'percent' && v > 100)) {
      return setError(t('fin.scholarship.invalid'))
    }
    setError(null)
    const res = await requestScholarship(getAccessToken, { studentId, name: name.trim(), type, value: v, reason: reason.trim() })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setAdding(false)
    setName('')
    setValue('')
    setReason('')
    setOpenId(res.data.id)
    setNotice(t('fin.scholarship.requested'))
    await load()
  }

  const valueLabel = (s: Scholarship) => (s.type === 'percent' ? `${s.value}%` : formatMinorUnits(s.value))

  return (
    <section className={studentId ? 'card profile-card profile-card--full' : 'card'}>
      <div className="card__head">
        <h2 className="card__title">{t('fin.scholarships')}</h2>
        {studentId && can('finance.scholarship.request') && !adding && (
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            {t('fin.scholarship.new')}
          </button>
        )}
      </div>
      {adding && (
        <div className="inline-form">
          <input
            className="input input--sm"
            style={{ minWidth: 160 }}
            placeholder={t('fin.scholarship.name')}
            aria-label={t('fin.scholarship.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="input input--sm"
            value={type}
            onChange={(e) => setType(e.target.value as DiscountType)}
            aria-label={t('billing.discount')}
          >
            <option value="percent">{t('billing.discount.percent')}</option>
            <option value="amount">{t('billing.discount.amount')}</option>
          </select>
          <input
            className="input input--sm"
            style={{ maxWidth: 90 }}
            placeholder={t('fin.value')}
            aria-label={t('fin.value')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <input
            className="input input--sm"
            style={{ flex: 1, minWidth: 180 }}
            placeholder={t('billing.requestReason')}
            aria-label={t('billing.requestReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
            {t('billing.requestSend')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
            {t('approvals.cancel')}
          </button>
        </div>
      )}
      {rows === null ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('fin.scholarships.none')}</div>
      ) : (
        <ul className="record-list">
          {rows.map((s) => (
            <li key={s.id} className="record-list__item">
              <div className="record-list__row">
                <button
                  type="button"
                  className="record-list__main"
                  onClick={() => setOpenId(openId === s.id ? null : s.id)}
                  aria-expanded={openId === s.id}
                >
                  <b>{s.name}</b> · {valueLabel(s)}
                  {!studentId && s.studentName && (
                    <>
                      {' · '}
                      <Link className="card__link" to={`/students/${s.studentId}?tab=finance`} onClick={(e) => e.stopPropagation()}>
                        {s.studentName}
                      </Link>
                    </>
                  )}
                  <span className="card__hint"> — {s.reason}</span>
                </button>
                <span className={`chip ${RECORD_TONE[s.status] ?? ''}`}>{t(`fin.status.${s.status}` as TranslationKey)}</span>
                {s.status === 'active' && can('finance.scholarship.approve') && (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRevoking(s)}>
                    {t('fin.scholarship.revoke')}
                  </button>
                )}
              </div>
              {s.status === 'pending' && <p className="card__hint">{t('fin.scholarship.pendingHint')}</p>}
              {s.status === 'revoked' && s.revokeReason && (
                <p className="card__hint">{t('fin.scholarship.revokedBecause', { reason: s.revokeReason })}</p>
              )}
              {openId === s.id && <DocumentsPanel ownerType="scholarship" ownerId={s.id} />}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="card__hint">{notice}</p>}
      {error && <p className="login__error">{error}</p>}
      {revoking && (
        <ReasonDialog
          title={t('fin.scholarship.revoke')}
          confirmLabel={t('fin.scholarship.revoke')}
          onClose={() => setRevoking(null)}
          onConfirm={async (why) => {
            const res = await revokeScholarship(getAccessToken, revoking.id, why)
            if (res.kind !== 'ok') return financeError(t, res.error)
            setRevoking(null)
            setNotice(t('fin.scholarship.revoked', { n: res.data.invoicesUpdated }))
            await load()
            return null
          }}
        />
      )}
    </section>
  )
}
