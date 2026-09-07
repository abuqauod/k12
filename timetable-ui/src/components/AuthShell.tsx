import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { BrandLockup } from './BrandMark'
import { LanguageToggle } from './LanguageToggle'

/**
 * The two-column shell every pre-authentication page uses (sign in, accept
 * an invite, reset a password) — factored out so the marketing aside isn't
 * triplicated, and so `.login` (a two-column grid) always gets both columns.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useI18n()

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
        {children}
      </main>
    </div>
  )
}
