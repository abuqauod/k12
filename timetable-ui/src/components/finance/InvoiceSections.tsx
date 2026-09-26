import { useCallback, useEffect, useState } from 'react'
import type { DiscountTypeDef, Invoice, Refund } from '../../domain/finance'
import { formatMinorUnits, parseMinorUnits } from '../../domain/finance'
import {
  applyDiscount,
  cancelRefund,
  listDiscountTypes,
  listRefunds,
  payRefund,
  removeAdjustment,
  requestRefund,
  setInstallments,
} from '../../lib/financeApi'
import { requestApproval } from '../../lib/approvalsApi'
import type { LookupItem } from '../../lib/settingsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { ReasonDialog } from '../ReasonDialog'
import { INSTALLMENT_TONE, RECORD_TONE, financeError } from './shared'

/** Pieces of the invoice dialog added in SAMS 3.1–3.3. Each takes the
 * invoice as last read and reports changes back so the dialog reloads. */

const today = () => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------- 3.1 --

export function InstallmentsSection({ invoice, onChanged }: { invoice: Invoice; onChanged: (inv: Invoice) => void }) {
  const { t, n } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canEdit = can('finance.invoice.create') && invoice.status !== 'void'
  const [editing, setEditing] = useState(false)
  const [count, setCount] = useState('3')
  const [first, setFirst] = useState(invoice.dueDate ?? today())
  const [interval, setInterval] = useState('1')
  const [error, setError] = useState<string | null>(null)
  const plan = invoice.installments

  const save = async (body: Parameters<typeof setInstallments>[2]) => {
    setError(null)
    const res = await setInstallments(getAccessToken, invoice.id, body)
    if (res.kind !== 'ok') {
      setError(financeError(t, res.error))
      return
    }
    setEditing(false)
    onChanged(res.data)
  }

  if (plan.length === 0 && !canEdit) return null
  return (
    <section>
      <div className="card__head" style={{ marginBottom: 6 }}>
        <h3 className="card__subtitle" style={{ margin: 0 }}>
          {t('fin.installments')}
        </h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(true)}>
            {plan.length === 0 ? t('fin.installments.set') : t('fin.installments.redo')}
          </button>
        )}
      </div>
      {plan.length === 0 && !editing && <p className="card__hint">{t('fin.installments.none')}</p>}
      {!invoice.installmentsMatchTotal && <p className="login__error">{t('fin.installments.stale')}</p>}
      {plan.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('fin.col.due')}</th>
              <th>{t('billing.col.amount')}</th>
              <th>{t('fin.col.paid')}</th>
              <th>{t('billing.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {plan.map((p) => (
              <tr key={p.id}>
                <td>{p.dueDate}</td>
                <td className="mono">{formatMinorUnits(p.amount)}</td>
                <td className="mono">{p.paid === undefined ? '—' : formatMinorUnits(p.paid)}</td>
                <td>
                  {p.status && (
                    <span className={`chip ${INSTALLMENT_TONE[p.status] ?? ''}`}>{t(`fin.installment.${p.status}` as TranslationKey)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <div className="inline-form">
          <label className="field field--inline">
            <span>{t('fin.installments.count')}</span>
            <input
              className="input input--sm"
              type="number"
              min={2}
              max={24}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              style={{ width: 70 }}
            />
          </label>
          <label className="field field--inline">
            <span>{t('fin.installments.first')}</span>
            <input className="input input--sm" type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
          </label>
          <label className="field field--inline">
            <span>{t('fin.installments.every')}</span>
            <select className="input input--sm" value={interval} onChange={(e) => setInterval(e.target.value)}>
              {[1, 2, 3, 4, 6].map((m) => (
                <option key={m} value={m}>
                  {t('fin.installments.months', { n: n(m) })}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void save({ split: { count: Number(count), firstDueDate: first, intervalMonths: Number(interval) } })}
          >
            {t('fin.installments.split', { amount: formatMinorUnits(invoice.total) })}
          </button>
          {plan.length > 0 && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void save({ installments: [] })}>
              {t('fin.installments.clear')}
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(false)}>
            {t('docs.cancel')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}

// ---------------------------------------------------------------- 3.2 --

export function AdjustmentsSection({
  invoice,
  onChanged,
  onRequested,
}: {
  invoice: Invoice
  onChanged: (inv: Invoice) => void
  /** A discount was requested for approval (the dialog reloads its approvals). */
  onRequested: () => void
}) {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canApply = can('finance.discount.approve')
  const canRequest = !canApply && can('finance.invoice.lineItems')
  const [types, setTypes] = useState<DiscountTypeDef[]>([])
  const [pick, setPick] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isVoid = invoice.status === 'void'

  useEffect(() => {
    if (isVoid || (!canApply && !canRequest)) return
    void listDiscountTypes(getAccessToken).then((res) => res.kind === 'ok' && setTypes(res.data))
  }, [getAccessToken, canApply, canRequest, isVoid])

  const applied = new Set(invoice.adjustments.map((a) => a.refId))
  const available = types.filter((d) => !applied.has(d.id))
  const name = (d: DiscountTypeDef) => (lang === 'ar' && d.nameAr) || d.name
  const valueLabel = (type: string, value: number) => (type === 'percent' ? `${value}%` : formatMinorUnits(value))

  const apply = async () => {
    if (!pick) return
    setError(null)
    if (canApply) {
      const res = await applyDiscount(getAccessToken, invoice.id, pick)
      if (res.kind !== 'ok') return setError(financeError(t, res.error))
      onChanged(res.data)
    } else {
      const res = await requestApproval(getAccessToken, {
        type: 'finance.invoiceDiscount',
        entityId: invoice.id,
        payload: { discountTypeId: pick },
        comment: null,
      })
      if (res.kind !== 'ok') return setError(financeError(t, res.error))
      onRequested()
    }
    setPick('')
  }

  if (invoice.adjustments.length === 0 && (isVoid || (!canApply && !canRequest))) return null
  return (
    <section>
      <h3 className="card__subtitle" style={{ marginTop: 0 }}>
        {t('fin.adjustments')}
      </h3>
      <div className="stat-row">
        <span>{t('fin.subtotal')}</span>
        <b className="mono">{formatMinorUnits(invoice.subtotal)}</b>
      </div>
      {invoice.adjustments.map((a) => (
        <div key={a.id} className="stat-row">
          <span>
            <span className={`chip ${a.source === 'scholarship' ? 'chip--on' : ''}`} style={{ marginInlineEnd: 6 }}>
              {t(a.source === 'scholarship' ? 'fin.scholarship' : 'billing.discount')}
            </span>
            {a.label} · {valueLabel(a.type, a.value)}
          </span>
          <span>
            <b className="mono">−{formatMinorUnits(a.amount)}</b>
            {canApply && !isVoid && a.source === 'discount' && (
              <button type="button" className="icon-btn" onClick={() => setRemoving(a.id)} aria-label={t('fin.adjustments.remove')}>
                ×
              </button>
            )}
          </span>
        </div>
      ))}
      {!isVoid && available.length > 0 && (
        <div className="inline-form">
          <select className="input input--sm" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t('fin.adjustments.pick')}>
            <option value="">{t('fin.adjustments.pick')}</option>
            {available.map((d) => (
              <option key={d.id} value={d.id}>
                {name(d)} · {valueLabel(d.type, d.value)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm" disabled={!pick} onClick={() => void apply()}>
            {canApply ? t('fin.adjustments.apply') : t('billing.requestDiscount')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
      {removing && (
        <ReasonDialog
          title={t('fin.adjustments.remove')}
          confirmLabel={t('fin.adjustments.remove')}
          onClose={() => setRemoving(null)}
          onConfirm={async (reason) => {
            const res = await removeAdjustment(getAccessToken, invoice.id, removing, reason)
            if (res.kind !== 'ok') return financeError(t, res.error)
            setRemoving(null)
            onChanged(res.data)
            return null
          }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------- 3.3 --

export function RefundsSection({
  invoice,
  methods,
  methodLabel,
  onChanged,
}: {
  invoice: Invoice
  methods: LookupItem[]
  methodLabel: (code: string) => string
  onChanged: () => void
}) {
  const { t } = useI18n()
  const { getAccessToken, can, user } = useAuth()
  const [refunds, setRefunds] = useState<Refund[]>([])
  const [refundable, setRefundable] = useState(0)
  const [asking, setAsking] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [paying, setPaying] = useState<Refund | null>(null)
  const [payMethod, setPayMethod] = useState('')
  const [payDate, setPayDate] = useState(today())
  const [payRef, setPayRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listRefunds(getAccessToken, { invoiceId: invoice.id })
    if (res.kind === 'ok') {
      setRefunds(res.data.refunds)
      setRefundable(res.data.refundable ?? 0)
    }
  }, [getAccessToken, invoice.id])
  useEffect(() => {
    void load()
  }, [load, invoice.updatedAt])

  const active = methods.filter((m) => m.active)
  const submit = async () => {
    const minor = parseMinorUnits(amount)
    if (minor === null || minor <= 0 || reason.trim().length < 3) return setError(t('fin.refund.invalid'))
    setError(null)
    const res = await requestRefund(getAccessToken, invoice.id, { amount: minor, reason: reason.trim() })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setAsking(false)
    setAmount('')
    setReason('')
    setNotice(t('fin.refund.requested', { number: res.data.refundNumber }))
    await load()
  }
  const pay = async () => {
    if (!paying) return
    const res = await payRefund(getAccessToken, paying.id, {
      paidAt: payDate,
      method: payMethod || active[0]?.code || 'cash',
      reference: payRef.trim() || null,
    })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setPaying(null)
    setPayRef('')
    await load()
    onChanged()
  }
  const cancel = async (r: Refund) => {
    const res = await cancelRefund(getAccessToken, r.id)
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    await load()
  }

  const canRequest = can('finance.refund.request')
  if (refunds.length === 0 && (!canRequest || refundable <= 0)) return null
  return (
    <section>
      <div className="card__head" style={{ marginBottom: 6 }}>
        <h3 className="card__subtitle" style={{ margin: 0 }}>
          {t('fin.refunds')}
        </h3>
        {canRequest && refundable > 0 && !asking && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAsking(true)}>
            {t('fin.refund.request')}
          </button>
        )}
      </div>
      {refunds.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('billing.col.number')}</th>
              <th>{t('billing.col.amount')}</th>
              <th>{t('billing.col.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {refunds.map((r) => (
              <tr key={r.id}>
                <td className="mono" title={r.reason}>
                  {r.refundNumber}
                </td>
                <td className="mono">{formatMinorUnits(r.amount)}</td>
                <td>
                  <span className={`chip ${RECORD_TONE[r.status] ?? ''}`}>{t(`fin.status.${r.status}` as TranslationKey)}</span>
                  {r.status === 'paid' && r.method && (
                    <span className="card__hint">
                      {' '}
                      · {methodLabel(r.method)} · {r.paidAt}
                    </span>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    {r.status === 'approved' && can('finance.payout') && (
                      <button type="button" className="btn btn--sm" onClick={() => setPaying(r)}>
                        {t('fin.payOut')}
                      </button>
                    )}
                    {(r.status === 'pending' || r.status === 'approved') && r.requestedBy === user?.id && (
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void cancel(r)}>
                        {t('fin.withdraw')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {refunds.some((r) => r.status === 'pending') && <p className="card__hint">{t('fin.refund.pendingHint')}</p>}
      {asking && (
        <div className="inline-form">
          <input
            className="input input--sm"
            style={{ maxWidth: 110 }}
            placeholder={t('billing.col.amount')}
            aria-label={t('billing.col.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className="input input--sm"
            style={{ flex: 1, minWidth: 160 }}
            placeholder={t('billing.requestReason')}
            aria-label={t('billing.requestReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
            {t('billing.requestSend')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAsking(false)}>
            {t('docs.cancel')}
          </button>
          <span className="card__hint">{t('fin.refund.max', { amount: formatMinorUnits(refundable) })}</span>
        </div>
      )}
      {paying && (
        <div className="inline-form">
          <strong>{paying.refundNumber}</strong>
          <select
            className="input input--sm"
            value={payMethod || active[0]?.code || ''}
            onChange={(e) => setPayMethod(e.target.value)}
            aria-label={t('billing.col.method')}
          >
            {active.map((m) => (
              <option key={m.code} value={m.code}>
                {methodLabel(m.code)}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="input input--sm"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
            aria-label={t('billing.col.date')}
          />
          <input
            className="input input--sm"
            style={{ maxWidth: 140 }}
            placeholder={t('billing.reference')}
            value={payRef}
            onChange={(e) => setPayRef(e.target.value)}
          />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void pay()}>
            {t('fin.payOut')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPaying(null)}>
            {t('docs.cancel')}
          </button>
        </div>
      )}
      {notice && <p className="card__hint">{notice}</p>}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}
