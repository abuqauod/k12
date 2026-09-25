import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { BrandLockup } from './BrandMark'
import { LanguageToggle } from './LanguageToggle'

/** Stroke icons for the brand panel — inline so they follow `currentColor`. */
const ICONS = {
  students: (
    <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10 8v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 5.15a3 3 0 0 1 0 5.7" />
  ),
  finance: <path d="M3 7h18v12H3zM3 11h18M7 15h3" />,
  staff: <path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-3Zm-3 9 2 2 4-4" />,
}

/**
 * The two-column shell every pre-authentication page uses (sign in, accept
 * an invite, reset a password): the brand panel, and the form column.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useI18n()

  const highlights = [
    { icon: ICONS.students, title: t('login.points.students'), body: t('login.points.studentsBody') },
    { icon: ICONS.finance, title: t('login.points.finance'), body: t('login.points.financeBody') },
    { icon: ICONS.staff, title: t('login.points.staff'), body: t('login.points.staffBody') },
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
              <svg
                className="login__point-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {item.icon}
              </svg>
              <div>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </div>
            </li>
          ))}
        </ul>

        <p className="login__trust">{t('login.trust')}</p>
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
