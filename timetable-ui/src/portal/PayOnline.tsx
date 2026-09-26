import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { portalPay, portalPayment, type OnlinePayment } from '../lib/paymentsApi'

/** SAMS 11.1: a family pays what is owed (or part of it) by card, on the
 * school's gateway page, and comes back here. */
export function PayOnline({ studentId, balance, currency }: { studentId: string; balance: number; currency: string }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [amount, setAmount] = useState(formatMinorUnits(balance))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pay = async () => {
    const minor = parseMinorUnits(amount)
    if (minor === null || minor <= 0 || minor > balance) {
      setError(t('portal.pay.error.amount', { max: formatMinorUnits(balance) }))
      return
    }
    setBusy(true)
    setError(null)
    const res = await portalPay(getAccessToken, studentId, minor === balance ? null : minor)
    if (res.kind === 'ok') {
      // Off to the gateway's page; it sends the browser back here.
      window.location.assign(res.data.redirectUrl)
      return
    }
    setBusy(false)
    const key = `portal.pay.error.${res.error}` as TranslationKey
    setError(t(key) === key ? t('portal.pay.error.generic') : t(key))
  }

  return (
    <section className="card portal-pay">
      <h3 className="card__title">{t('portal.pay.title')}</h3>
      <p className="card__hint">{t('portal.pay.hint')}</p>
      <div className="portal-pay__row">
        <label className="field">
          <span>{t('portal.pay.amount', { currency })}</span>
          <input className="input mono" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button type="button" className="btn btn--primary" onClick={() => void pay()} disabled={busy}>
          {busy ? t('portal.pay.redirecting') : t('portal.pay.button')}
        </button>
      </div>
      {error && (
        <p className="notice notice--warn" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** The outcome shown on coming back from the gateway (`?payment=<id>`). A
 * payment the gateway has not confirmed yet is asked about a few times. */
export function PaymentResult({ onSettled }: { onSettled: () => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [params] = useSearchParams()
  const id = params.get('payment')
  const [payment, setPayment] = useState<OnlinePayment | null>(null)

  useEffect(() => {
    if (!id) return
    let tries = 0
    let stopped = false
    const ask = async () => {
      const res = await portalPayment(getAccessToken, id)
      if (stopped || res.kind !== 'ok') return
      setPayment(res.data)
      if (res.data.status === 'paid') onSettled()
      else if (res.data.status === 'pending' && ++tries < 6) setTimeout(() => void ask(), 2500)
    }
    void ask()
    return () => {
      stopped = true
    }
  }, [id, getAccessToken, onSettled])

  if (!id || !payment) return null
  const amount = `${formatMinorUnits(payment.amount)} ${payment.currency}`
  const tone = payment.status === 'paid' ? 'notice' : 'notice notice--warn'
  return (
    <p className={tone} role="status">
      {t(`portal.pay.result.${payment.status}` as TranslationKey, { amount })}
    </p>
  )
}
