import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { portalWallet, portalWalletControls, portalWalletTopup, type PortalWallet as Wallet } from '../lib/canteenApi'
import { Statement } from '../pages/CanteenPage'
import { PaymentResult } from './PayOnline'

/** SAMS 11.4: a child's canteen wallet — balance, statement, an online
 * top-up, and the family's limits (a daily cap, categories not allowed). */
export function PortalWallet({ id }: { id: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [w, setW] = useState<Wallet | null>(null)
  const [amount, setAmount] = useState('10.00')
  const [limit, setLimit] = useState('')
  const [blocked, setBlocked] = useState<string[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const r = await portalWallet(getAccessToken, id)
    if (r.kind !== 'ok') return
    setW(r.data)
    setLimit(r.data.dailyLimit === null ? '' : formatMinorUnits(r.data.dailyLimit))
    setBlocked(r.data.blockedCategories)
  }, [getAccessToken, id])
  useEffect(() => {
    void load()
  }, [load])

  if (!w) return <div className="skeleton" style={{ height: 120 }} />

  const topup = async () => {
    const minor = parseMinorUnits(amount)
    if (minor === null || minor < w.topupMin || minor > w.topupMax) {
      return setMsg({
        ok: false,
        text: t('portal.wallet.amountRange', { min: formatMinorUnits(w.topupMin), max: formatMinorUnits(w.topupMax) }),
      })
    }
    const r = await portalWalletTopup(getAccessToken, id, minor)
    if (r.kind === 'ok') return window.location.assign(r.data.redirectUrl)
    const key = `portal.pay.error.${r.error}` as TranslationKey
    setMsg({ ok: false, text: t(key) === key ? t('portal.pay.error.generic') : t(key) })
  }
  const saveControls = async () => {
    const minor = limit.trim() === '' ? null : parseMinorUnits(limit)
    if (limit.trim() !== '' && minor === null) return
    const r = await portalWalletControls(getAccessToken, id, { dailyLimit: minor, blockedCategories: blocked })
    setMsg(r.kind === 'ok' ? { ok: true, text: t('portal.wallet.saved') } : { ok: false, text: t('portal.pay.error.generic') })
    if (r.kind === 'ok') void load()
  }

  return (
    <>
      <PaymentResult onSettled={load} />
      <section className="card portal-balance">
        <small>{t('portal.wallet.balance')}</small>
        <b className="mono">
          {formatMinorUnits(w.balance)} <small>{w.currency}</small>
        </b>
      </section>
      {w.canTopUp && (
        <section className="card portal-pay">
          <h3 className="card__title">{t('portal.wallet.topup')}</h3>
          <div className="portal-pay__row">
            <label className="field">
              <span>{t('portal.pay.amount', { currency: w.currency })}</span>
              <input className="input mono" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => void topup()}>
              {t('portal.pay.button')}
            </button>
          </div>
        </section>
      )}
      {w.canControl && (
        <section className="card">
          <h3 className="card__title">{t('portal.wallet.controls')}</h3>
          <p className="card__hint">{t('portal.wallet.controlsHint', { spent: formatMinorUnits(w.spentToday) })}</p>
          <label className="field">
            <span>{t('portal.wallet.dailyLimit')}</span>
            <input
              className="input mono"
              inputMode="decimal"
              dir="ltr"
              placeholder={t('portal.wallet.noLimit')}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
          <p className="card__hint">{t('portal.wallet.blocked')}</p>
          <div className="chips-select">
            {w.categories.map((c) => (
              <label key={c.code} className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={blocked.includes(c.code)}
                  onChange={(e) => setBlocked((b) => (e.target.checked ? [...b, c.code] : b.filter((x) => x !== c.code)))}
                />
                <span>{(lang === 'ar' && c.labelAr) || c.label}</span>
              </label>
            ))}
          </div>
          <button type="button" className="btn" onClick={() => void saveControls()}>
            {t('portal.wallet.save')}
          </button>
        </section>
      )}
      {msg && <p className={msg.ok ? 'notice' : 'notice notice--warn'}>{msg.text}</p>}
      <section className="card">
        <h3 className="card__title">{t('portal.wallet.statement')}</h3>
        <Statement rows={w.transactions} />
      </section>
    </>
  )
}
