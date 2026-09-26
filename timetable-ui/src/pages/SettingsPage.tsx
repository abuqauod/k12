import { useMemo, useRef, useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../state/AppContext'
import type { Theme } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { LANGUAGES } from '../i18n/translations'
import type { TranslationKey } from '../i18n/translations'
import { download, toProblemPayload } from '../lib/api'
import {
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
  setMemberBranches,
  getRoleCatalog,
  ROLE_KEYS,
} from '../lib/memberships'
import type { Member, MemberRole, RoleCatalog, RoleChoice } from '../lib/memberships'
import {
  getNotificationSettings,
  getSchoolCalendar,
  putNotificationSettings,
  putSchoolCalendar,
  runAbsenceNotifications,
} from '../lib/notificationsApi'
import type { NotificationSettings, SchoolCalendar } from '../lib/notificationsApi'
import { SchoolWeekFields } from '../components/SchoolWeekFields'
import { ConstraintWeightsEditor } from '../components/ConstraintWeights'
import { RoutingRulesEditor } from '../components/RoutingRules'
import { BreaksEditor } from '../components/BreaksEditor'
import { JsonDialog } from '../components/JsonDialog'
import { getTenant } from '../lib/tenantApi'
import { LookupSection } from '../components/LookupSection'
import { MyLeaveCard } from '../components/hr/MyLeaveCard'
import {
  AcademicYearsSection,
  GradesClassesSection,
  NotificationTemplatesSection,
  OrganizationProfileCard,
  RolesSection,
} from '../components/SettingsSections'
import type { TenantProfile } from '../lib/tenantApi'
import { NumberingSection } from '../components/settings/NumberingSection'

const THEMES: Theme[] = ['auto', 'light', 'dark']

type SettingsSection =
  | 'account'
  | 'organization'
  | 'branches'
  | 'academic-years'
  | 'grades-classes'
  | 'payment-methods'
  | 'document-categories'
  | 'admission-sources'
  | 'withdrawal-reasons'
  | 'expense-categories'
  | 'departments'
  | 'positions'
  | 'contract-types'
  | 'asset-categories'
  | 'inventory-categories'
  | 'room-types'
  | 'book-categories'
  | 'event-types'
  | 'notification-templates'
  | 'numbering'
  | 'roles'
  | 'team'
  | 'calendar'
  | 'transport'
  | 'tuning'

interface SectionDef {
  id: SettingsSection
  key: TranslationKey
  /** Scope that shows the section; the API enforces the same. */
  scope?: string
}

/** Settings information architecture (SAMS 1.11): one place, grouped. */
const SECTION_GROUPS: Array<{ key: TranslationKey; sections: SectionDef[] }> = [
  { key: 'settings.group.personal', sections: [{ id: 'account', key: 'settings.tab.account' }] },
  {
    key: 'settings.group.school',
    sections: [
      { id: 'organization', key: 'settings.tab.organization', scope: 'settings.read' },
      { id: 'branches', key: 'branches.title', scope: 'notifications.manage' },
      { id: 'academic-years', key: 'settings.section.academicYears', scope: 'academicYears.read' },
      { id: 'grades-classes', key: 'settings.section.gradesClasses', scope: 'classes.read' },
      { id: 'numbering', key: 'settings.section.numbering', scope: 'settings.read' },
      { id: 'payment-methods', key: 'settings.section.paymentMethods', scope: 'settings.read' },
      { id: 'document-categories', key: 'settings.section.documentCategories', scope: 'settings.read' },
      { id: 'admission-sources', key: 'settings.section.admissionSources', scope: 'settings.read' },
      { id: 'withdrawal-reasons', key: 'settings.section.withdrawalReasons', scope: 'settings.read' },
      { id: 'expense-categories', key: 'settings.section.expenseCategories', scope: 'settings.read' },
      { id: 'departments', key: 'settings.section.departments', scope: 'settings.read' },
      { id: 'positions', key: 'settings.section.positions', scope: 'settings.read' },
      { id: 'contract-types', key: 'settings.section.contractTypes', scope: 'settings.read' },
      { id: 'asset-categories', key: 'settings.section.assetCategories', scope: 'settings.read' },
      { id: 'inventory-categories', key: 'settings.section.inventoryCategories', scope: 'settings.read' },
      { id: 'room-types', key: 'settings.section.roomTypes', scope: 'settings.read' },
      { id: 'book-categories', key: 'settings.section.bookCategories', scope: 'settings.read' },
      { id: 'event-types', key: 'settings.section.eventTypes', scope: 'settings.read' },
      { id: 'notification-templates', key: 'settings.section.notificationTemplates', scope: 'settings.read' },
    ],
  },
  {
    key: 'settings.group.access',
    sections: [
      { id: 'team', key: 'settings.tab.team', scope: 'memberships.manage' },
      { id: 'roles', key: 'settings.section.roles', scope: 'memberships.manage' },
    ],
  },
  {
    key: 'settings.group.scheduling',
    sections: [
      { id: 'calendar', key: 'settings.tab.calendar' },
      { id: 'transport', key: 'fleet.rules' },
      { id: 'tuning', key: 'panel.tuning' },
    ],
  },
]

export function SettingsPage() {
  const { t } = useI18n()
  const { can } = useAuth()
  const navigate = useNavigate()
  const { section } = useParams<{ section?: string }>()

  const groups = SECTION_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((s) => !s.scope || can(s.scope)),
  })).filter((group) => group.sections.length > 0)
  const allowed = groups.flatMap((group) => group.sections)
  // Unknown or not-permitted sections fall back to the first allowed one.
  const active = allowed.find((s) => s.id === section) ?? allowed[0]
  const go = (id: SettingsSection) => navigate(`/settings/${id}`)

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('settings.title')}</h1>
          <p className="page__subtitle">{t('settings.subtitle')}</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {groups.map((group) => (
            <div key={group.key} className="settings-nav__group">
              <p className="settings-nav__label">{t(group.key)}</p>
              {group.sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="settings-nav__item"
                  aria-current={active?.id === s.id ? 'page' : undefined}
                  onClick={() => go(s.id)}
                >
                  {t(s.key)}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <select
          className="select settings-nav__select"
          value={active?.id}
          onChange={(event) => go(event.target.value as SettingsSection)}
          aria-label={t('settings.title')}
        >
          {groups.map((group) => (
            <optgroup key={group.key} label={t(group.key)}>
              {group.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {t(s.key)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <div className="settings-content">
          {active?.id === 'account' && <AccountTab />}
          {active?.id === 'organization' && <OrganizationSettingsTab />}
          {active?.id === 'branches' && <BranchesSettingsTab />}
          {active?.id === 'academic-years' && <AcademicYearsSection />}
          {active?.id === 'grades-classes' && <GradesClassesSection />}
          {active?.id === 'numbering' && <NumberingSection />}
          {active?.id === 'payment-methods' && (
            <LookupSection
              kind="paymentMethod"
              title={t('settings.section.paymentMethods')}
              hint={t('settings.paymentMethods.hint')}
            />
          )}
          {active?.id === 'document-categories' && (
            <LookupSection
              kind="documentCategory"
              title={t('settings.section.documentCategories')}
              hint={t('settings.documentCategories.hint')}
            />
          )}
          {active?.id === 'admission-sources' && (
            <LookupSection
              kind="admissionSource"
              title={t('settings.section.admissionSources')}
              hint={t('settings.admissionSources.hint')}
            />
          )}
          {active?.id === 'withdrawal-reasons' && (
            <LookupSection
              kind="withdrawalReason"
              title={t('settings.section.withdrawalReasons')}
              hint={t('settings.withdrawalReasons.hint')}
            />
          )}
          {active?.id === 'expense-categories' && (
            <LookupSection
              kind="expenseCategory"
              title={t('settings.section.expenseCategories')}
              hint={t('settings.expenseCategories.hint')}
            />
          )}
          {active?.id === 'departments' && (
            <LookupSection kind="department" title={t('settings.section.departments')} hint={t('settings.departments.hint')} />
          )}
          {active?.id === 'positions' && (
            <LookupSection kind="position" title={t('settings.section.positions')} hint={t('settings.positions.hint')} />
          )}
          {active?.id === 'contract-types' && (
            <LookupSection kind="contractType" title={t('settings.section.contractTypes')} hint={t('settings.contractTypes.hint')} />
          )}
          {active?.id === 'asset-categories' && <LookupSection kind="assetCategory" title={t('settings.section.assetCategories')} hint={t('settings.assetCategories.hint')} />}
          {active?.id === 'inventory-categories' && <LookupSection kind="inventoryCategory" title={t('settings.section.inventoryCategories')} hint={t('settings.inventoryCategories.hint')} />}
          {active?.id === 'room-types' && <LookupSection kind="roomType" title={t('settings.section.roomTypes')} hint={t('settings.roomTypes.hint')} />}
          {active?.id === 'book-categories' && <LookupSection kind="bookCategory" title={t('settings.section.bookCategories')} hint={t('settings.bookCategories.hint')} />}
          {active?.id === 'event-types' && <LookupSection kind="eventType" title={t('settings.section.eventTypes')} hint={t('settings.eventTypes.hint')} />}
          {active?.id === 'notification-templates' && <NotificationTemplatesSection />}
          {active?.id === 'team' && <TeamSettingsTab />}
          {active?.id === 'roles' && <RolesSection />}
          {active?.id === 'calendar' && <CalendarSettingsTab />}
          {active?.id === 'transport' && <TransportSettingsTab />}
          {active?.id === 'tuning' && <TuningSettingsTab />}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- account */

const DATASET_FILE = 'timetable-problem.json'

function AccountTab() {
  const { t, n, lang, setLang } = useI18n()
  const { user, roleKey } = useAuth()
  const { theme, setTheme, problem, resetSample, importProblem } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)

  const problemJson = useMemo(
    () => JSON.stringify(toProblemPayload(problem), null, 2),
    [problem],
  )

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <>
      <MyLeaveCard />
      <div className="card-row">
        <section className="card">
          <h2 className="card__title">{t('settings.language')}</h2>
          <p className="card__hint">{t('settings.languageHint')}</p>
          <div className="option-list">
            {LANGUAGES.map((entry) => (
              <button
                key={entry.code}
                type="button"
                lang={entry.code}
                className={`option${lang === entry.code ? ' option--on' : ''}`}
                onClick={() => setLang(entry.code)}
              >
                <b>{entry.native}</b>
                <small>
                  {entry.label} · {entry.dir.toUpperCase()}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">{t('settings.theme')}</h2>
          <div className="option-list">
            {THEMES.map((entry) => (
              <button
                key={entry}
                type="button"
                className={`option${theme === entry ? ' option--on' : ''}`}
                onClick={() => setTheme(entry)}
              >
                <b>{t(`settings.theme.${entry}` as TranslationKey)}</b>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="card-row">
        <section className="card">
          <h2 className="card__title">{t('settings.account')}</h2>
          <div className="stat-row">
            <span>{user ? (lang === 'ar' ? user.displayNameAr ?? user.displayName : user.displayName) : ''}</span>
            <b className="mono">{user?.email}</b>
          </div>
          <div className="stat-row">
            <span>{t('settings.role')}</span>
            <b>{user ? t(`settings.role.${roleKey ?? user.role}` as TranslationKey) : ''}</b>
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">{t('settings.dataTitle')}</h2>
          <p className="card__hint">{t('settings.dataHint')}</p>
          <div className="page__actions">
            <button type="button" className="btn" onClick={() => setDialog(true)}>
              {t('settings.viewJson')}
            </button>
            <button type="button" className="btn" onClick={() => download(DATASET_FILE, problemJson)}>
              {t('dialog.download')}
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              {t('header.import')}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                resetSample()
                setToast(t('toast.reset'))
              }}
            >
              {t('header.reset')}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                importProblem(file, (result) => {
                  if (result.startsWith('OK:')) {
                    setToast(t('toast.imported', { count: n(Number(result.slice(3))) }))
                  } else if (result === 'NEEDS_ARRAYS') {
                    setToast(t('toast.needArrays'))
                  } else {
                    setToast(t('toast.importFailed'))
                  }
                })
              }
              event.target.value = ''
            }}
          />
        </section>
      </div>

      <div className="card-row">
        <SyncCard />
      </div>

      {dialog && (
        <JsonDialog
          title={t('dialog.problemTitle')}
          subtitle={t('dialog.problemSubtitle', {
            lessons: n(problem.lessons.length),
            slots: n(problem.timeslots.length),
            rooms: n(problem.rooms.length),
          })}
          json={problemJson}
          filename={DATASET_FILE}
          onClose={() => setDialog(false)}
          onDownload={download}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

/* -------------------------------------------------------------------- sync */

function SyncCard() {
  const { t } = useI18n()
  const { syncSettings, setSyncSettings } = useApp()
  const [revealKey, setRevealKey] = useState(false)
  const usingApiKey = Boolean(syncSettings.apiKey)

  return (
    <section className="card">
      <h2 className="card__title">{t('sync.title')}</h2>
      <p className="card__hint">{t('sync.hint')}</p>
      <div className="field-grid">
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>{t('sync.baseUrl')}</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://api.example.school"
            value={syncSettings.baseUrl}
            onChange={(event) =>
              setSyncSettings({ ...syncSettings, baseUrl: event.target.value })
            }
          />
        </label>
        <label className="field">
          <span>{t('sync.schoolId')}</span>
          <input
            className="input"
            value={syncSettings.schoolId}
            onChange={(event) =>
              setSyncSettings({ ...syncSettings, schoolId: event.target.value })
            }
          />
        </label>
      </div>

      <h3 className="card__subtitle">{t('sync.apiKeySection')}</h3>
      <p className="card__hint">{t('sync.apiKeyHint')}</p>
      <label className="field">
        <span>{t('sync.apiKey')}</span>
        <div className="input-affix">
          <input
            className="input"
            type={revealKey ? 'text' : 'password'}
            autoComplete="off"
            placeholder="sk_live_…"
            value={syncSettings.apiKey ?? ''}
            onChange={(event) =>
              setSyncSettings({ ...syncSettings, apiKey: event.target.value || undefined })
            }
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setRevealKey(!revealKey)}
            aria-label={revealKey ? t('login.hidePassword') : t('login.showPassword')}
          >
            {revealKey ? '🙈' : '👁'}
          </button>
        </div>
      </label>

      <p className="card__hint" style={{ margin: '10px 0 0' }}>
        {usingApiKey ? t('sync.usingApiKey') : t('sync.usingSession')}
      </p>
      <p className="card__hint" style={{ margin: '6px 0 0' }}>
        {t('sync.apiKeyConsoleNote')}
      </p>
    </section>
  )
}

/* --------------------------------------------------------------- transport */

function TransportSettingsTab() {
  const { t } = useI18n()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('fleet.rules')}</h2>
        <p className="card__hint">{t('fleet.rulesHint')}</p>
        <RoutingRulesEditor />
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ tuning */

function TuningSettingsTab() {
  const { t } = useI18n()
  const { problem, setProblem } = useApp()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('tuning.title')}</h2>
        <p className="card__hint">{t('tuning.hint')}</p>
        <ConstraintWeightsEditor problem={problem} onChange={setProblem} />
      </section>
    </div>
  )
}

/* ---------------------------------------------------------------- calendar */

function CalendarSettingsTab() {
  const { t } = useI18n()
  const { problem, setProblem } = useApp()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('calendar.weekTitle')}</h2>
        <SchoolWeekFields problem={problem} onChange={setProblem} />
      </section>

      <section className="card">
        <h2 className="card__title">{t('calendar.breaks')}</h2>
        <BreaksEditor />
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------- team */

const MEMBER_ROLES: MemberRole[] = ['owner', 'admin', 'scheduler', 'viewer']

/** Ranks and named presets in one picker (SAMS 1.8). Owner is offered only
 * to an owner — the server refuses it to anyone else anyway. */
function RoleSelect(props: {
  value: RoleChoice
  onChange: (next: RoleChoice) => void
  allowOwner: boolean
  disabled?: boolean
}) {
  const { t } = useI18n()
  return (
    <select
      className="select"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value as RoleChoice)}
    >
      <optgroup label={t('team.group.ranks')}>
        {MEMBER_ROLES.filter((r) => r !== 'owner' || props.allowOwner || props.value === 'owner').map((r) => (
          <option key={r} value={r}>
            {t(`settings.role.${r}`)}
          </option>
        ))}
      </optgroup>
      <optgroup label={t('team.group.presets')}>
        {ROLE_KEYS.map((k) => (
          <option key={k} value={k}>
            {t(`settings.role.${k}`)}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

/** A preset confined to branches defaults to the active branch. */
const BRANCH_CONFINED: RoleChoice[] = ['branch_admin']

function TeamSettingsTab() {
  const { t } = useI18n()
  const { user, getAccessToken } = useAuth()
  const { branches, activeBranchId } = useApp()
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null)
  const [members, setMembers] = useState<Member[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<RoleChoice>('scheduler')
  const [busy, setBusy] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [rowError, setRowError] = useState<{ userId: string; text: string } | null>(null)

  const selectedScopes =
    catalog &&
    (catalog.presets.find((p) => p.key === role)?.scopes ?? catalog.ranks.find((r) => r.rank === role)?.scopes ?? null)

  const refresh = async () => {
    const token = await getAccessToken()
    if (!token) return
    const result = await listMembers(getAccessToken)
    if (result.kind === 'ok') {
      setMembers(result.data)
      setLoadError(null)
    } else {
      setLoadError(result.error)
    }
  }

  useEffect(() => {
    void getRoleCatalog(getAccessToken).then((result) => {
      if (result.kind === 'ok') setCatalog(result.data)
    })
    void refresh()
    // Load once when this tab mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const invite = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setInviteMsg(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const branchIds = BRANCH_CONFINED.includes(role) && activeBranchId ? [activeBranchId] : undefined
    const result = await inviteMember(getAccessToken, email.trim(), role, branchIds)
    setBusy(false)
    if (result.kind === 'ok') {
      const outcome = result.data.outcome
      const text =
        outcome === 'invited'
          ? t('team.outcomeInvited')
          : outcome === 'added'
            ? t('team.outcomeAdded')
            : t('team.outcomeAlready')
      setInviteMsg({ text, kind: outcome === 'already_member' ? 'error' : 'success' })
      setEmail('')
      void refresh()
      return
    }
    const key: TranslationKey =
      result.error === 'FORBIDDEN' || result.error === 'SCOPE_ESCALATION'
        ? 'team.errorForbidden'
        : result.error === 'BRANCHES_REQUIRED'
          ? 'team.branchAdminHint'
        : result.error === 'EMAIL_NOT_CONFIGURED'
          ? 'team.errorEmailNotConfigured'
          : result.error === 'EMAIL_SEND_FAILED'
            ? 'team.errorEmailSendFailed'
            : 'login.errorNetwork'
    setInviteMsg({ text: t(key), kind: 'error' })
  }

  const setRoleFor = async (member: Member, nextRole: RoleChoice) => {
    setRowError(null)
    const token = await getAccessToken()
    if (!token) return
    const branchIds =
      BRANCH_CONFINED.includes(nextRole) && !member.branchIds && activeBranchId ? [activeBranchId] : undefined
    const result = await changeMemberRole(getAccessToken, member.userId, nextRole, branchIds)
    if (result.kind === 'ok') {
      void refresh()
      return
    }
    const text =
      result.error === 'CANNOT_DEMOTE_LAST_OWNER'
        ? t('team.errorLastOwner')
        : result.error === 'FORBIDDEN' || result.error === 'SCOPE_ESCALATION'
          ? t('team.errorForbidden')
          : result.error === 'BRANCHES_REQUIRED'
            ? t('team.branchAdminHint')
            : t('login.errorNetwork')
    setRowError({ userId: member.userId, text })
  }

  const setBranchesFor = async (member: Member, branchIds: string[] | null) => {
    setRowError(null)
    setMembers((current) =>
      (current ?? []).map((m) => (m.userId === member.userId ? { ...m, branchIds } : m)),
    )
    const token = await getAccessToken()
    if (!token) return
    const result = await setMemberBranches(getAccessToken, member.userId, branchIds)
    if (result.kind === 'ok') void refresh()
    else setRowError({ userId: member.userId, text: t('login.errorNetwork') })
  }

  const remove = async (member: Member) => {
    if (!window.confirm(t('team.confirmRemove', { name: member.displayName ?? member.email ?? '' }))) return
    setRowError(null)
    const token = await getAccessToken()
    if (!token) return
    const result = await removeMember(getAccessToken, member.userId)
    if (result.kind === 'ok') {
      void refresh()
      return
    }
    const text = result.error === 'CANNOT_REMOVE_LAST_OWNER' ? t('team.errorLastOwner') : t('login.errorNetwork')
    setRowError({ userId: member.userId, text })
  }

  return (
    <div className="card-row">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="card__title">{t('team.title')}</h2>
        <p className="card__hint">{t('team.hint')}</p>

        {loadError && <p className="login__error">{loadError}</p>}

        {members && members.length > 0 && (
          <table className="table" style={{ marginBottom: 14 }}>
            <thead>
              <tr>
                <th>{t('team.email')}</th>
                <th>{t('team.name')}</th>
                <th>{t('team.role')}</th>
                {branches.length > 1 && <th>{t('nav.branch')}</th>}
                <th>{t('team.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = member.userId === user?.id
                return (
                  <tr key={member.userId}>
                    <td>{member.email ?? '—'}</td>
                    <td>{member.displayName ?? '—'}</td>
                    <td>
                      <RoleSelect
                        value={member.roleKey ?? member.role}
                        disabled={isSelf}
                        allowOwner={user?.role === 'owner'}
                        onChange={(next) => void setRoleFor(member, next)}
                      />
                    </td>
                    {branches.length > 1 && (
                      <td>
                        <details>
                          <summary style={{ cursor: 'pointer' }}>
                            {member.branchIds === null
                              ? t('team.allBranches')
                              : t('team.someBranches', { n: member.branchIds.length })}
                          </summary>
                          <label className="inline-field" style={{ display: 'flex' }}>
                            <input
                              type="checkbox"
                              checked={member.branchIds === null}
                              onChange={(event) =>
                                void setBranchesFor(member, event.target.checked ? null : [])
                              }
                            />
                            {t('team.allBranches')}
                          </label>
                          {branches.map((branch) => {
                            const checked =
                              member.branchIds === null || member.branchIds.includes(branch.id)
                            return (
                              <label
                                key={branch.id}
                                className="inline-field"
                                style={{ display: 'flex' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={member.branchIds === null}
                                  onChange={(event) => {
                                    const base = member.branchIds ?? []
                                    const next = event.target.checked
                                      ? [...base, branch.id]
                                      : base.filter((id) => id !== branch.id)
                                    void setBranchesFor(member, next.length === 0 ? [] : next)
                                  }}
                                />
                                {branch.name}
                              </label>
                            )
                          })}
                        </details>
                      </td>
                    )}
                    <td>{member.active ? t('team.active') : t('team.invitedPending')}</td>
                    <td className="row-actions">
                      {!isSelf && (
                        <button type="button" className="icon-btn" onClick={() => void remove(member)}>
                          {t('team.remove')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {rowError && <p className="login__error">{rowError.text}</p>}

        <h3 className="card__subtitle">{t('team.inviteTitle')}</h3>
        <form className="break-card__row" onSubmit={invite}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            type="email"
            placeholder="teacher@school.test"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <RoleSelect value={role} onChange={setRole} allowOwner={user?.role === 'owner'} />
          <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !email.trim()}>
            {busy ? t('team.inviting') : t('team.invite')}
          </button>
        </form>
        {BRANCH_CONFINED.includes(role) && <p className="card__hint">{t('team.branchAdminHint')}</p>}
        {selectedScopes && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer' }}>{t('team.scopes', { n: selectedScopes.length })}</summary>
            <p className="card__hint" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {selectedScopes.join(' · ')}
            </p>
          </details>
        )}
        {inviteMsg && (
          <p className={inviteMsg.kind === 'success' ? 'login__success' : 'login__error'} style={{ marginTop: 8 }}>
            {inviteMsg.text}
          </p>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------ organization */

function OrganizationSettingsTab() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [tenant, setTenant] = useState<TenantProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await getTenant(getAccessToken)
      if (cancelled) return
      setLoading(false)
      if (result.kind === 'ok') setTenant(result.data)
      else setError(true)
    })()
    return () => {
      cancelled = true
    }
  }, [getAccessToken])

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('settings.organization')}</h2>
        <p className="card__hint">{t('settings.organizationHint')}</p>
        {loading && <p className="card__hint">{t('parents.loading')}</p>}
        {error && <p className="login__error">{t('settings.organization.loadError')}</p>}
        {tenant && (
          <>
            <div className="stat-row">
              <span>{t('settings.organization.name')}</span>
              <b>{tenant.name}</b>
            </div>
            <div className="stat-row">
              <span>{t('settings.organization.plan')}</span>
              <b>{tenant.plan}</b>
            </div>
            <div className="stat-row">
              <span>{t('settings.organization.status')}</span>
              <span className={`chip${tenant.status === 'active' ? ' chip--on' : ''}`}>
                {t(`settings.organization.status.${tenant.status}` as TranslationKey)}
              </span>
            </div>
            <div className="stat-row">
              <span>{t('settings.organization.validUntil')}</span>
              <b>{tenant.validUntil ?? t('settings.organization.noExpiry')}</b>
            </div>
            <div className="stat-row">
              <span>{t('settings.organization.graceDays')}</span>
              <b>{tenant.graceDays}</b>
            </div>
          </>
        )}
      </section>
      <OrganizationProfileCard />
    </div>
  )
}

/* ---------------------------------------------------------------- branches */

const WEEKDAY_KEYS: TranslationKey[] = [
  'dayShort.SUNDAY',
  'dayShort.MONDAY',
  'dayShort.TUESDAY',
  'dayShort.WEDNESDAY',
  'dayShort.THURSDAY',
  'dayShort.FRIDAY',
  'dayShort.SATURDAY',
]

function BranchesSettingsTab() {
  const { t } = useI18n()
  const { branches, activeBranchId } = useApp()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const branchId = selectedId ?? activeBranchId ?? branches[0]?.id ?? null

  return (
    <div className="card-row">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="card__title">{t('branches.title')}</h2>
        <p className="card__hint">{t('branches.subtitle')}</p>
        <p className="card__hint">{t('branches.readOnlyNote')}</p>

        {branches.length > 0 ? (
          <table className="table" style={{ marginBottom: 4 }}>
            <thead>
              <tr>
                <th>{t('branches.name')}</th>
                <th>{t('branches.code')}</th>
                <th>{t('branches.address')}</th>
                <th>{t('branches.timezone')}</th>
                <th>{t('branches.active')}</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((branch) => (
                <tr key={branch.id}>
                  <td>{branch.name}</td>
                  <td className="mono">{branch.code}</td>
                  <td>{branch.address ?? '—'}</td>
                  <td className="mono">{branch.timezone}</td>
                  <td>{branch.active ? t('branches.active') : t('classes.inactive')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="card__hint">{t('branches.none')}</p>
        )}
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="card__title">{t('notify.title')}</h2>
        <p className="card__hint">{t('notify.subtitle')}</p>
        {!branchId && <p className="card__hint">{t('notify.noBranch')}</p>}
        {branchId && (
          <>
            {branches.length > 1 && (
              <label className="field" style={{ maxWidth: 260 }}>
                <span>{t('nav.branch')}</span>
                <select
                  className="input"
                  value={branchId}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SchoolCalendarForm key={`cal-${branchId}`} branchId={branchId} />
            <NotificationSettingsForm key={branchId} branchId={branchId} />
          </>
        )}
      </section>
    </div>
  )
}

function SchoolCalendarForm({ branchId }: { branchId: string }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [cal, setCal] = useState<SchoolCalendar | null>(null)
  const [msg, setMsg] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayName, setHolidayName] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const token = await getAccessToken()
      if (!token) return
      const result = await getSchoolCalendar(getAccessToken, branchId)
      if (!cancelled && result.kind === 'ok') setCal(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [branchId, getAccessToken])

  if (!cal) return null

  const toggleDay = (day: number) =>
    setCal((c) =>
      c
        ? {
            ...c,
            workingDays: c.workingDays.includes(day)
              ? c.workingDays.filter((d) => d !== day)
              : [...c.workingDays, day].sort((a, b) => a - b),
          }
        : c,
    )

  const addHoliday = () => {
    if (!holidayDate || !holidayName.trim()) return
    setCal((c) =>
      c
        ? {
            ...c,
            holidays: [...c.holidays.filter((h) => h.date !== holidayDate), { date: holidayDate, name: holidayName.trim() }].sort(
              (a, b) => a.date.localeCompare(b.date),
            ),
          }
        : c,
    )
    setHolidayDate('')
    setHolidayName('')
  }

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const token = await getAccessToken()
    if (!token) return setBusy(false)
    const result = await putSchoolCalendar(getAccessToken, branchId, cal)
    setBusy(false)
    setMsg(
      result.kind === 'ok'
        ? { text: t('notify.saved'), kind: 'success' }
        : { text: t('notify.saveError'), kind: 'error' },
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 620, marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid var(--line)' }}>
      <h3 className="card__subtitle" style={{ margin: 0 }}>{t('calendar.title')}</h3>
      <p className="card__hint" style={{ margin: 0 }}>{t('calendar.hint')}</p>
      <div>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('notify.schoolDays')}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {WEEKDAY_KEYS.map((dayKey, day) => (
            <label key={day} className="inline-field">
              <input type="checkbox" checked={cal.workingDays.includes(day)} onChange={() => toggleDay(day)} />
              {t(dayKey)}
            </label>
          ))}
        </div>
      </div>
      <div>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('calendar.holidays')}</span>
        {cal.holidays.length > 0 && (
          <ul style={{ margin: '4px 0', paddingInlineStart: 18 }}>
            {cal.holidays.map((h) => (
              <li key={h.date}>
                {h.date} — {h.name}{' '}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setCal((c) => (c ? { ...c, holidays: c.holidays.filter((x) => x.date !== h.date) } : c))}
                  aria-label={`${t('classes.delete')} ${h.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="break-card__row" style={{ marginTop: 4 }}>
          <input type="date" className="input input--sm" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
          <input
            className="input input--sm"
            style={{ minWidth: 160 }}
            placeholder={t('calendar.holidayName')}
            value={holidayName}
            onChange={(e) => setHolidayName(e.target.value)}
          />
          <button type="button" className="btn btn--sm" onClick={addHoliday}>
            {t('calendar.addHoliday')}
          </button>
        </div>
      </div>
      <div>
        <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void save()}>
          {t('calendar.save')}
        </button>
      </div>
      {msg && <p className={msg.kind === 'success' ? 'login__success' : 'login__error'}>{msg.text}</p>}
    </div>
  )
}

function NotificationSettingsForm({ branchId }: { branchId: string }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const [msg, setMsg] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const token = await getAccessToken()
      if (!token) return
      const result = await getNotificationSettings(getAccessToken, branchId)
      if (!cancelled && result.kind === 'ok') setSettings(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [branchId, getAccessToken])

  if (!settings) return <p className="card__hint">…</p>

  const set = <K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current))

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const { lastSweptDate: _drop, ...body } = settings
    const result = await putNotificationSettings(getAccessToken, branchId, body)
    setBusy(false)
    setMsg(
      result.kind === 'ok'
        ? { text: t('notify.saved'), kind: 'success' }
        : { text: t('notify.saveError'), kind: 'error' },
    )
  }

  const runNow = async () => {
    setBusy(true)
    setMsg(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const result = await runAbsenceNotifications(getAccessToken, { branchId })
    setBusy(false)
    if (result.kind === 'ok') {
      const { delivered, dead, alreadyQueued } = result.data
      setMsg({
        text: t('attendance.notifySent', { sent: delivered, failed: dead, skipped: alreadyQueued }),
        kind: dead > 0 ? 'error' : 'success',
      })
    } else {
      setMsg({ text: result.error, kind: 'error' })
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 620 }}>
      <label className="inline-field" style={{ display: 'flex' }}>
        <input
          type="checkbox"
          checked={settings.absenceNotifyEnabled}
          onChange={(event) => set('absenceNotifyEnabled', event.target.checked)}
        />
        {t('notify.enabled')}
      </label>

      <label className="field" style={{ maxWidth: 200 }}>
        <span>{t('notify.cutoff')}</span>
        <input
          type="time"
          className="input"
          value={settings.cutoffTime}
          onChange={(event) => set('cutoffTime', event.target.value)}
        />
      </label>

      <label className="inline-field" style={{ display: 'flex' }}>
        <input
          type="checkbox"
          checked={settings.notifyOnUnmarked}
          onChange={(event) => set('notifyOnUnmarked', event.target.checked)}
        />
        {t('notify.unmarked')}
      </label>

      <div>
        <span className="field__label" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {t('notify.channelEmail')}
        </span>
        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          <label className="inline-field">
            <input
              type="checkbox"
              checked={settings.channels.includes('email')}
              onChange={(event) =>
                set(
                  'channels',
                  event.target.checked
                    ? [...new Set([...settings.channels, 'email' as const])]
                    : settings.channels.filter((c) => c !== 'email'),
                )
              }
            />
            {t('notify.channelEmail')}
          </label>
          <label className="inline-field" style={{ opacity: 0.6 }}>
            <input
              type="checkbox"
              checked={settings.channels.includes('sms')}
              onChange={(event) =>
                set(
                  'channels',
                  event.target.checked
                    ? [...new Set([...settings.channels, 'sms' as const])]
                    : settings.channels.filter((c) => c !== 'sms'),
                )
              }
            />
            {t('notify.channelSms')}
          </label>
        </div>
      </div>

      <label className="field">
        <span>{t('notify.emailSubject')}</span>
        <input
          className="input"
          value={settings.emailSubject}
          onChange={(event) => set('emailSubject', event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('notify.emailBody')}</span>
        <textarea
          className="input"
          rows={6}
          value={settings.emailBody}
          onChange={(event) => set('emailBody', event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('notify.smsBody')}</span>
        <textarea
          className="input"
          rows={2}
          value={settings.smsBody}
          onChange={(event) => set('smsBody', event.target.value)}
        />
      </label>

      <p className="card__hint" style={{ marginBottom: 0 }}>{t('notify.arHint')}</p>
      <label className="field">
        <span>{t('notify.emailSubjectAr')}</span>
        <input
          className="input"
          dir="rtl"
          value={settings.emailSubjectAr}
          onChange={(event) => set('emailSubjectAr', event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('notify.emailBodyAr')}</span>
        <textarea
          className="input"
          dir="rtl"
          rows={6}
          value={settings.emailBodyAr}
          onChange={(event) => set('emailBodyAr', event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('notify.smsBodyAr')}</span>
        <textarea
          className="input"
          dir="rtl"
          rows={2}
          value={settings.smsBodyAr}
          onChange={(event) => set('smsBodyAr', event.target.value)}
        />
      </label>

      <p className="card__hint">{t('notify.tokens')}</p>
      <p className="card__hint">
        {settings.lastSweptDate
          ? t('notify.lastSwept', { date: settings.lastSweptDate })
          : t('notify.lastSwept.never')}
      </p>

      <div className="break-card__row">
        <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void save()}>
          {t('notify.save')}
        </button>
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void runNow()}>
          {t('notify.runNow')}
        </button>
      </div>
      {msg && (
        <p className={msg.kind === 'success' ? 'login__success' : 'login__error'}>{msg.text}</p>
      )}
    </div>
  )
}
