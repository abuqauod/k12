import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { DEMO_HINTS, useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { BrandLockup } from '../components/BrandMark'
import { LanguageToggle } from '../components/LanguageToggle'

export function LoginPage() {
  const { t } = useI18n()
  const { user, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'
    return <Navigate to={from} replace />
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError(t('login.emptyError'))
      return
    }
    setBusy(true)
    setError(null)
    const ok = await signIn(email, password)
    setBusy(false)
    if (ok) {
      const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'
      navigate(from, { replace: true })
    } else {
      setError(t('login.error'))
    }
  }

  const highlights = [
    { title: t('login.marketing.solver'), body: t('login.marketing.solverBody') },
    { title: t('login.marketing.breaks'), body: t('login.marketing.breaksBody') },
    { title: t('login.marketing.tiers'), body: t('login.marketing.tiersBody') },
  ]

  return (
    <div className="login">
      <aside className="login__aside">
        <div className="login__brand">
          <BrandLockup tagline={t('app.tagline')} />
        </div>

        <ul className="login__points">
          {highlights.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
      </aside>

      <main className="login__main">
        <div className="login__topbar">
          <LanguageToggle />
        </div>

        <form className="login__form" onSubmit={submit} noValidate>
          <h2 className="login__title">{t('login.title')}</h2>
          <p className="login__subtitle">{t('login.subtitle')}</p>

          <label className="field">
            <span>{t('login.email')}</span>
            <input
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@school.test"
            />
          </label>

          <label className="field">
            <span>{t('login.password')}</span>
            <div className="input-affix">
              <input
                className="input"
                type={reveal ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setReveal(!reveal)}
                aria-label={reveal ? t('login.hidePassword') : t('login.showPassword')}
              >
                {reveal ? '🙈' : '👁'}
              </button>
            </div>
          </label>

          {error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? t('login.signingIn') : t('login.submit')}
          </button>

          <div className="login__demo">
            <h3 className="panel__title">{t('login.demoTitle')}</h3>
            {DEMO_HINTS.map((account) => (
              <button
                type="button"
                key={account.email}
                className="login__demo-row"
                onClick={() => {
                  setEmail(account.email)
                  setPassword(account.password)
                  setError(null)
                }}
              >
                <span className="mono">{account.email}</span>
                <span className="mono">{account.password}</span>
                <span className="chip">{t(`settings.role.${account.role}`)}</span>
              </button>
            ))}
            <p className="login__note">{t('login.demoNote')}</p>
          </div>
        </form>
      </main>
    </div>
  )
}
