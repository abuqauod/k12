import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { BrandMark } from '../components/BrandMark'
import { LanguageToggle } from '../components/LanguageToggle'
import type { TranslationKey } from '../i18n/translations'

interface NavEntry {
  to: string
  key: TranslationKey
  icon: string
}

const NAV: NavEntry[] = [
  { to: '/dashboard', key: 'nav.dashboard', icon: '▤' },
  { to: '/timetable', key: 'nav.timetable', icon: '▦' },
  { to: '/students', key: 'nav.students', icon: '☺' },
  { to: '/routes', key: 'nav.routes', icon: '⌖' },
  { to: '/settings', key: 'nav.settings', icon: '⚙' },
]

const COLLAPSE_KEY = 'timetable.sidebar'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

export function AppShell() {
  const { t, lang } = useI18n()
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'expanded')
      } catch {
        // Preference simply will not persist.
      }
      return next
    })
  }, [])

  // The drawer and the rail are different modes; leaving one closes the other.
  useEffect(() => {
    if (open) setOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed])

  const displayName = user ? (lang === 'ar' ? user.displayNameAr ?? user.displayName : user.displayName) : ''
  const initials = displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')

  const renderLink = (entry: NavEntry) => (
    <NavLink
      key={entry.to}
      to={entry.to}
      title={collapsed ? t(entry.key) : undefined}
      className={({ isActive }) => `sidebar__link${isActive ? ' is-active' : ''}`}
      onClick={() => setOpen(false)}
    >
      <span className="sidebar__icon" aria-hidden="true">
        {entry.icon}
      </span>
      <span className="sidebar__label">{t(entry.key)}</span>
    </NavLink>
  )

  return (
    <div className={`shell${collapsed ? ' shell--collapsed' : ''}`}>
      <aside
        id="app-sidebar"
        className={`sidebar${open ? ' sidebar--open' : ''}${collapsed ? ' sidebar--collapsed' : ''}`}
      >
        <div className="sidebar__brand">
          <BrandMark />
          <span className="sidebar__wordmark">
            <b>{t('app.name')}</b>
          </span>
          <button
            id="hide-sidebar-collapse-toggle"
            type="button"
            className="sidebar__toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            title={collapsed ? t('nav.expand') : t('nav.collapse')}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              {/* Points at the edge the sidebar will move toward. RTL is
                  handled by mirroring the button in CSS. */}
              <path
                d={collapsed ? 'M6 3 11 8 6 13' : 'M10 3 5 8 10 13'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <nav className="sidebar__nav" aria-label={t('nav.menu')}>
          <p className="sidebar__section">{t('nav.section.plan')}</p>
          {NAV.slice(0, 4).map(renderLink)}
          <p className="sidebar__section">{t('nav.section.account')}</p>
          {NAV.slice(4).map(renderLink)}
        </nav>

        <div className="sidebar__foot">
          <LanguageToggle compact={collapsed} />
          <div className="sidebar__user" title={collapsed ? displayName : undefined}>
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="sidebar__user-text">
              <b>{displayName}</b>
              <small>{user ? t(`settings.role.${user.role}` as TranslationKey) : ''}</small>
            </span>
          </div>
          <button
            type="button"
            className="btn btn--sm btn--block"
            title={collapsed ? t('nav.signOut') : undefined}
            onClick={() => {
              signOut()
              navigate('/login', { replace: true })
            }}
          >
            <span className="sidebar__icon" aria-hidden="true">
              ⏻
            </span>
            <span className="sidebar__label">{t('nav.signOut')}</span>
          </button>
        </div>
      </aside>

      {open && <div className="sidebar__scrim" onClick={() => setOpen(false)} />}

      <div className="shell__main">
        <button
          type="button"
          className="btn btn--sm shell__burger"
          onClick={() => setOpen(!open)}
          aria-label={open ? t('nav.collapse') : t('nav.expand')}
          aria-controls="app-sidebar"
        >
          ☰
        </button>
        <Outlet />
      </div>
    </div>
  )
}
