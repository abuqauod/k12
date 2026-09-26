import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { BrandMark } from '../components/BrandMark'
import { LanguageToggle } from '../components/LanguageToggle'
import { GlobalSearch } from '../components/GlobalSearch'
import { InboxBell } from '../components/InboxBell'
import { SubscriptionBanner } from '../components/SubscriptionBanner'
import type { TranslationKey } from '../i18n/translations'

interface NavEntry {
  to: string
  key: TranslationKey
  icon: string
  /** Shown only with this scope (the page itself enforces it too). */
  scope?: string
  /** Shown with any one of these. */
  anyScope?: string[]
  group: 'plan' | 'ops' | 'account'
  /** SAMS 13.1: hidden when the school's plan doesn't include it. */
  module?: string
}

// Day-to-day work sits under "plan"; the rest under "account". Every
// entry names the scope its page needs (SAMS 12: a teacher was shown
// Finance and the audit log, and got error pages).
export const NAV: NavEntry[] = [
  { to: '/dashboard', key: 'nav.dashboard', icon: '▤', group: 'plan', scope: 'dashboard.read' },
  { to: '/timetable', key: 'nav.timetable', icon: '▦', group: 'plan', scope: 'datasets.read' },
  { to: '/students', key: 'nav.students', icon: '☺', group: 'plan', scope: 'students.read' },
  { to: '/admissions', key: 'nav.admissions', icon: '✎', group: 'plan', scope: 'admissions.read', module: 'admissions' },
  { to: '/parents', key: 'nav.parents', icon: '⚭', group: 'plan', scope: 'parents.read' },
  { to: '/classes', key: 'nav.classes', icon: '▣', group: 'plan', scope: 'classes.read' },
  { to: '/attendance', key: 'nav.attendance', icon: '✓', group: 'plan', scope: 'attendance.read' },
  { to: '/grades', key: 'nav.grades', icon: '✦', group: 'plan', scope: 'grades.read', module: 'grades' },
  { to: '/behaviour', key: 'nav.behaviour', icon: '⚑', group: 'plan', scope: 'discipline.report', module: 'wellbeing' },
  { to: '/clinic', key: 'nav.clinic', icon: '✚', group: 'plan', scope: 'health.read', module: 'wellbeing' },
  { to: '/hr', key: 'nav.hr', icon: '♙', group: 'ops', scope: 'hr.read', module: 'hr' },
  { to: '/operations', key: 'nav.operations', icon: '⚒', group: 'ops', scope: 'ops.read', module: 'operations' },
  { to: '/canteen', key: 'nav.canteen', icon: '☕', group: 'ops', scope: 'canteen.sell', module: 'canteen' },
  { to: '/library', key: 'nav.library', icon: '❏', group: 'ops', scope: 'ops.read', module: 'library' },
  { to: '/events', key: 'nav.events', icon: '✷', group: 'ops', scope: 'ops.read', module: 'operations' },
  { to: '/fleet', key: 'nav.fleet', icon: '⛟', group: 'ops', scope: 'transport.read', module: 'transport' },
  { to: '/routes', key: 'nav.routes', icon: '⌖', group: 'account', scope: 'transport.read', module: 'transport' },
  { to: '/finance', key: 'nav.finance', icon: '⛃', group: 'account', scope: 'finance.read' },
  { to: '/approvals', key: 'nav.approvals', icon: '⚖', group: 'account' },
  {
    to: '/communication',
    key: 'nav.communication',
    icon: '✉',
    group: 'account',
    anyScope: ['announcements.manage', 'finance.reminders', 'notifications.manage'],
  },
  { to: '/reports', key: 'nav.reports', icon: '▥', group: 'account', scope: 'dashboard.read' },
  { to: '/logs', key: 'nav.logs', icon: '☰', group: 'account', scope: 'audit.read' },
  { to: '/settings', key: 'nav.settings', icon: '⚙', group: 'account' },
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
  const { user, signOut, roleKey, can, hasModule } = useAuth()
  const { branches, activeBranchId, setActiveBranchId } = useApp()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [searchOpen, setSearchOpen] = useState(false)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

  // SAMS 13.1: a page of a module the plan lacks, reached by its address.
  const { pathname } = useLocation()
  const here = NAV.find((e) => pathname === e.to || pathname.startsWith(`${e.to}/`))
  const outsidePlan = here?.module && !hasModule(here.module) ? here.module : null

  const visible = (e: NavEntry) =>
    (!e.scope || can(e.scope)) && (!e.anyScope || e.anyScope.some(can)) && (!e.module || hasModule(e.module))

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

        <button
          type="button"
          className="btn btn--sm btn--block"
          title={collapsed ? t('search.trigger') : t('search.shortcutHint', { shortcut: shortcutLabel })}
          onClick={() => setSearchOpen(true)}
        >
          <span className="sidebar__icon" aria-hidden="true">
            ⌕
          </span>
          <span className="sidebar__label" style={{ flex: 1, textAlign: 'start' }}>
            {t('search.trigger')}
          </span>
          {!collapsed && <kbd className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{shortcutLabel}</kbd>}
        </button>

        <nav className="sidebar__nav" aria-label={t('nav.menu')}>
          <p className="sidebar__section">{t('nav.section.plan')}</p>
          {NAV.filter((e) => e.group === 'plan' && visible(e)).map(renderLink)}
          {NAV.some((e) => e.group === 'ops' && visible(e)) && (
            <p className="sidebar__section">{t('nav.section.ops')}</p>
          )}
          {NAV.filter((e) => e.group === 'ops' && visible(e)).map(renderLink)}
          <p className="sidebar__section">{t('nav.section.account')}</p>
          {NAV.filter((e) => e.group === 'account' && visible(e)).map(renderLink)}
        </nav>

        <div className="sidebar__foot">
          <LanguageToggle compact={collapsed} />
          <div className="sidebar__user" title={collapsed ? displayName : undefined}>
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <span className="sidebar__user-text">
              <b>{displayName}</b>
              <small>{user ? t(`settings.role.${roleKey ?? user.role}` as TranslationKey) : ''}</small>
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
        <div className="shell__bar">
          {branches.length > 1 && (
            <label className="shell__branch">
              <span className="shell__branch-label">{t('nav.branch')}</span>
              <select
                className="input input--sm"
                value={activeBranchId ?? ''}
                onChange={(event) => setActiveBranchId(event.target.value)}
              >
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <InboxBell />
        </div>
        <SubscriptionBanner />
        {outsidePlan ? <OutsidePlan module={outsidePlan} /> : <Outlet />}
      </div>

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
    </div>
  )
}

/** Shown instead of a page whose module the school's plan doesn't include. */
function OutsidePlan({ module }: { module: string }) {
  const { t } = useI18n()
  const { can } = useAuth()
  return (
    <div className="page">
      <div className="empty-state">
        <h2>{t(`plan.module.${module}` as TranslationKey)}</h2>
        <p>{t('plan.outside')}</p>
        {can('settings.read') && (
          <Link to="/settings/subscription" className="btn btn--primary">
            {t('plan.outsideLink')}
          </Link>
        )}
      </div>
    </div>
  )
}
