import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import type { TenantChoice } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { AuthShell } from '../components/AuthShell'

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

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const MAIL = 'M4 6h16v12H4zM4 7l8 6 8-6'
const LOCK = 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3'
const EYE = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
const EYE_OFF = 'M3 3l18 18M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2'
const CHEVRON = 'M9 6l6 6-6 6'

const initials = (name: string) =>
  name
    .split(/s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

function errorKey(code: string): TranslationKey {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'login.error'
    case 'NO_ACTIVE_TENANT':
    case 'NOT_A_MEMBER':
      return 'login.errorInactiveTenant'
    case 'NOT_CONFIGURED':
      return 'login.errorNotConfigured'
    case 'TOO_MANY_ATTEMPTS':
    case 'RATE_LIMITED':
      return 'login.errorTooManyAttempts'
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
    const from = (location.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={from} replace />
  }

  const goIn = () => {
    const from = (location.state as { from?: string } | null)?.from ?? '/'
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

  return (
    <AuthShell>
      {tenants ? (
          <div className="login__form">
            <h2 className="login__title">{t('login.chooseSchool')}</h2>
            <p className="login__subtitle">{t('login.chooseSchoolHint')}</p>

            <div className="login__schools">
              {tenants.map((tenant) => (
                <button
                  type="button"
                  key={tenant.slug}
                  className="login__school"
                  disabled={busy}
                  onClick={() => void attempt(tenant.slug)}
                >
                  <span className="login__school-avatar" aria-hidden="true">
                    {initials(tenant.name)}
                  </span>
                  <span className="login__school-name">{tenant.name}</span>
                  <span className="login__chevron">
                    <Icon d={CHEVRON} />
                  </span>
                </button>
              ))}
            </div>

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
            <h2 className="login__title">{t('login.welcome')}</h2>
            <p className="login__subtitle">{t('login.welcomeHint')}</p>

            <div className="field">
              <label htmlFor="login-email">{t('login.email')}</label>
              <div className="login__input">
                <Icon d={MAIL} />
                <input
                  id="login-email"
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@school.test"
                  aria-invalid={Boolean(error)}
                />
              </div>
            </div>

            <div className="field">
              <div className="login__label-row">
                <label htmlFor="login-password">{t('login.password')}</label>
                <Link to="/forgot-password" className="login__forgot">
                  {t('login.forgotPassword')}
                </Link>
              </div>
              <div className="login__input">
                <Icon d={LOCK} />
                <input
                  id="login-password"
                  className="input"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={Boolean(error)}
                />
                <button
                  type="button"
                  className="login__reveal"
                  onClick={() => setReveal(!reveal)}
                  aria-label={reveal ? t('login.hidePassword') : t('login.showPassword')}
                  aria-pressed={reveal}
                >
                  <Icon d={reveal ? EYE_OFF : EYE} />
                </button>
              </div>
            </div>

            {error && (
              <p className="login__error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn btn--primary btn--block login__submit" disabled={busy} aria-busy={busy}>
              {busy ? t('login.signingIn') : t('login.submit')}
            </button>
            <Link to="/signup" className="login__forgot" style={{ textAlign: 'center' }}>
              {t('login.startTrial')}
            </Link>

            <details className="login__demo">
              <summary>{t('login.demoTitle')}</summary>
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
            </details>
          </form>
        )}
    </AuthShell>
  )
}
