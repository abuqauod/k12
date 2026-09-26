import { useCallback, useEffect, useState } from 'react'
import type { DiscountType, DiscountTypeDef, Payment, Refund } from '../../domain/finance'
import { formatMinorUnits, parseMinorUnits } from '../../domain/finance'
import {
  confirmPayment,
  createDiscountType,
  listDiscountTypes,
  listPendingPayments,
  listRefunds,
  payRefund,
  rejectPayment,
  updateDiscountType,
} from '../../lib/financeApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { ReasonDialog } from '../ReasonDialog'
import { RECORD_TONE, financeError, usePaymentMethods } from './shared'

/** Finance page tabs that are work queues (SAMS 3.3, 3.4) and the discount
 * price list (3.2). */

const today = () => new Date().toISOString().slice(0, 10)

// ------------------------------------------------------ confirmations --

export function ConfirmationsTab({ branchId, onOpenInvoice }: { branchId: string; onOpenInvoice: (id: string) => void }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { label } = usePaymentMethods()
  const [rows, setRows] = useState<Payment[] | null>(null)
  const [rejecting, setRejecting] = useState<Payment | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listPendingPayments(getAccessToken, branchId || undefined)
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, branchId])
  useEffect(() => {
    void load()
  }, [load])

  const confirm = async (p: Payment) => {
    const res = await confirmPayment(getAccessToken, p.id)
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    await load()
  }
  const canConfirm = can('finance.payment.confirm')

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('fin.tab.confirmations')}</h2>
      </div>
      <p className="card__hint">{t('fin.confirmations.hint')}</p>
      {rows === null ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('fin.confirmations.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th>{t('billing.col.date')}</th>
                <th>{t('fin.col.invoice')}</th>
                <th>{t('billing.payerName')}</th>
                <th>{t('billing.col.method')}</th>
                <th>{t('billing.col.amount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{p.paidAt}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm mono"
                      style={{ padding: 0 }}
                      onClick={() => onOpenInvoice(p.invoiceId)}
                    >
                      {p.invoiceNumber ?? '—'}
                    </button>
                  </td>
                  <td>{p.payerName}</td>
                  <td>
                    {label(p.method)}
                    {p.reference && <span className="card__hint"> · {p.reference}</span>}
                  </td>
                  <td className="mono">{formatMinorUnits(p.amount)}</td>
                  <td>
                    {canConfirm && (
                      <div className="row-actions">
                        <button type="button" className="btn btn--sm" onClick={() => void confirm(p)}>
                          {t('fin.confirm')}
                        </button>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRejecting(p)}>
                          {t('fin.reject')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
      {rejecting && (
        <ReasonDialog
          title={t('fin.reject')}
          confirmLabel={t('fin.reject')}
          onClose={() => setRejecting(null)}
          onConfirm={async (reason) => {
            const res = await rejectPayment(getAccessToken, rejecting.id, reason)
            if (res.kind !== 'ok') return financeError(t, res.error)
            setRejecting(null)
            await load()
            return null
          }}
        />
      )}
    </section>
  )
}

// ------------------------------------------------------------ refunds --

const REFUND_FILTERS = ['approved', 'pending', 'paid', 'rejected', 'cancelled'] as const

export function RefundsTab({ branchId, onOpenInvoice }: { branchId: string; onOpenInvoice: (id: string) => void }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { active, label } = usePaymentMethods()
  const [status, setStatus] = useState<string>('approved')
  const [rows, setRows] = useState<Refund[] | null>(null)
  const [paying, setPaying] = useState<Refund | null>(null)
  const [method, setMethod] = useState('')
  const [paidAt, setPaidAt] = useState(today())
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listRefunds(getAccessToken, { branchId: branchId || undefined, status: status || undefined })
    setRows(res.kind === 'ok' ? res.data.refunds : [])
  }, [getAccessToken, branchId, status])
  useEffect(() => {
    void load()
  }, [load])

  const pay = async () => {
    if (!paying) return
    const res = await payRefund(getAccessToken, paying.id, {
      paidAt,
      method: method || active[0]?.code || 'cash',
      reference: reference.trim() || null,
    })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setPaying(null)
    setReference('')
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('fin.refunds')}</h2>
        <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('billing.col.status')}>
          <option value="">{t('parents.filter.allStatuses')}</option>
          {REFUND_FILTERS.map((s) => (
            <option key={s} value={s}>
              {t(`fin.status.${s}` as TranslationKey)}
            </option>
          ))}
        </select>
      </div>
      <p className="card__hint">{t('fin.refunds.hint')}</p>
      {rows === null ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('fin.refunds.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th>{t('billing.col.number')}</th>
                <th>{t('fin.col.invoice')}</th>
                <th>{t('billing.requestReason')}</th>
                <th>{t('billing.col.amount')}</th>
                <th>{t('billing.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.refundNumber}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm mono"
                      style={{ padding: 0 }}
                      onClick={() => onOpenInvoice(r.invoiceId)}
                    >
                      {r.invoiceNumber ?? '—'}
                    </button>
                  </td>
                  <td>{r.reason}</td>
                  <td className="mono">{formatMinorUnits(r.amount)}</td>
                  <td>
                    <span className={`chip ${RECORD_TONE[r.status] ?? ''}`}>{t(`fin.status.${r.status}` as TranslationKey)}</span>
                    {r.status === 'paid' && r.method && (
                      <span className="card__hint">
                        {' '}
                        {label(r.method)} · {r.paidAt}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.status === 'approved' && can('finance.payout') && (
                      <button type="button" className="btn btn--sm" onClick={() => setPaying(r)}>
                        {t('fin.payOut')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paying && (
        <div className="inline-form">
          <strong>
            {paying.refundNumber} · {formatMinorUnits(paying.amount)}
          </strong>
          <select
            className="input input--sm"
            value={method || active[0]?.code || ''}
            onChange={(e) => setMethod(e.target.value)}
            aria-label={t('billing.col.method')}
          >
            {active.map((m) => (
              <option key={m.code} value={m.code}>
                {label(m.code)}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="input input--sm"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            aria-label={t('billing.col.date')}
          />
          <input
            className="input input--sm"
            style={{ maxWidth: 150 }}
            placeholder={t('billing.reference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void pay()}>
            {t('fin.payOut')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPaying(null)}>
            {t('approvals.cancel')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}

// ------------------------------------------------------ discount types --

export function DiscountTypesCard() {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canManage = can('finance.feeStructure.manage')
  const [rows, setRows] = useState<DiscountTypeDef[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [nameAr, setNameAr] = useState('')
  const [type, setType] = useState<DiscountType>('percent')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listDiscountTypes(getAccessToken, canManage)
    if (res.kind === 'ok') setRows(res.data)
  }, [getAccessToken, canManage])
  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    const v = type === 'percent' ? Number(value) : parseMinorUnits(value)
    if (!name.trim() || v === null || !Number.isInteger(v) || v <= 0 || (type === 'percent' && v > 100)) {
      return setError(t('fin.scholarship.invalid'))
    }
    const res = await createDiscountType(getAccessToken, { name: name.trim(), nameAr: nameAr.trim() || null, type, value: v })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setAdding(false)
    setName('')
    setNameAr('')
    setValue('')
    setError(null)
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('fin.discountTypes')}</h2>
        {canManage && !adding && (
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            {t('fin.discountTypes.new')}
          </button>
        )}
      </div>
      {rows.length === 0 && !adding && <p className="card__empty">{t('fin.discountTypes.none')}</p>}
      {rows.map((d) => (
        <div key={d.id} className="stat-row" style={d.active ? undefined : { opacity: 0.55 }}>
          <span>{(lang === 'ar' && d.nameAr) || d.name}</span>
          <span>
            <b className="mono">{d.type === 'percent' ? `${d.value}%` : formatMinorUnits(d.value)}</b>
            {canManage && (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void updateDiscountType(getAccessToken, d.id, { active: !d.active }).then(load)}
              >
                {d.active ? t('billing.feeStructure.deactivate') : t('fin.reactivate')}
              </button>
            )}
          </span>
        </div>
      ))}
      {adding && (
        <div className="inline-form">
          <input
            className="input input--sm"
            placeholder={t('fin.scholarship.name')}
            aria-label={t('fin.scholarship.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input input--sm"
            dir="rtl"
            placeholder={t('fin.nameAr')}
            aria-label={t('fin.nameAr')}
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
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
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
            {t('fin.add')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
            {t('approvals.cancel')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}
