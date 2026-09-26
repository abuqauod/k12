import { useEffect, useState } from 'react'
import { Link, Outlet, useNavigate, useOutletContext } from 'react-router-dom'
import { portalMe, type PortalMe } from '../lib/portalApi'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { BrandMark } from '../components/BrandMark'
import { LanguageToggle } from '../components/LanguageToggle'
import { InboxBell } from '../components/InboxBell'

/**
 * The parent portal (SAMS 6.4): a plain, phone-first frame — the school's
 * name, the inbox, language and sign out — around the parent's pages.
 * Nothing here shares the staff sidebar or its data.
 */

export interface PortalOutlet {
  me: PortalMe | null
  error: string | null
}

export const usePortal = () => useOutletContext<PortalOutlet>()

export function PortalShell() {
  const { t, lang } = useI18n()
  const { getAccessToken, signOut } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<PortalOutlet>({ me: null, error: null })

  useEffect(() => {
    void portalMe(getAccessToken).then((r) => setState(r.kind === 'ok' ? { me: r.data, error: null } : { me: null, error: r.error }))
  }, [getAccessToken])

  const school = state.me ? (lang === 'ar' && state.me.school.nameAr) || state.me.school.name : ''
  const parentName = state.me ? (lang === 'ar' && state.me.parent.fullNameAr) || state.me.parent.fullName : ''

  return (
    <div className="portal">
      <header className="portal__bar">
        <Link to="/portal" className="portal__brand">
          <BrandMark size={26} />
          <span>
            <b>{school || t('portal.title')}</b>
            <small>{t('portal.title')}</small>
          </span>
        </Link>
        <div className="portal__actions">
          <InboxBell />
          <LanguageToggle compact />
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              signOut()
              navigate('/login', { replace: true })
            }}
          >
            {t('nav.signOut')}
          </button>
        </div>
      </header>
      <main className="portal__main">
        {parentName && <p className="portal__greeting">{t('portal.hello', { name: parentName })}</p>}
        {state.error ? (
          <div className="empty-state">{t(state.error === 'PORTAL_DISABLED' ? 'portal.disabled' : 'portal.loadError')}</div>
        ) : (
          <Outlet context={state} />
        )}
      </main>
    </div>
  )
}
