import { useCallback, useEffect, useState } from 'react'
import { cancelLeave, myHr, requestLeave, type Employee, type LeaveOverview } from '../../lib/hrApi'
import { LEAVE_TONE, hrError } from '../../lib/hrUi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Self-service leave (SAMS 4.4): shown only to a member whose login HR has
 * linked to an employee record. Balances, own requests, and a request form;
 * decisions happen on the Approvals page, never by the employee.
 */
export function MyLeaveCard() {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [data, setData] = useState<(LeaveOverview & { employee: Employee }) | null>(null)
  const [f, setF] = useState({ typeCode: '', startDate: today(), endDate: today(), reason: '' })
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await myHr(getAccessToken)
    setData(res.kind === 'ok' ? res.data : null)
  }, [getAccessToken])
  useEffect(() => {
    void load()
  }, [load])

  if (!data) return null
  const name = (code: string) => {
    const b = data.balances.find((x) => x.typeCode === code)
    return b ? (lang === 'ar' && b.nameAr) || b.name : code
  }
  const submit = async () => {
    const res = await requestLeave(getAccessToken, {
      employeeId: data.employee.id,
      typeCode: f.typeCode || data.balances[0]?.typeCode || '',
      startDate: f.startDate,
      endDate: f.endDate,
      reason: f.reason.trim() || null,
    })
    if (res.kind !== 'ok') return setMsg(hrError(t, res.error))
    setMsg(t('hr.leave.requested', { n: res.data.days }))
    await load()
  }

  return (
    <section className="card">
      <h2 className="card__title">{t('hr.my.title')}</h2>
      {data.balances.map((b) => (
        <div key={b.typeCode} className="stat-row">
          <span>{name(b.typeCode)}</span>
          <b className="mono">
            {b.available ?? '∞'}
            {b.pending > 0 && <span className="card__hint"> ({t('hr.my.pending', { n: b.pending })})</span>}
          </b>
        </div>
      ))}
      <div className="inline-form">
        <select
          className="input input--sm"
          value={f.typeCode}
          onChange={(e) => setF({ ...f, typeCode: e.target.value })}
          aria-label={t('hr.leave.type')}
        >
          {data.balances.map((b) => (
            <option key={b.typeCode} value={b.typeCode}>
              {name(b.typeCode)}
            </option>
          ))}
        </select>
        <input
          type="date"
          className="input input--sm"
          value={f.startDate}
          onChange={(e) => setF({ ...f, startDate: e.target.value })}
          aria-label={t('hr.contract.start')}
        />
        <input
          type="date"
          className="input input--sm"
          value={f.endDate}
          onChange={(e) => setF({ ...f, endDate: e.target.value })}
          aria-label={t('hr.field.contractEnd')}
        />
        <input
          className="input input--sm"
          placeholder={t('billing.requestReason')}
          aria-label={t('billing.requestReason')}
          value={f.reason}
          onChange={(e) => setF({ ...f, reason: e.target.value })}
        />
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
          {t('billing.requestSend')}
        </button>
      </div>
      {msg && <p className="card__hint">{msg}</p>}
      {data.requests.slice(0, 6).map((r) => (
        <div key={r.id} className="stat-row">
          <span>
            {name(r.typeCode)} ·{' '}
            <span className="mono">
              {r.startDate} → {r.endDate}
            </span>
          </span>
          <span>
            <span className={`chip ${LEAVE_TONE[r.status]}`}>{t(`hr.leave.status.${r.status}` as TranslationKey)}</span>
            {r.status === 'pending' && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void cancelLeave(getAccessToken, r.id).then(load)}>
                {t('fin.withdraw')}
              </button>
            )}
          </span>
        </div>
      ))}
    </section>
  )
}
