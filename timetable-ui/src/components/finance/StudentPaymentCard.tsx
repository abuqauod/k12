import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Receipt } from '../../domain/finance'
import { formatMinorUnits, parseMinorUnits } from '../../domain/finance'
import { listOpenInvoices, recordStudentPayment } from '../../lib/financeApi'
import type { OpenInvoice } from '../../lib/financeApi'
import { listLookups, lookupLabel } from '../../lib/settingsApi'
import type { LookupItem } from '../../lib/settingsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { financeError } from './shared'

/**
 * SAMS 3.4: take one payment for a student and spread it over their open
 * invoices — oldest due first by default, each part editable. The server
 * re-checks the split; one receipt covers the whole amount.
 */
export function StudentPaymentCard({ studentId, onPaid }: { studentId: string; onPaid: () => void }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [open, setOpen] = useState<OpenInvoice[] | null>(null)
  const [methods, setMethods] = useState<LookupItem[]>([])
  const [amount, setAmount] = useState('')
  const [parts, setParts] = useState<Record<string, string>>({})
  const [edited, setEdited] = useState(false)
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [payerName, setPayerName] = useState('')
  const [awaiting, setAwaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null | 'pending'>(null)

  const load = useCallback(async () => {
    const res = await listOpenInvoices(getAccessToken, studentId)
    if (res.kind === 'ok') setOpen(res.data)
  }, [getAccessToken, studentId])
  useEffect(() => {
    void load()
    void listLookups(getAccessToken, 'paymentMethod').then((res) => {
      if (res.kind === 'ok') setMethods(res.data.filter((m) => m.active))
    })
  }, [load, getAccessToken])

  const total = open?.reduce((s, o) => s + o.outstanding, 0) ?? 0
  const amountMinor = parseMinorUnits(amount) ?? 0

  // Oldest due first, as the server would do it.
  const suggested = useMemo(() => {
    let left = amountMinor
    const out: Record<string, number> = {}
    for (const o of open ?? []) {
      const part = Math.max(0, Math.min(left, o.outstanding))
      out[o.id] = part
      left -= part
    }
    return out
  }, [open, amountMinor])
  const partOf = (id: string) => (edited ? (parseMinorUnits(parts[id] ?? '') ?? 0) : (suggested[id] ?? 0))
  const splitSum = (open ?? []).reduce((s, o) => s + partOf(o.id), 0)

  const submit = async () => {
    if (amountMinor <= 0 || !payerName.trim()) return setError(t('fin.pay.invalid'))
    if (edited && splitSum !== amountMinor) return setError(t('fin.pay.splitMismatch'))
    setBusy(true)
    setError(null)
    const res = await recordStudentPayment(getAccessToken, studentId, {
      amount: amountMinor,
      method: method || methods[0]?.code || 'cash',
      reference: reference.trim() || null,
      paidAt,
      payerName: payerName.trim(),
      notes: null,
      awaitingConfirmation: awaiting,
      ...(edited ? { allocations: (open ?? []).map((o) => ({ invoiceId: o.id, amount: partOf(o.id) })).filter((a) => a.amount > 0) } : {}),
    })
    setBusy(false)
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setReceipt(res.data.receipt ?? 'pending')
    setAmount('')
    setParts({})
    setEdited(false)
    setReference('')
    setAwaiting(false)
    await load()
    onPaid()
  }

  if (open === null) return null
  return (
    <section className="card profile-card profile-card--full">
      <div className="card__head">
        <h2 className="card__title">{t('fin.pay.title')}</h2>
        <span className="card__hint">{t('fin.pay.outstanding', { amount: formatMinorUnits(total) })}</span>
      </div>
      {open.length === 0 ? (
        <div className="empty-state">{t('fin.pay.nothing')}</div>
      ) : (
        <>
          <div className="inline-form">
            <input
              className="input input--sm"
              style={{ maxWidth: 120 }}
              placeholder={t('billing.col.amount')}
              aria-label={t('billing.col.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAmount(formatMinorUnits(total))}>
              {t('fin.pay.all')}
            </button>
            <select
              className="input input--sm"
              value={method || methods[0]?.code || ''}
              onChange={(e) => setMethod(e.target.value)}
              aria-label={t('billing.col.method')}
            >
              {methods.map((m) => (
                <option key={m.code} value={m.code}>
                  {lookupLabel(methods, m.code, lang, t(`billing.method.${m.code}` as TranslationKey))}
                </option>
              ))}
            </select>
            <input
              className="input input--sm"
              style={{ maxWidth: 140 }}
              placeholder={t('billing.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <input
              type="date"
              className="input input--sm"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              aria-label={t('billing.col.date')}
            />
            <input
              className="input input--sm"
              style={{ minWidth: 140 }}
              placeholder={t('billing.payerName')}
              value={payerName}
              onChange={(e) => setPayerName(e.target.value)}
            />
            <label className="checkbox-inline">
              <input type="checkbox" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} />
              {t('fin.awaitingConfirmation')}
            </label>
          </div>
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 420 }}>
              <thead>
                <tr>
                  <th>{t('billing.col.number')}</th>
                  <th>{t('fin.col.due')}</th>
                  <th>{t('fin.outstanding')}</th>
                  <th>{t('fin.pay.part')}</th>
                </tr>
              </thead>
              <tbody>
                {open.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.invoiceNumber}</td>
                    <td>{o.installments.find((p) => p.status !== 'paid')?.dueDate ?? o.dueDate ?? '—'}</td>
                    <td className="mono">{formatMinorUnits(o.outstanding)}</td>
                    <td>
                      <input
                        className="input input--sm mono"
                        style={{ maxWidth: 110 }}
                        aria-label={`${t('fin.pay.part')} ${o.invoiceNumber}`}
                        value={edited ? (parts[o.id] ?? '') : formatMinorUnits(suggested[o.id] ?? 0)}
                        onChange={(e) => {
                          if (!edited) {
                            setParts(Object.fromEntries(open.map((x) => [x.id, formatMinorUnits(suggested[x.id] ?? 0)])))
                            setEdited(true)
                          }
                          setParts((p) => ({ ...p, [o.id]: e.target.value }))
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="page__actions">
            {edited && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEdited(false)}>
                {t('fin.pay.oldestFirst')}
              </button>
            )}
            <span className="card__hint" style={{ flex: 1 }}>
              {edited && splitSum !== amountMinor ? t('fin.pay.splitMismatch') : t('fin.pay.hint')}
            </span>
            <button type="button" className="btn btn--sm btn--primary" disabled={busy || amountMinor <= 0} onClick={() => void submit()}>
              {t('billing.recordPayment')}
            </button>
          </div>
        </>
      )}
      {error && <p className="login__error">{error}</p>}
      {receipt && (
        <p className="card__hint">
          {receipt === 'pending'
            ? t('fin.pay.pendingDone')
            : t('fin.pay.done', { number: receipt.receiptNumber, amount: formatMinorUnits(receipt.amount) })}
        </p>
      )}
    </section>
  )
}
