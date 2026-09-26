import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { acceptInvite, resetPassword } from '../lib/authApi'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { AuthShell } from '../components/AuthShell'

type Mode = 'invite' | 'reset'

/**
 * One component behind two routes (`/accept-invite`, `/reset-password`) —
 * an invite email and a password-reset email point at the same shape of
 * page (a token in the query string, a new password to set), so this is
 * one implementation rather than two that would drift apart.
 */
export function SetPasswordPage({ mode }: { mode: Mode }) {
  const { t } = useI18n()
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const tokenErrorKey = (code: string): TranslationKey => {
    const suffix = code.replace('TOKEN_', '') // INVALID | EXPIRED | USED
    if (suffix === 'INVALID') return `${mode}.tokenInvalid` as TranslationKey
    if (suffix === 'EXPIRED') return `${mode}.tokenExpired` as TranslationKey
    if (suffix === 'USED') return `${mode}.tokenUsed` as TranslationKey
    return 'login.errorUnknown'
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!token) {
      setError(t('setpw.missingToken'))
      return
    }
    if (password.length < 8) {
      setError(t('setpw.tooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('setpw.mismatch'))
      return
    }
    setBusy(true)
    setError(null)
    const accepted = mode === 'invite' ? await acceptInvite(token, password) : null
    const result = accepted ?? (await resetPassword(token, password))
    if (result.kind === 'ok') {
      // A new account goes straight in with the password just chosen;
      // should that fail for any reason, "Go to sign in" still works.
      if (accepted?.kind === 'ok' && accepted.email && accepted.tenantSlug) {
        const signedIn = await signIn(accepted.email, password, accepted.tenantSlug)
        if (signedIn.ok) return navigate('/', { replace: true })
      }
      setBusy(false)
      setDone(true)
      return
    }
    setBusy(false)
    if (result.error.startsWith('TOKEN_')) {
      setError(t(tokenErrorKey(result.error)))
      return
    }
    setError(t('login.errorNetwork'))
  }

  if (done) {
    return (
      <AuthShell>
        <div className="login__form">
          <h2 className="login__title">{t(`${mode}.title` as TranslationKey)}</h2>
          <p className="login__success">{t(`${mode}.success` as TranslationKey)}</p>
          <Link to="/login" className="btn btn--primary btn--block" style={{ textAlign: 'center' }}>
            {t('setpw.goToLogin')}
          </Link>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form className="login__form" onSubmit={submit} noValidate>
        <h2 className="login__title">{t(`${mode}.title` as TranslationKey)}</h2>
        <p className="login__subtitle">{t(`${mode}.subtitle` as TranslationKey)}</p>

        {!token && (
          <p className="login__error" role="alert">
            {t('setpw.missingToken')}
          </p>
        )}

        <label className="field">
          <span>{t('setpw.newPassword')}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <label className="field">
          <span>{t('setpw.confirmPassword')}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !token}>
          {busy ? t('setpw.saving') : t('setpw.submit')}
        </button>
      </form>
    </AuthShell>
  )
}
