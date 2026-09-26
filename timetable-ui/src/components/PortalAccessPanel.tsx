import { useCallback, useEffect, useState } from 'react'
import { disablePortal, enablePortal, getPortalAccess, resendPortalInvite, type PortalAccess } from '../lib/communicationApi'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/**
 * A parent's portal login (SAMS 6.4), on the parent record: its state, and
 * enable / resend the invite / disable. Which children the parent sees is
 * each link's own "portal access" flag, listed here for reference.
 */
export function PortalAccessPanel({ parentId }: { parentId: string }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [state, setState] = useState<PortalAccess | null>(null)
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const errorText = (code: string) => {
    const key = `portal.error.${code}` as TranslationKey
    const text = t(key)
    return text === key ? t('parents.error.generic') : text
  }

  const load = useCallback(async () => {
    const res = await getPortalAccess(getAccessToken, parentId)
    if (res.kind === 'ok') setState(res.data)
  }, [getAccessToken, parentId])
  useEffect(() => {
    void load()
  }, [load])

  // An invite that couldn't be emailed is a warning: access is on, but the
  // parent doesn't know yet.
  const emailNote = (sent: boolean | undefined, emailError: string | null | undefined) =>
    sent ? { text: t('portal.manage.inviteSent'), warn: false } : emailError ? { text: errorText(emailError), warn: true } : null

  const run = async (action: 'enable' | 'resend' | 'disable') => {
    setBusy(true)
    setError(null)
    setNote(null)
    if (action === 'enable') {
      const res = await enablePortal(getAccessToken, parentId)
      if (res.kind !== 'ok') setError(errorText(res.error))
      else
        setNote(
          res.data.account === 'active'
            ? { text: t('portal.manage.added'), warn: false }
            : emailNote(res.data.emailSent, res.data.emailError),
        )
    } else if (action === 'resend') {
      const res = await resendPortalInvite(getAccessToken, parentId)
      if (res.kind !== 'ok') setError(errorText(res.error))
      else setNote(emailNote(res.data.emailSent, res.data.emailError))
    } else {
      const res = await disablePortal(getAccessToken, parentId)
      if (res.kind !== 'ok') setError(errorText(res.error))
    }
    setBusy(false)
    await load()
  }

  if (!state) return <div className="skeleton" style={{ height: 60 }} />
  const shared = (state.children ?? []).filter((c) => c.portalAccess)
  return (
    <div className="portal-access">
      <h3 className="card__subtitle" style={{ margin: 0 }}>
        {t('portal.manage.title')}
      </h3>
      <p>
        <span className={`chip${state.account === 'active' ? ' chip--ok' : state.account === 'invited' ? ' chip--on' : ''}`}>
          {t(`portal.account.${state.account}` as TranslationKey)}
        </span>{' '}
        {state.email && <span className="mono">{state.email}</span>}
        {state.lastLoginAt && (
          <small className="card__hint">
            {' '}
            ·{' '}
            {t('portal.manage.lastLogin', {
              date: new Date(state.lastLoginAt).toLocaleString(),
            })}
          </small>
        )}
      </p>
      <p className="card__hint">
        {shared.length
          ? t('portal.manage.children', {
              names: shared.map((c) => c.name).join(', '),
            })
          : t('portal.manage.noChildren')}
      </p>
      {note && <p className={`notice${note.warn ? ' notice--warn' : ''}`}>{note.text}</p>}
      {error && <p className="login__error">{error}</p>}
      <div className="inline-form">
        {!state.enabled && (
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void run('enable')}>
            {state.account === 'disabled' ? t('portal.manage.reenable') : t('portal.manage.enable')}
          </button>
        )}
        {state.enabled && state.account === 'invited' && (
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run('resend')}>
            {t('portal.manage.resend')}
          </button>
        )}
        {state.enabled && (
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void run('disable')}>
            {t('portal.manage.disable')}
          </button>
        )}
      </div>
    </div>
  )
}
