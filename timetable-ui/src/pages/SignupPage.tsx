import { useState } from 'react'
import { Link } from 'react-router-dom'
import { signup } from '../lib/authApi'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { AuthShell } from '../components/AuthShell'

/** Countries the product is sold in first; anything else is "Other". */
const COUNTRIES = ['JO', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'IQ', 'PS', 'LB'] as const

/**
 * SAMS 13.2 — a school starts its own free trial. The owner's password is
 * set from the emailed link (which proves the address), and that link signs
 * them straight in.
 */
export function SignupPage() {
  const { t } = useI18n()
  const [form, setForm] = useState({ schoolName: '', ownerName: '', email: '', phone: '', country: 'JO', students: '', website: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ emailed: boolean } | null>(null)
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: event.target.value }))

  const ready = form.schoolName.trim().length >= 2 && form.ownerName.trim().length >= 2 && /\S+@\S+\.\S+/.test(form.email)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    const students = Number(form.students)
    const result = await signup({
      schoolName: form.schoolName.trim(),
      ownerName: form.ownerName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim() || undefined,
      country: form.country === 'other' ? 'XX' : form.country,
      students: Number.isInteger(students) && students > 0 ? students : undefined,
      website: form.website || undefined,
    })
    setBusy(false)
    if (result.kind === 'ok')
      return setDone({ emailed: result.invite === undefined || result.invite === 'invited' || result.invite === 'added' })
    const key = `signup.error.${result.error}` as TranslationKey
    setError(t(key) === key ? t('login.errorNetwork') : t(key))
  }

  if (done) {
    return (
      <AuthShell>
        <div className="login__form">
          <h2 className="login__title">{t('signup.doneTitle')}</h2>
          <p className={done.emailed ? 'login__success' : 'login__error'}>{t(done.emailed ? 'signup.done' : 'signup.doneNoEmail')}</p>
          <Link to="/login" className="login__forgot">
            {t('forgot.backToLogin')}
          </Link>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form className="login__form" onSubmit={submit} noValidate>
        <h2 className="login__title">{t('signup.title')}</h2>
        <p className="login__subtitle">{t('signup.subtitle')}</p>

        <label className="field">
          <span>{t('signup.schoolName')}</span>
          <input className="input" value={form.schoolName} onChange={set('schoolName')} autoComplete="organization" />
        </label>
        <label className="field">
          <span>{t('signup.ownerName')}</span>
          <input className="input" value={form.ownerName} onChange={set('ownerName')} autoComplete="name" />
        </label>
        <label className="field">
          <span>{t('login.email')}</span>
          <input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" dir="ltr" />
        </label>
        <label className="field">
          <span>{t('signup.phone')}</span>
          <input className="input" type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" dir="ltr" />
        </label>
        <div className="field-grid">
          <label className="field">
            <span>{t('signup.country')}</span>
            <select className="select" value={form.country} onChange={set('country')}>
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {t(`signup.country.${c}` as TranslationKey)}
                </option>
              ))}
              <option value="other">{t('signup.country.other')}</option>
            </select>
          </label>
          <label className="field">
            <span>{t('signup.students')}</span>
            <input className="input" inputMode="numeric" value={form.students} onChange={set('students')} dir="ltr" />
          </label>
        </div>
        {/* Hidden from people; a bot that fills it in gets nothing. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={set('website')}
          style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }}
          aria-hidden="true"
        />

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !ready}>
          {busy ? t('signup.sending') : t('signup.submit')}
        </button>
        <p className="card__hint">
          {t('signup.terms')} <a href="/legal/terms.html">{t('signup.termsLink')}</a> ·{' '}
          <a href="/legal/privacy.html">{t('signup.privacyLink')}</a>
        </p>
        <Link to="/pricing" className="login__forgot">
          {t('signup.seePlans')}
        </Link>
        <Link to="/login" className="login__forgot">
          {t('signup.haveAccount')}
        </Link>
      </form>
    </AuthShell>
  )
}
