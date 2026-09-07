import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import type { TenantChoice } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { BrandLockup } from '../components/BrandMark'
import { LanguageToggle } from '../components/LanguageToggle'

/**
 * Matches the two schools `server/src/seed.ts` creates. These only work once
 * that server has actually been seeded (`npm run seed`) — real accounts,
 * shown here purely so the login page has something to demo with.
 */
const DEMO_HINTS: Array<{ email: string; password: string; role: 'owner' | 'scheduler' }> = [
  { email: 'admin@northgate.test', password: 'admin123', role: 'owner' },
  { email: 'planner@northgate.test', password: 'plan123', role: 'scheduler' },
  { email: 'admin@riverside.test', password: 'admin123', role: 'owner' },
]

function errorKey(code: string): TranslationKey {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'login.error'
    case 'NO_ACTIVE_TENANT':
    case 'NOT_A_MEMBER':
      return 'login.errorInactiveTenant'
    case 'NOT_CONFIGURED':
      return 'login.errorNotConfigured'
    case 'TIMEOUT':
    case 'OFFLINE':
    case 'NETWORK_ERROR':
      return 'login.errorNetwork'
    default:
      return 'login.errorUnknown'
  }
}

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
  /** Set when the account belongs to more than one school. */
  const [tenants, setTenants] = useState<TenantChoice[] | null>(null)

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'
    return <Navigate to={from} replace />
  }

  const goIn = () => {
    const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'
    navigate(from, { replace: true })
  }

  const attempt = async (tenantSlug?: string) => {
    setBusy(true)
    setError(null)
    const result = await signIn(email, password, tenantSlug)
    setBusy(false)
    if (result.ok) {
      goIn()
      return
    }
    if (result.needsTenant) {
      setTenants(result.tenants)
      return
    }
    setError(t(errorKey(result.error)))
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError(t('login.emptyError'))
      return
    }
    await attempt()
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

        {tenants ? (
          <div className="login__form">
            <h2 className="login__title">{t('login.chooseSchool')}</h2>
            <p className="login__subtitle">{t('login.chooseSchoolHint')}</p>

            {tenants.map((tenant) => (
              <button
                type="button"
                key={tenant.slug}
                className="login__demo-row"
                disabled={busy}
                onClick={() => void attempt(tenant.slug)}
              >
                <span>{tenant.name}</span>
              </button>
            ))}

            {error && (
              <p className="login__error" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn btn--ghost btn--block"
              disabled={busy}
              onClick={() => {
                setTenants(null)
                setError(null)
              }}
            >
              {t('login.back')}
            </button>
          </div>
        ) : (
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
        )}
      </main>
    </div>
  )
}
