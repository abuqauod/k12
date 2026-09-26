import { useCallback, useEffect, useState } from 'react'
import { formatMinorUnits } from '../../domain/finance'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { checkOnlinePayment, listOnlinePayments, type OnlinePayment } from '../../lib/paymentsApi'

/** SAMS 11.1: families' card payments — what each attempt came to, and the
 * receipt it became. A pending one can be checked with the gateway now. */

const TONE: Record<OnlinePayment['status'], string> = { paid: 'chip--ok', pending: 'chip--on', failed: 'chip--bad', cancelled: '' }

export function OnlinePaymentsTab({ branchId }: { branchId: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<OnlinePayment[] | null>(null)

  const load = useCallback(async () => {
    const res = await listOnlinePayments(getAccessToken, { branchId: branchId || undefined, status: status || undefined })
    setRows(res.kind === 'ok' ? res.data.payments : [])
  }, [getAccessToken, branchId, status])
  useEffect(() => {
    void load()
  }, [load])

  const check = async (id: string) => {
    await checkOnlinePayment(getAccessToken, id)
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('fin.tab.online')}</h2>
        <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('billing.col.status')}>
          <option value="">{t('parents.filter.allStatuses')}</option>
          {(['paid', 'pending', 'failed', 'cancelled'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`online.status.${s}` as TranslationKey)}
            </option>
          ))}
        </select>
      </div>
      <p className="card__hint">{t('online.hint')}</p>
      {!rows ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('online.empty')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('online.col.when')}</th>
                <th>{t('online.col.student')}</th>
                <th className="num">{t('online.col.amount')}</th>
                <th>{t('online.col.gateway')}</th>
                <th>{t('billing.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {new Date(r.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td>{r.studentName}</td>
                  <td className="num mono">
                    {formatMinorUnits(r.amount)} {r.currency}
                  </td>
                  <td>
                    {t(`payments.provider.${r.provider}` as TranslationKey)}
                    {r.providerRef && <small className="card__hint mono"> · {r.providerRef}</small>}
                  </td>
                  <td>
                    <span className={`chip ${TONE[r.status]}`}>{t(`online.status.${r.status}` as TranslationKey)}</span>
                    {r.overpaid > 0 && (
                      <small className="card__hint"> {t('online.overpaid', { amount: formatMinorUnits(r.overpaid) })}</small>
                    )}
                    {r.refunded > 0 && (
                      <small className="card__hint"> {t('online.refunded', { amount: formatMinorUnits(r.refunded) })}</small>
                    )}
                    {r.status === 'failed' && r.message && <small className="card__hint"> {r.message}</small>}
                  </td>
                  <td>
                    {r.status === 'pending' && (
                      <button type="button" className="btn btn--sm" onClick={() => void check(r.id)}>
                        {t('online.check')}
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
