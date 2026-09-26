import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchPriceList, type PlanCurrency, type PriceList, type PublicPlan } from '../lib/authApi'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { BrandLockup } from '../components/BrandMark'
import { LanguageToggle } from '../components/LanguageToggle'

/** A guess at the visitor's currency from their language/region. */
function guessCurrency(): PlanCurrency {
  const locale = (typeof navigator !== 'undefined' && navigator.language) || ''
  if (/-JO$/i.test(locale)) return 'JOD'
  if (/-SA$/i.test(locale)) return 'SAR'
  if (/-AE$/i.test(locale)) return 'AED'
  return locale.startsWith('ar') ? 'JOD' : 'USD'
}

/**
 * SAMS 13.5 — the public price list: per active student per year, with a
 * yearly minimum, in the four currencies sold; a calculator for a school's
 * size; what each plan includes. Everything comes from GET /public/plans,
 * the same catalog the server enforces.
 */
export function PricingPage() {
  const { t, lang } = useI18n()
  const [list, setList] = useState<PriceList | null>(null)
  const [failed, setFailed] = useState(false)
  const [currency, setCurrency] = useState<PlanCurrency>(guessCurrency)
  const [term, setTerm] = useState<'year' | 'month'>('year')
  const [students, setStudents] = useState('300')

  useEffect(() => {
    void fetchPriceList().then((r) => (r.kind === 'ok' ? setList(r.data) : setFailed(true)))
  }, [])

  const money = useMemo(() => {
    const format = new Intl.NumberFormat(lang === 'ar' ? 'ar-JO' : 'en', { maximumFractionDigits: 2 })
    return (minor: number) => `${format.format(minor / 100)} ${t(`pricing.currency.${currency}` as TranslationKey)}`
  }, [lang, currency, t])

  const count = Math.max(0, Math.floor(Number(students) || 0))
  const quote = (plan: PublicPlan) => {
    const p = plan.price[currency]
    const year = Math.max(p.minimumYear, p.perStudentYear * count)
    return term === 'year' ? year : Math.round((year * (1 + (list?.monthlyUplift ?? 0))) / 12)
  }

  return (
    <div className="pricing">
      <header className="pricing__bar">
        <BrandLockup tagline={t('app.tagline')} />
        <nav className="pricing__nav">
          <LanguageToggle />
          <Link to="/login" className="btn">
            {t('login.submit')}
          </Link>
          {list?.signupOpen !== false && (
            <Link to="/signup" className="btn btn--primary">
              {t('pricing.startTrial')}
            </Link>
          )}
        </nav>
      </header>

      <main className="pricing__main">
        <h1 className="pricing__title">{t('pricing.title')}</h1>
        <p className="pricing__lead">{t('pricing.lead', { days: String(list?.trialDays ?? 30) })}</p>

        <div className="pricing__controls">
          <div className="segmented" role="group" aria-label={t('pricing.currencyLabel')}>
            {(list?.currencies ?? ['JOD', 'USD', 'SAR', 'AED']).map((c) => (
              <button
                key={c}
                type="button"
                className={c === currency ? 'is-active' : ''}
                aria-pressed={c === currency}
                onClick={() => setCurrency(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label={t('pricing.termLabel')}>
            {(['year', 'month'] as const).map((x) => (
              <button key={x} type="button" className={x === term ? 'is-active' : ''} aria-pressed={x === term} onClick={() => setTerm(x)}>
                {t(`pricing.term.${x}` as TranslationKey)}
              </button>
            ))}
          </div>
          <label className="field pricing__students">
            <span>{t('pricing.students')}</span>
            <input
              className="input"
              inputMode="numeric"
              dir="ltr"
              value={students}
              onChange={(e) => setStudents(e.target.value.replace(/\D/g, ''))}
            />
          </label>
        </div>

        {failed && <p className="notice notice--warn">{t('pricing.loadError')}</p>}

        <div className="pricing__plans">
          {(list?.plans ?? []).map((plan) => {
            const p = plan.price[currency]
            const featured = plan.key === 'professional'
            return (
              <section key={plan.key} className={`pricing__plan${featured ? ' pricing__plan--featured' : ''}`}>
                {featured && <span className="pricing__badge">{t('pricing.popular')}</span>}
                <h2>{t(`plan.name.${plan.key}` as TranslationKey)}</h2>
                <p className="card__hint">{t(`plan.blurb.${plan.key}` as TranslationKey)}</p>
                <p className="pricing__price">
                  <strong>{money(p.perStudentYear)}</strong> <span>{t('pricing.perStudentYear')}</span>
                </p>
                <p className="card__hint">{t('pricing.minimum', { amount: money(p.minimumYear) })}</p>
                <p className="pricing__quote">
                  {t(term === 'year' ? 'pricing.quoteYear' : 'pricing.quoteMonth', { count: String(count), amount: money(quote(plan)) })}
                </p>
                <ul className="pricing__features">
                  <li>{t('pricing.core')}</li>
                  {plan.modules.map((m) => (
                    <li key={m}>{t(`plan.module.${m}` as TranslationKey)}</li>
                  ))}
                  <li>
                    {plan.limits.branches === null
                      ? t('pricing.branchesUnlimited')
                      : plan.limits.branches === 1
                        ? t('pricing.branchesOne')
                        : t('pricing.branches', { count: String(plan.limits.branches) })}
                  </li>
                  <li>
                    {plan.limits.smsPerStudent ? t('pricing.sms', { count: String(plan.limits.smsPerStudent) }) : t('pricing.smsPacks')}
                  </li>
                </ul>
                <Link to="/signup" className={`btn btn--block${featured ? ' btn--primary' : ''}`}>
                  {t('pricing.startTrial')}
                </Link>
              </section>
            )
          })}
        </div>

        <section className="pricing__notes">
          <h2>{t('pricing.notesTitle')}</h2>
          <ul>
            <li>{t('pricing.note.students')}</li>
            <li>{t('pricing.note.monthly', { percent: String(Math.round((list?.monthlyUplift ?? 0.2) * 100)) })}</li>
            <li>{t('pricing.note.onboarding')}</li>
            <li>{t('pricing.note.payment')}</li>
            <li>{t('pricing.note.tax')}</li>
          </ul>
          <p className="card__hint">
            <a href="/legal/terms.html">{t('signup.termsLink')}</a> · <a href="/legal/privacy.html">{t('signup.privacyLink')}</a> ·{' '}
            <a href="/legal/dpa.html">{t('pricing.dpa')}</a>
          </p>
        </section>
      </main>
    </div>
  )
}
