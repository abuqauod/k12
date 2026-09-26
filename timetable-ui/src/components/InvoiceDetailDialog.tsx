import { useEffect, useState } from 'react'
import type { DiscountType, Invoice, Payment, Receipt } from '../domain/finance'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { listLookups, lookupLabel } from '../lib/settingsApi'
import type { LookupItem } from '../lib/settingsApi'
import {
  addInvoiceLineItem,
  confirmPayment,
  getInvoice,
  rejectPayment,
  listPayments,
  listReceipts,
  recordPayment,
  removeInvoiceLineItem,
  voidInvoice,
  voidPayment,
} from '../lib/financeApi'
import type { NewInvoiceLine, NewPayment } from '../lib/financeApi'
import type { TokenGetter } from '../lib/http'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { ApprovalCard } from './ApprovalCard'
import { ReasonDialog } from './ReasonDialog'
import { listApprovalTypes, listApprovals, requestApproval } from '../lib/approvalsApi'
import type { Approval } from '../lib/approvalsApi'
import { AdjustmentsSection, InstallmentsSection, RefundsSection } from './finance/InvoiceSections'

const DISCOUNT_TYPE = 'finance.lineDiscount'
/** Approval types raised against an invoice and shown on it. */
const INVOICE_APPROVAL_TYPES = [DISCOUNT_TYPE, 'finance.invoiceDiscount']

/** One invoice: its line items (add/remove, discount admin-gated), its
 * discounts and scholarships, installment plan, payment history
 * (record/confirm/void), refunds, and a printable receipt view. */
export function InvoiceDetailDialog({
  invoiceId,
  getAccessToken,
  onClose,
  onChanged,
}: {
  invoiceId: string
  getAccessToken: TokenGetter
  onClose: () => void
  onChanged: () => void
}) {
  const { t, lang } = useI18n()
  const { can } = useAuth()
  const canDiscount = can('finance.discount.approve')
  const canVoidPayment = can('finance.payment.void')
  const canVoidInvoice = can('finance.invoice.void')
  // Can edit lines but not grant a discount: request one instead (SAMS 1.10).
  const canRequestDiscount = !canDiscount && can('finance.invoice.lineItems')

  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [viewReceipt, setViewReceipt] = useState<Receipt | null>(null)

  const load = async () => {
    const [invoiceRes, paymentsRes, receiptsRes] = await Promise.all([
      getInvoice(getAccessToken, invoiceId),
      listPayments(getAccessToken, { invoiceId }),
      listReceipts(getAccessToken, { invoiceId }),
    ])
    if (invoiceRes.kind === 'ok') setInvoice(invoiceRes.data)
    if (paymentsRes.kind === 'ok') setPayments(paymentsRes.data)
    if (receiptsRes.kind === 'ok') setReceipts(receiptsRes.data)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId])

  // ------------------------------------------------- payment methods (1.11)
  // The settings list, including inactive codes so history still labels them.
  const [methods, setMethods] = useState<LookupItem[]>([])
  useEffect(() => {
    void listLookups(getAccessToken, 'paymentMethod', true).then((result) => {
      if (result.kind === 'ok') setMethods(result.data)
    })
  }, [getAccessToken])
  const methodLabel = (code: string) =>
    lookupLabel(methods, code, lang, t(`billing.method.${code}` as TranslationKey))

  // ------------------------------------------------------------- approvals
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [canDecideDiscount, setCanDecideDiscount] = useState(false)
  const loadApprovals = async () => {
    const [list, types] = await Promise.all([
      listApprovals(getAccessToken, { entity: 'invoice', entityId: invoiceId }),
      listApprovalTypes(getAccessToken),
    ])
    if (list.kind === 'ok') setApprovals(list.data.filter((a) => INVOICE_APPROVAL_TYPES.includes(a.type)))
    if (types.kind === 'ok') setCanDecideDiscount(types.data.some((x) => INVOICE_APPROVAL_TYPES.includes(x.type) && x.canDecide))
  }
  useEffect(() => {
    void loadApprovals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId])
  const pendingFor = (lineId: string) =>
    approvals.some((a) => a.status === 'pending' && a.payload.lineItemId === lineId)

  const [requestLine, setRequestLine] = useState<{ id: string; amount: number } | null>(null)
  const [requestType, setRequestType] = useState<DiscountType>('percent')
  const [requestValue, setRequestValue] = useState('')
  const [requestReason, setRequestReason] = useState('')
  const sendRequest = async () => {
    if (!requestLine) return
    const value = requestType === 'percent' ? Number(requestValue) : parseMinorUnits(requestValue)
    if (value === null || !Number.isInteger(value) || value <= 0 || (requestType === 'percent' && value > 100)) {
      setError(t('billing.error.generic'))
      return
    }
    const result = await requestApproval(getAccessToken, {
      type: DISCOUNT_TYPE,
      entityId: invoiceId,
      payload: { lineItemId: requestLine.id, discount: { type: requestType, value }, expectedAmount: requestLine.amount },
      comment: requestReason.trim() || null,
    })
    if (result.kind !== 'ok') {
      const known: Record<string, TranslationKey> = {
        ALREADY_PENDING: 'approvals.error.pending',
        DISCOUNT_OUT_OF_RANGE: 'approvals.error.range',
        STALE_REQUEST: 'approvals.error.stale',
        INVOICE_PAID: 'approvals.error.paid',
        LINE_ALREADY_DISCOUNTED: 'approvals.error.stale',
        BRANCH_FORBIDDEN: 'approvals.error.branch',
      }
      setError(t(known[result.error] ?? 'approvals.error.generic'))
      return
    }
    setRequestLine(null)
    setRequestValue('')
    setRequestReason('')
    void loadApprovals()
  }

  // -------------------------------------------------------------- line item
  const [lineLabel, setLineLabel] = useState('')
  const [lineAmount, setLineAmount] = useState('')
  const [discountType, setDiscountType] = useState<DiscountType>('amount')
  const [discountValue, setDiscountValue] = useState('')
  const [savingLine, setSavingLine] = useState(false)

  const addLine = async () => {
    const amount = parseMinorUnits(lineAmount)
    if (!lineLabel.trim() || amount === null) return
    let discount: NewInvoiceLine['discount'] = null
    if (discountValue.trim() && canDiscount) {
      if (discountType === 'percent') {
        // The server rejects a non-integer percent outright (z.number().int()) —
        // caught here too so a typo like "12.5" gets an inline message instead
        // of a generic save failure.
        const percent = Number(discountValue)
        if (!Number.isInteger(percent) || percent < 0) {
          setError(t('billing.error.generic'))
          return
        }
        discount = { type: 'percent', value: percent }
      } else {
        const value = parseMinorUnits(discountValue)
        if (value === null) {
          setError(t('billing.error.generic'))
          return
        }
        discount = { type: 'amount', value }
      }
    }
    setSavingLine(true)
    setError(null)
    const body: NewInvoiceLine = { label: lineLabel.trim(), labelAr: null, amount, discount }
    const res = await addInvoiceLineItem(getAccessToken, invoiceId, body)
    setSavingLine(false)
    if (res.kind === 'ok') {
      setLineLabel('')
      setLineAmount('')
      setDiscountValue('')
      setInvoice(res.data)
      onChanged()
    } else {
      setError(t(`billing.error.${res.error}` as TranslationKey) || t('billing.error.generic'))
    }
  }

  const removeLine = async (lineItemId: string) => {
    const res = await removeInvoiceLineItem(getAccessToken, invoiceId, lineItemId)
    if (res.kind === 'ok') {
      setInvoice(res.data)
      onChanged()
    }
  }

  // Voids ask why first (SAMS 1.12): the reason is required and audited.
  const [asking, setAsking] = useState<{ kind: 'invoice' } | { kind: 'payment'; id: string } | null>(null)
  const handleVoidInvoice = () => setAsking({ kind: 'invoice' })
  const confirmVoid = async (reason: string): Promise<string | null> => {
    if (!asking) return null
    if (asking.kind === 'invoice') {
      const res = await voidInvoice(getAccessToken, invoiceId, reason)
      if (res.kind !== 'ok') return t('billing.error.generic')
      setInvoice(res.data)
    } else {
      const res = await voidPayment(getAccessToken, asking.id, reason)
      if (res.kind !== 'ok') return t('billing.error.generic')
      await load()
    }
    setAsking(null)
    onChanged()
    return null
  }

  // ---------------------------------------------------------------- payment
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<NewPayment['method']>('cash')
  // The school may have deactivated the default; fall back to the first
  // active method once the list is known.
  const activeMethods = methods.filter((m) => m.active)
  if (activeMethods.length > 0 && !activeMethods.some((m) => m.code === method)) {
    setMethod(activeMethods[0].code)
  }
  const [reference, setReference] = useState('')
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [payerName, setPayerName] = useState('')
  const [awaiting, setAwaiting] = useState(false)
  const [recording, setRecording] = useState(false)
  const canConfirm = can('finance.payment.confirm')
  const decide = async (paymentId: string, confirm: boolean, reason?: string) => {
    const res = confirm ? await confirmPayment(getAccessToken, paymentId) : await rejectPayment(getAccessToken, paymentId, reason ?? '')
    if (res.kind !== 'ok') return t('billing.error.generic')
    await load()
    onChanged()
    return null
  }
  const [rejecting, setRejecting] = useState<string | null>(null)

  const submitPayment = async () => {
    const amountMinor = parseMinorUnits(amount)
    if (amountMinor === null || amountMinor <= 0 || !payerName.trim()) return
    setRecording(true)
    setError(null)
    const body: NewPayment = {
      amount: amountMinor,
      method,
      reference: reference.trim() || null,
      paidAt,
      payerName: payerName.trim(),
      notes: null,
      awaitingConfirmation: awaiting,
    }
    const res = await recordPayment(getAccessToken, invoiceId, body)
    setRecording(false)
    if (res.kind === 'ok') {
      setAmount('')
      setReference('')
      setPayerName('')
      setAwaiting(false)
      await load()
      onChanged()
    } else {
      setError(t(`billing.error.${res.error}` as TranslationKey) || t('billing.error.generic'))
    }
  }

  const handleVoidPayment = (paymentId: string) => setAsking({ kind: 'payment', id: paymentId })

  if (!invoice) {
    return (
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog__panel" style={{ maxWidth: 640 }}>
          <div className="dialog__body">
            <p className="card__hint">{t('parents.loading')}</p>
          </div>
        </div>
      </div>
    )
  }

  const isVoid = invoice.status === 'void'

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={invoice.invoiceNumber}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog__panel" style={{ maxWidth: 640 }}>
        <div className="dialog__head">
          <strong>{invoice.invoiceNumber}</strong>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {t('parents.close')}
          </button>
        </div>

        <div className="dialog__body" style={{ display: 'grid', gap: 18 }}>
          <div className="break-card__row" style={{ justifyContent: 'space-between' }}>
            <span className={`chip${isVoid ? '' : ' chip--on'}`}>
              {t(`billing.status.${invoice.status}` as TranslationKey)}
            </span>
            <b>{formatMinorUnits(invoice.total)}</b>
          </div>
          {!isVoid && invoice.paidTotal !== undefined && (
            <div className="money-strip">
              <span>
                {t('fin.col.paid')} <b className="mono">{formatMinorUnits(invoice.paidTotal)}</b>
              </span>
              <span>
                {t('fin.outstanding')} <b className="mono">{formatMinorUnits(invoice.outstanding ?? 0)}</b>
              </span>
              {(invoice.overdue ?? 0) > 0 && (
                <span className="money-strip__bad">
                  {t('fin.overdue')} <b className="mono">{formatMinorUnits(invoice.overdue ?? 0)}</b>
                </span>
              )}
              {invoice.dueDate && (
                <span>
                  {t('fin.col.due')} <b>{invoice.dueDate}</b>
                </span>
              )}
            </div>
          )}

          <section>
            <h3 className="card__subtitle" style={{ marginTop: 0 }}>{t('billing.lineItems')}</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('billing.col.label')}</th>
                  <th>{t('billing.col.amount')}</th>
                  <th>{t('billing.col.net')}</th>
                  {!isVoid && <th style={{ width: 30 }} />}
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((line) => (
                  <tr key={line.id}>
                    <td>{line.label}</td>
                    <td className="mono">{formatMinorUnits(line.amount)}</td>
                    <td className="mono">
                      {formatMinorUnits(line.netAmount)}
                      {pendingFor(line.id) ? (
                        <span className="chip chip--warn" style={{ marginInlineStart: 6 }}>
                          {t('billing.discountPending')}
                        </span>
                      ) : (
                        canRequestDiscount &&
                        !isVoid &&
                        invoice.status !== 'paid' &&
                        !line.discount && (
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost"
                            style={{ marginInlineStart: 6 }}
                            onClick={() => setRequestLine({ id: line.id, amount: line.amount })}
                          >
                            {t('billing.requestDiscount')}
                          </button>
                        )
                      )}
                    </td>
                    {!isVoid && (
                      <td>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => void removeLine(line.id)}
                          aria-label={`${t('billing.removeLine')} ${line.label}`}
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {requestLine && (
              <div className="discount-request">
                <select className="input input--sm" value={requestType} onChange={(e) => setRequestType(e.target.value as DiscountType)} aria-label={t('billing.discount')}>
                  <option value="percent">{t('billing.discount.percent')}</option>
                  <option value="amount">{t('billing.discount.amount')}</option>
                </select>
                <input className="input input--sm" style={{ maxWidth: 100 }} placeholder={t('billing.discount')} aria-label={t('billing.discount')} value={requestValue} onChange={(e) => setRequestValue(e.target.value)} />
                <input className="input input--sm" style={{ flex: 1, minWidth: 140 }} placeholder={t('billing.requestReason')} aria-label={t('billing.requestReason')} value={requestReason} onChange={(e) => setRequestReason(e.target.value)} />
                <button type="button" className="btn btn--sm btn--primary" onClick={() => void sendRequest()}>
                  {t('billing.requestSend')}
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRequestLine(null)}>
                  {t('docs.cancel')}
                </button>
              </div>
            )}
            {approvals.length > 0 && (
              <div className="approval-list" style={{ marginTop: 10 }}>
                <h4 className="card__subtitle" style={{ margin: 0 }}>{t('approvals.title')}</h4>
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    canDecide={canDecideDiscount}
                    onChanged={() => {
                      void loadApprovals()
                      void load()
                      onChanged()
                    }}
                  />
                ))}
              </div>
            )}
            {!isVoid && (
              <div className="break-card__row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <input className="input input--sm" style={{ minWidth: 140 }} placeholder={t('billing.col.label')} value={lineLabel} onChange={(e) => setLineLabel(e.target.value)} />
                <input className="input input--sm" style={{ maxWidth: 100 }} placeholder={t('billing.col.amount')} value={lineAmount} onChange={(e) => setLineAmount(e.target.value)} />
                {canDiscount && (
                  <>
                    <select className="input input--sm" value={discountType} onChange={(e) => setDiscountType(e.target.value as DiscountType)}>
                      <option value="amount">{t('billing.discount.amount')}</option>
                      <option value="percent">{t('billing.discount.percent')}</option>
                    </select>
                    <input className="input input--sm" style={{ maxWidth: 100 }} placeholder={t('billing.discount')} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
                  </>
                )}
                <button type="button" className="btn btn--sm" disabled={savingLine} onClick={() => void addLine()}>
                  {t('billing.addLine')}
                </button>
              </div>
            )}
          </section>

          <AdjustmentsSection
            invoice={invoice}
            onChanged={(inv) => {
              setInvoice(inv)
              void load()
              onChanged()
            }}
            onRequested={() => void loadApprovals()}
          />

          <InstallmentsSection
            invoice={invoice}
            onChanged={(inv) => {
              setInvoice(inv)
              onChanged()
            }}
          />

          <section>
            <h3 className="card__subtitle" style={{ marginTop: 0 }}>{t('billing.payments')}</h3>
            {payments.length === 0 ? (
              <p className="card__hint">{t('billing.payments.none')}</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('billing.col.date')}</th>
                    <th>{t('billing.col.amount')}</th>
                    <th>{t('billing.col.method')}</th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => {
                    // A receipt covering several invoices lists this payment in its split.
                    const receipt = receipts.find((r) => r.paymentId === payment.id || r.allocations.some((a) => a.paymentId === payment.id))
                    return (
                      <tr key={payment.id} style={payment.voidedAt || payment.confirmation === 'rejected' ? { opacity: 0.5 } : undefined}>
                        <td>{payment.paidAt}</td>
                        <td className="mono">{formatMinorUnits(payment.amount)}</td>
                        <td>
                          {methodLabel(payment.method)}
                          {payment.confirmation !== 'confirmed' && (
                            <span className={`chip ${payment.confirmation === 'pending' ? 'chip--warn' : 'chip--bad'}`} style={{ marginInlineStart: 6 }}>
                              {t(`fin.confirmation.${payment.confirmation}` as TranslationKey)}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            {canConfirm && payment.confirmation === 'pending' && !payment.voidedAt && (
                              <>
                                <button type="button" className="btn btn--sm" onClick={() => void decide(payment.id, true)}>
                                  {t('fin.confirm')}
                                </button>
                                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRejecting(payment.id)}>
                                  {t('fin.reject')}
                                </button>
                              </>
                            )}
                            {receipt && (
                              <button type="button" className="icon-btn" onClick={() => setViewReceipt(receipt)} aria-label={t('billing.receipt.view')}>
                                🧾
                              </button>
                            )}
                            {canVoidPayment && !payment.voidedAt && (
                              <button type="button" className="icon-btn" onClick={() => handleVoidPayment(payment.id)} aria-label={t('billing.payment.void')}>
                                ×
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {!isVoid && (
              <div className="break-card__row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <input className="input input--sm" style={{ maxWidth: 100 }} placeholder={t('billing.col.amount')} value={amount} onChange={(e) => setAmount(e.target.value)} />
                <select className="input input--sm" value={method} onChange={(e) => setMethod(e.target.value as NewPayment['method'])}>
                  {methods
                    .filter((m) => m.active)
                    .map((m) => (
                      <option key={m.code} value={m.code}>
                        {methodLabel(m.code)}
                      </option>
                    ))}
                </select>
                <input className="input input--sm" style={{ maxWidth: 140 }} placeholder={t('billing.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
                <input type="date" className="input input--sm" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
                <input className="input input--sm" style={{ minWidth: 120 }} placeholder={t('billing.payerName')} value={payerName} onChange={(e) => setPayerName(e.target.value)} />
                <label className="checkbox-inline">
                  <input type="checkbox" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} />
                  {t('fin.awaitingConfirmation')}
                </label>
                <button type="button" className="btn btn--sm btn--primary" disabled={recording} onClick={() => void submitPayment()}>
                  {t('billing.recordPayment')}
                </button>
              </div>
            )}
          </section>

          <RefundsSection invoice={invoice} methods={methods} methodLabel={methodLabel} onChanged={() => void load().then(onChanged)} />

          {error && <p className="login__error">{error}</p>}

          {canVoidInvoice && !isVoid && (
            <div className="page__actions">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => handleVoidInvoice()}>
                {t('billing.voidInvoice')}
              </button>
            </div>
          )}
        </div>
      </div>

      {viewReceipt && (
        <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && setViewReceipt(null)}>
          <div className="dialog__panel" style={{ maxWidth: 380 }}>
            <div className="dialog__head">
              <strong>{viewReceipt.receiptNumber}</strong>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setViewReceipt(null)}>
                {t('parents.close')}
              </button>
            </div>
            <div className="dialog__body" style={{ display: 'grid', gap: 6 }}>
              <div className="stat-row"><span>{t('billing.col.date')}</span><b>{viewReceipt.issueDate}</b></div>
              <div className="stat-row"><span>{t('billing.payerName')}</span><b>{viewReceipt.payerName}</b></div>
              <div className="stat-row"><span>{t('billing.col.method')}</span><b>{methodLabel(viewReceipt.method)}</b></div>
              {viewReceipt.allocations.length > 1 &&
                viewReceipt.allocations.map((a) => (
                  <div key={a.paymentId} className="stat-row">
                    <span className="mono">{a.invoiceNumber}</span>
                    <span className="mono">{formatMinorUnits(a.amount)}</span>
                  </div>
                ))}
              <div className="stat-row"><span>{t('billing.col.amount')}</span><b>{formatMinorUnits(viewReceipt.amount)}</b></div>
              <button type="button" className="btn btn--sm btn--primary" style={{ marginTop: 8 }} onClick={() => window.print()}>
                {t('billing.receipt.print')}
              </button>
            </div>
          </div>
        </div>
      )}
      {rejecting && (
        <ReasonDialog
          title={t('fin.reject')}
          confirmLabel={t('fin.reject')}
          onConfirm={async (reason) => {
            const err = await decide(rejecting, false, reason)
            if (!err) setRejecting(null)
            return err
          }}
          onClose={() => setRejecting(null)}
        />
      )}
      {asking && (
        <ReasonDialog
          title={t(asking.kind === 'invoice' ? 'billing.voidInvoice' : 'billing.payment.void')}
          confirmLabel={t(asking.kind === 'invoice' ? 'billing.voidInvoice' : 'billing.payment.void')}
          onConfirm={confirmVoid}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  )
}
