import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { formatMinorUnits } from '../../domain/finance'
import { openApiPage } from '../../lib/printPage'
import {
  checkoutStatus,
  createSubscriptionInvoice,
  getSubscription,
  invoicePrintPath,
  payInvoiceByCard,
  quotePlan,
  type PlanChoice,
  type Quote,
  type Subscription,
  type SubscriptionInvoice,
} from '../../lib/subscriptionApi'

const PLANS = ['essentials', 'professional', 'enterprise'] as const

/**
 * SAMS 13.3 — the school's side of its subscription: where it stands, what
 * it uses against its plan's limits, choosing or changing a plan, and its
 * invoices, paid by card here or by bank transfer.
 */
export function SubscriptionSection() {
  const { t, n, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canBuy = can('settings.manage')
  const [params, setParams] = useSearchParams()
  const [sub, setSub] = useState<Subscription | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null)
  const [choice, setChoice] = useState<PlanChoice>({ plan: 'professional', term: 'year' })
  const [quote, setQuote] = useState<Quote | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await getSubscription(getAccessToken)
    if (r.kind !== 'ok') return setError(t('sub.loadError'))
    setSub(r.data)
    setChoice((c) => ({
      ...c,
      plan: (PLANS as readonly string[]).includes(r.data.plan) ? (r.data.plan as PlanChoice['plan']) : c.plan,
      term: r.data.billing?.term ?? c.term,
    }))
  }, [getAccessToken, t])

  useEffect(() => {
    void load()
  }, [load])

  // Back from the card page: say how it went.
  const checkout = params.get('checkout')
  useEffect(() => {
    if (!checkout) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async () => {
      const r = await checkoutStatus(getAccessToken, checkout)
      if (r.kind !== 'ok') return
      if (r.data.status === 'pending' && tries++ < 5) {
        timer = setTimeout(() => void ask(), 2000)
        return
      }
      setNotice({ text: t(`sub.checkout.${r.data.status}` as TranslationKey), warn: r.data.status !== 'paid' })
      setParams(
        (p) => {
          p.delete('checkout')
          return p
        },
        { replace: true },
      )
      void load()
    }
    void ask()
    return () => clearTimeout(timer)
  }, [checkout, getAccessToken, load, setParams, t])

  // The price of what's picked, as the server works it out.
  useEffect(() => {
    let cancelled = false
    void quotePlan(getAccessToken, choice).then((r) => !cancelled && setQuote(r.kind === 'ok' ? r.data : null))
    return () => {
      cancelled = true
    }
  }, [choice, getAccessToken])

  const money = (minor: number, currency: string) => `${formatMinorUnits(minor)} ${currency}`

  const payByCard = async (invoice: SubscriptionInvoice) => {
    setBusy(true)
    const r = await payInvoiceByCard(getAccessToken, invoice.id, lang === 'ar' ? 'ar' : 'en')
    setBusy(false)
    if (r.kind === 'ok') return void (window.location.href = r.data.redirectUrl)
    setNotice({ text: t('sub.error.pay'), warn: true })
  }

  const buy = async (thenPay: boolean) => {
    setBusy(true)
    setNotice(null)
    const r = await createSubscriptionInvoice(getAccessToken, choice)
    setBusy(false)
    if (r.kind !== 'ok') {
      const key = `sub.error.${r.error}` as TranslationKey
      return setNotice({ text: t(key) === key ? t('sub.error.generic') : t(key), warn: true })
    }
    if (thenPay) return payByCard(r.data)
    setNotice({ text: t('sub.invoiceMade', { number: r.data.number }), warn: false })
    void load()
  }

  if (error) return <p className="notice notice--warn">{error}</p>
  if (!sub) return <div className="skeleton" style={{ height: 180 }} />

  const smsAllowance = sub.limits.smsPerStudent === null ? null : sub.limits.smsPerStudent * sub.usage.students
  const open = sub.invoices.filter((i) => i.status === 'open')
  const planName = (key: string) => {
    const k = `plan.name.${key}` as TranslationKey
    return t(k) === k ? key : t(k)
  }

  return (
    <div className="stack">
      {notice && (
        <p className={`notice${notice.warn ? ' notice--warn' : ''}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="card">
        <h3 className="card__title">{t('sub.current')}</h3>
        <p>
          <strong>{planName(sub.plan)}</strong> ·{' '}
          <span className={`chip chip--${sub.state === 'active' ? 'ok' : 'warn'}`}>{t(`sub.state.${sub.state}` as TranslationKey)}</span>
        </p>
        <p className="card__hint">
          {sub.validUntil ? t(sub.plan === 'trial' ? 'sub.trialUntil' : 'sub.paidUntil', { date: sub.validUntil }) : t('sub.noEnd')}
          {sub.state === 'grace' && sub.graceEnds ? ` ${t('sub.graceHint', { date: sub.graceEnds })}` : ''}
          {sub.state === 'readOnly' && sub.readOnlyUntil ? ` ${t('sub.readOnlyHint', { date: sub.readOnlyUntil })}` : ''}
        </p>
        <div className="field-grid">
          <Usage label={t('sub.usage.students')} used={sub.usage.students} limit={sub.limits.students} n={n} />
          <Usage label={t('sub.usage.branches')} used={sub.usage.branches} limit={sub.limits.branches} n={n} />
          <Usage label={t('sub.usage.sms')} used={sub.usage.smsThisMonth} limit={smsAllowance} n={n} />
          <Usage label={t('sub.usage.staff')} used={sub.usage.staff} limit={null} n={n} />
        </div>
        <p className="card__hint">
          {t('sub.modules')}:{' '}
          {sub.modules.length ? sub.modules.map((m) => t(`plan.module.${m}` as TranslationKey)).join(' · ') : t('sub.coreOnly')}
        </p>
      </section>

      {canBuy && (sub.listed || sub.plan === 'trial') && (
        <section className="card">
          <h3 className="card__title">{t(sub.plan === 'trial' ? 'sub.choose' : 'sub.change')}</h3>
          <div className="field-grid">
            <label className="field">
              <span>{t('sub.plan')}</span>
              <select
                className="select"
                value={choice.plan}
                onChange={(e) => setChoice((c) => ({ ...c, plan: e.target.value as PlanChoice['plan'] }))}
              >
                {PLANS.map((p) => (
                  <option key={p} value={p}>
                    {planName(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('pricing.termLabel')}</span>
              <select
                className="select"
                value={choice.term}
                onChange={(e) => setChoice((c) => ({ ...c, term: e.target.value as 'year' | 'month' }))}
              >
                <option value="year">{t('pricing.term.year')}</option>
                <option value="month">{t('pricing.term.month')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('sub.students')}</span>
              <input
                className="input"
                inputMode="numeric"
                dir="ltr"
                placeholder={String(sub.billing?.students || sub.usage.students || '')}
                value={choice.students ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value.replace(/\D/g, ''))
                  setChoice((c) => ({ ...c, students: v > 0 ? v : undefined }))
                }}
              />
            </label>
          </div>
          {quote && (
            <p className="card__hint">
              {t('sub.quote', {
                students: n(quote.students),
                from: quote.periodStart,
                to: quote.periodEnd,
                total: money(quote.total, quote.currency),
              })}
              {quote.tax ? ` ${t('sub.quoteTax', { rate: String(quote.taxRate) })}` : ''}
            </p>
          )}
          <div className="inline-form">
            {sub.cardPayments && (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void buy(true)}>
                {t('sub.buyCard')}
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => void buy(false)}>
              {t('sub.buyTransfer')}
            </button>
          </div>
        </section>
      )}
      {!sub.listed && sub.plan !== 'trial' && <p className="card__hint">{t('sub.customPlan')}</p>}

      <section className="card">
        <h3 className="card__title">{t('sub.invoices')}</h3>
        {sub.invoices.length === 0 ? (
          <p className="card__hint">{t('sub.noInvoices')}</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sub.inv.number')}</th>
                  <th>{t('sub.inv.period')}</th>
                  <th>{t('sub.inv.total')}</th>
                  <th>{t('sub.inv.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sub.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td>
                      {planName(i.plan)} · {i.periodStart} – {i.periodEnd}
                    </td>
                    <td className="mono">{money(i.total, i.currency)}</td>
                    <td>
                      {i.status === 'open'
                        ? t(i.dueDate < new Date().toISOString().slice(0, 10) ? 'sub.inv.overdue' : 'sub.inv.due', { date: i.dueDate })
                        : t(`sub.inv.${i.status}` as TranslationKey)}
                    </td>
                    <td className="inline-form">
                      {i.status === 'open' && sub.cardPayments && canBuy && (
                        <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void payByCard(i)}>
                          {t('sub.payCard')}
                        </button>
                      )}
                      <button type="button" className="link-btn" onClick={() => void openApiPage(getAccessToken, invoicePrintPath(i.id))}>
                        {t('sub.print')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open.length > 0 && sub.bankDetails && (
          <>
            <h4>{t('sub.bank')}</h4>
            <pre className="card__hint" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
              {sub.bankDetails}
            </pre>
            <p className="card__hint">{t('sub.bankHint')}</p>
          </>
        )}
        {sub.salesEmail && (
          <p className="card__hint">
            {t('sub.contact')} <a href={`mailto:${sub.salesEmail}`}>{sub.salesEmail}</a>
          </p>
        )}
      </section>
    </div>
  )
}

function Usage({ label, used, limit, n }: { label: string; used: number; limit: number | null; n: (v: number) => string }) {
  const over = limit !== null && used >= limit
  return (
    <div className="field">
      <span>{label}</span>
      <strong style={over ? { color: 'var(--warn)' } : undefined}>{limit === null ? n(used) : `${n(used)} / ${n(limit)}`}</strong>
    </div>
  )
}
