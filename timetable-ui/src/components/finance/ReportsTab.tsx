import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { FinanceSummary } from '../../domain/finance'
import { formatMinorUnits } from '../../domain/finance'
import { getFinanceSummary } from '../../lib/financeApi'
import { listLookups, lookupLabel } from '../../lib/settingsApi'
import type { LookupItem } from '../../lib/settingsApi'
import type { AcademicYear } from '../../lib/academicYearsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { financeError, usePaymentMethods } from './shared'

/**
 * SAMS 3.6: one summary for the branch and a date range — revenue,
 * collections, refunds, expenses and the net position for the range; aging
 * and overdue as of today. Every figure is computed by the server.
 */

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`
const today = () => new Date().toISOString().slice(0, 10)

export function ReportsTab({ branchId, year }: { branchId: string; year: AcademicYear | undefined }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const { label: methodLabel } = usePaymentMethods()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [data, setData] = useState<FinanceSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [categories, setCategories] = useState<LookupItem[]>([])

  useEffect(() => {
    void listLookups(getAccessToken, 'expenseCategory', true).then((res) => res.kind === 'ok' && setCategories(res.data))
  }, [getAccessToken])

  useEffect(() => {
    if (!from || !to || from > to) return
    let live = true
    setData(null)
    void getFinanceSummary(getAccessToken, { branchId: branchId || undefined, from, to }).then((res) => {
      if (!live) return
      if (res.kind === 'ok') {
        setData(res.data)
        setError(null)
      } else setError(financeError(t, res.error))
    })
    return () => {
      live = false
    }
  }, [getAccessToken, branchId, from, to, t])

  const m = formatMinorUnits
  const tile = (label: TranslationKey, value: number | undefined, tone = 'neutral', sub?: string) => (
    <div className={`stat-tile stat-tile--${tone} stat-tile--plain`}>
      <span className="stat-tile__label">{t(label)}</span>
      <b className="stat-tile__value">{value === undefined ? <span className="skeleton" /> : m(value)}</b>
      {sub && <span className="stat-tile__sub">{sub}</span>}
    </div>
  )
  const row = (label: string, value: number, strong = false) => (
    <div key={label} className="stat-row">
      <span>{label}</span>
      {strong ? <b className="mono">{m(value)}</b> : <span className="mono">{m(value)}</span>}
    </div>
  )

  return (
    <div className="report">
      <div className="panel">
        <div className="inline-form">
          <label className="field field--inline">
            <span>{t('fin.report.from')}</span>
            <input type="date" className="input input--sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field field--inline">
            <span>{t('fin.report.to')}</span>
            <input type="date" className="input input--sm" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setFrom(monthStart()), setTo(today()))}>
            {t('fin.report.thisMonth')}
          </button>
          {year && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setFrom(year.startDate), setTo(year.endDate))}>
              {year.name}
            </button>
          )}
          <span className="card__hint">{t('fin.report.agingAsOf', { date: data?.asOf ?? today() })}</span>
        </div>
      </div>
      {error && <p className="login__error">{error}</p>}

      <div className="tile-grid">
        {tile('fin.report.billed', data?.revenue.billed)}
        {tile('fin.report.collected', data?.collections.total, 'ok')}
        {tile('fin.report.out', data?.net.cashOut, 'warn')}
        {tile('fin.report.net', data?.net.net, (data?.net.net ?? 0) >= 0 ? 'ok' : 'bad')}
        {tile('fin.report.outstanding', data?.aging.total, 'neutral')}
        {tile(
          'fin.overdue',
          data?.overdue.total,
          (data?.overdue.total ?? 0) > 0 ? 'bad' : 'ok',
          data ? t('fin.report.invoicesN', { n: data.overdue.count }) : undefined,
        )}
      </div>

      {data && (
        <div className="card-row">
          <section className="card">
            <h2 className="card__title">{t('fin.report.revenue')}</h2>
            {row(t('fin.report.gross'), data.revenue.gross)}
            {row(t('fin.report.lineDiscounts'), -data.revenue.lineDiscounts)}
            {row(t('fin.report.discounts'), -data.revenue.discounts)}
            {row(t('fin.report.scholarships'), -data.revenue.scholarships)}
            {row(t('fin.report.billed'), data.revenue.billed, true)}
            <p className="card__hint">{t('fin.report.invoicesN', { n: data.revenue.invoices })}</p>
          </section>

          <section className="card">
            <h2 className="card__title">{t('fin.report.collections')}</h2>
            {data.collections.byMethod.map((x) => row(methodLabel(x.method), x.amount))}
            {row(t('fin.report.collected'), data.collections.total, true)}
            {data.collections.awaitingConfirmation > 0 && (
              <p className="card__hint">
                {t('fin.report.awaiting', {
                  amount: m(data.collections.awaitingConfirmation),
                  n: data.collections.awaitingConfirmationCount,
                })}
              </p>
            )}
          </section>

          <section className="card">
            <h2 className="card__title">{t('fin.report.moneyOut')}</h2>
            {row(t('fin.report.refundsPaid'), data.refunds.paid)}
            {data.expenses.byCategory.map((x) => row(lookupLabel(categories, x.categoryCode, lang, x.categoryCode), x.amount))}
            {row(t('fin.report.out'), data.net.cashOut, true)}
            <p className="card__hint">
              {t('fin.report.inProgress', {
                refunds: m(data.refunds.inProgress),
                approval: m(data.expenses.awaitingApproval),
                payment: m(data.expenses.awaitingPayment),
              })}
            </p>
          </section>

          <section className="card">
            <h2 className="card__title">{t('fin.report.aging')}</h2>
            {(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const).map((b) =>
              row(t(`fin.aging.${b}` as TranslationKey), data.aging[b]),
            )}
            {row(t('fin.report.outstanding'), data.aging.total, true)}
          </section>
        </div>
      )}

      {data && data.overdue.invoices.length > 0 && (
        <section className="card">
          <h2 className="card__title">{t('fin.report.overdueList')}</h2>
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>{t('fin.col.student')}</th>
                  <th>{t('fin.col.invoice')}</th>
                  <th>{t('fin.report.since')}</th>
                  <th>{t('fin.report.days')}</th>
                  <th>{t('fin.overdue')}</th>
                  <th>{t('fin.outstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {data.overdue.invoices.map((o) => (
                  <tr key={o.invoiceId}>
                    <td>
                      <Link to={`/students/${o.studentId}?tab=finance`}>{o.studentName || '—'}</Link>
                    </td>
                    <td>
                      <Link className="mono" to={`/finance?invoice=${o.invoiceId}`}>
                        {o.invoiceNumber}
                      </Link>
                    </td>
                    <td>{o.oldestDueDate}</td>
                    <td>{o.daysOverdue}</td>
                    <td className="mono">{m(o.overdue)}</td>
                    <td className="mono">{m(o.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
