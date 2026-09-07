import { useState } from 'react'
import { Link } from 'react-router-dom'
import { forgotPassword } from '../lib/authApi'
import { useI18n } from '../i18n/I18nContext'
import { AuthShell } from '../components/AuthShell'

export function ForgotPasswordPage() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setMessage(null)
    const result = await forgotPassword(email.trim())
    setBusy(false)
    if (result.kind === 'ok') {
      setMessage({ text: t('forgot.success'), kind: 'success' })
      return
    }
    if (result.error === 'EMAIL_NOT_CONFIGURED') {
      setMessage({ text: t('forgot.emailNotConfigured'), kind: 'error' })
      return
    }
    setMessage({ text: t('login.errorNetwork'), kind: 'error' })
  }

  return (
    <AuthShell>
      <form className="login__form" onSubmit={submit} noValidate>
        <h2 className="login__title">{t('forgot.title')}</h2>
        <p className="login__subtitle">{t('forgot.subtitle')}</p>

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

        {message && (
          <p className={message.kind === 'success' ? 'login__success' : 'login__error'} role="alert">
            {message.text}
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !email.trim()}>
          {busy ? t('forgot.sending') : t('forgot.submit')}
        </button>

        <Link to="/login" className="login__forgot">
          {t('forgot.backToLogin')}
        </Link>
      </form>
    </AuthShell>
  )
}
