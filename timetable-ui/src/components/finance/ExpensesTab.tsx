import { useCallback, useEffect, useState } from 'react'
import type { Expense, Vendor } from '../../domain/finance'
import { formatMinorUnits, parseMinorUnits } from '../../domain/finance'
import { cancelExpense, createExpense, createVendor, listExpenses, listVendors, payExpense, updateVendor } from '../../lib/financeApi'
import { listLookups, lookupLabel } from '../../lib/settingsApi'
import type { LookupItem } from '../../lib/settingsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { DocumentsPanel } from '../DocumentsPanel'
import { RECORD_TONE, financeError, usePaymentMethods } from './shared'

/**
 * SAMS 3.5: expenses for a branch — submit (with the receipt or vendor
 * invoice attached), approval by someone else on the Approvals page, then
 * paid. Vendors are kept alongside.
 */

const today = () => new Date().toISOString().slice(0, 10)
const STATUSES = ['pending', 'approved', 'paid', 'rejected', 'cancelled'] as const

export function ExpensesTab({ branchId }: { branchId: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken, can, user } = useAuth()
  const { active: payMethods, label: methodLabel } = usePaymentMethods()
  const canCreate = can('finance.expense.create')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [categories, setCategories] = useState<LookupItem[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // New expense
  const [adding, setAdding] = useState(false)
  const [category, setCategory] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [expenseDate, setExpenseDate] = useState(today())
  const [reference, setReference] = useState('')

  // Paying one
  const [paying, setPaying] = useState<Expense | null>(null)
  const [payMethod, setPayMethod] = useState('')
  const [paidAt, setPaidAt] = useState(today())
  const [payRef, setPayRef] = useState('')

  const load = useCallback(async () => {
    const res = await listExpenses(getAccessToken, { branchId: branchId || undefined, status: status || undefined })
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, branchId, status])
  const loadVendors = useCallback(async () => {
    const res = await listVendors(getAccessToken, true)
    if (res.kind === 'ok') setVendors(res.data)
  }, [getAccessToken])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadVendors()
    void listLookups(getAccessToken, 'expenseCategory', true).then((res) => res.kind === 'ok' && setCategories(res.data))
  }, [getAccessToken, loadVendors])

  const categoryLabel = (code: string) => lookupLabel(categories, code, lang, code)
  const activeCategories = categories.filter((c) => c.active)

  const submit = async () => {
    const minor = parseMinorUnits(amount)
    const code = category || activeCategories[0]?.code
    if (!branchId || !code || !description.trim() || minor === null || minor <= 0) return setError(t('fin.expense.invalid'))
    setError(null)
    const res = await createExpense(getAccessToken, {
      branchId,
      categoryCode: code,
      vendorId: vendorId || null,
      description: description.trim(),
      amount: minor,
      expenseDate,
      reference: reference.trim() || null,
    })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setAdding(false)
    setDescription('')
    setAmount('')
    setReference('')
    setOpenId(res.data.id)
    await load()
  }

  const pay = async () => {
    if (!paying) return
    const res = await payExpense(getAccessToken, paying.id, {
      paidAt,
      method: payMethod || payMethods[0]?.code || 'cash',
      reference: payRef.trim() || null,
    })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setPaying(null)
    setPayRef('')
    await load()
  }

  return (
    <div className="card-row card-row--wide-first">
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">{t('fin.expenses')}</h2>
          <select
            className="input input--sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label={t('billing.col.status')}
          >
            <option value="">{t('parents.filter.allStatuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`fin.status.${s}` as TranslationKey)}
              </option>
            ))}
          </select>
          {canCreate && branchId && !adding && (
            <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
              {t('fin.expense.new')}
            </button>
          )}
        </div>
        {!branchId && <p className="card__hint">{t('fin.expense.pickBranch')}</p>}
        {adding && (
          <div className="inline-form">
            <select
              className="input input--sm"
              value={category || activeCategories[0]?.code || ''}
              onChange={(e) => setCategory(e.target.value)}
              aria-label={t('fin.col.category')}
            >
              {activeCategories.map((c) => (
                <option key={c.code} value={c.code}>
                  {categoryLabel(c.code)}
                </option>
              ))}
            </select>
            <select
              className="input input--sm"
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              aria-label={t('fin.col.vendor')}
            >
              <option value="">{t('fin.expense.noVendor')}</option>
              {vendors
                .filter((v) => v.active)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
            <input
              className="input input--sm"
              style={{ flex: 1, minWidth: 180 }}
              placeholder={t('fin.col.description')}
              aria-label={t('fin.col.description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <input
              className="input input--sm"
              style={{ maxWidth: 110 }}
              placeholder={t('billing.col.amount')}
              aria-label={t('billing.col.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <input
              type="date"
              className="input input--sm"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              aria-label={t('billing.col.date')}
            />
            <input
              className="input input--sm"
              style={{ maxWidth: 140 }}
              placeholder={t('fin.expense.vendorRef')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
              {t('fin.expense.submit')}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              {t('docs.cancel')}
            </button>
          </div>
        )}
        {rows === null ? (
          <div className="skeleton" style={{ height: 40 }} />
        ) : rows.length === 0 ? (
          <div className="empty-state">{t('fin.expenses.none')}</div>
        ) : (
          <ul className="record-list">
            {rows.map((e) => (
              <li key={e.id} className="record-list__item">
                <div className="record-list__row">
                  <button
                    type="button"
                    className="record-list__main"
                    onClick={() => setOpenId(openId === e.id ? null : e.id)}
                    aria-expanded={openId === e.id}
                  >
                    <span className="mono">{e.expenseNumber}</span> · {e.expenseDate} · <b>{e.description}</b>
                    <span className="card__hint">
                      {' '}
                      — {categoryLabel(e.categoryCode)}
                      {e.vendorName && ` · ${e.vendorName}`}
                    </span>
                  </button>
                  <b className="mono">{formatMinorUnits(e.amount)}</b>
                  <span className={`chip ${RECORD_TONE[e.status] ?? ''}`}>{t(`fin.status.${e.status}` as TranslationKey)}</span>
                  {e.status === 'approved' && can('finance.payout') && (
                    <button type="button" className="btn btn--sm" onClick={() => setPaying(e)}>
                      {t('fin.markPaid')}
                    </button>
                  )}
                  {(e.status === 'pending' || e.status === 'approved') && e.requestedBy === user?.id && (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => void cancelExpense(getAccessToken, e.id).then(load)}
                    >
                      {t('fin.withdraw')}
                    </button>
                  )}
                </div>
                {e.status === 'pending' && <p className="card__hint">{t('fin.expense.pendingHint')}</p>}
                {e.status === 'paid' && e.method && (
                  <p className="card__hint">
                    {t('fin.paidOn', { date: e.paidAt ?? '', method: methodLabel(e.method) })}
                    {e.paymentReference && ` · ${e.paymentReference}`}
                  </p>
                )}
                {openId === e.id && <DocumentsPanel ownerType="expense" ownerId={e.id} />}
              </li>
            ))}
          </ul>
        )}
        {paying && (
          <div className="inline-form">
            <strong>
              {paying.expenseNumber} · {formatMinorUnits(paying.amount)}
            </strong>
            <select
              className="input input--sm"
              value={payMethod || payMethods[0]?.code || ''}
              onChange={(ev) => setPayMethod(ev.target.value)}
              aria-label={t('billing.col.method')}
            >
              {payMethods.map((m) => (
                <option key={m.code} value={m.code}>
                  {methodLabel(m.code)}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="input input--sm"
              value={paidAt}
              onChange={(ev) => setPaidAt(ev.target.value)}
              aria-label={t('billing.col.date')}
            />
            <input
              className="input input--sm"
              style={{ maxWidth: 150 }}
              placeholder={t('billing.reference')}
              value={payRef}
              onChange={(ev) => setPayRef(ev.target.value)}
            />
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void pay()}>
              {t('fin.markPaid')}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPaying(null)}>
              {t('docs.cancel')}
            </button>
          </div>
        )}
        {error && <p className="login__error">{error}</p>}
      </section>

      <VendorsCard vendors={vendors} canEdit={canCreate} onChanged={() => void loadVendors()} />
    </div>
  )
}

function VendorsCard({ vendors, canEdit, onChanged }: { vendors: Vendor[]; canEdit: boolean; onChanged: () => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [contactName, setContactName] = useState('')
  const [taxNumber, setTaxNumber] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    if (!name.trim()) return
    const res = await createVendor(getAccessToken, {
      name: name.trim(),
      phone: phone.trim() || null,
      contactName: contactName.trim() || null,
      taxNumber: taxNumber.trim() || null,
    })
    if (res.kind !== 'ok') return setError(financeError(t, res.error))
    setAdding(false)
    setName('')
    setPhone('')
    setContactName('')
    setTaxNumber('')
    setError(null)
    onChanged()
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('fin.vendors')}</h2>
        {canEdit && !adding && (
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            {t('fin.vendor.new')}
          </button>
        )}
      </div>
      {adding && (
        <div className="stack-form">
          <input
            className="input input--sm"
            placeholder={t('fin.vendor.name')}
            aria-label={t('fin.vendor.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input input--sm"
            placeholder={t('fin.vendor.contact')}
            aria-label={t('fin.vendor.contact')}
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
          <input
            className="input input--sm"
            placeholder={t('fin.vendor.phone')}
            aria-label={t('fin.vendor.phone')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <input
            className="input input--sm"
            placeholder={t('fin.vendor.tax')}
            aria-label={t('fin.vendor.tax')}
            value={taxNumber}
            onChange={(e) => setTaxNumber(e.target.value)}
          />
          <div className="page__actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              {t('docs.cancel')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
              {t('fin.add')}
            </button>
          </div>
        </div>
      )}
      {vendors.length === 0 && !adding && <p className="card__empty">{t('fin.vendors.none')}</p>}
      {vendors.map((v) => (
        <div key={v.id} className="stat-row" style={v.active ? undefined : { opacity: 0.55 }}>
          <span>
            <b>{v.name}</b>
            {(v.contactName || v.phone) && <span className="card__hint"> · {[v.contactName, v.phone].filter(Boolean).join(' · ')}</span>}
          </span>
          {canEdit && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void updateVendor(getAccessToken, v.id, { active: !v.active }).then(onChanged)}
            >
              {v.active ? t('billing.feeStructure.deactivate') : t('fin.reactivate')}
            </button>
          )}
        </div>
      ))}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}
