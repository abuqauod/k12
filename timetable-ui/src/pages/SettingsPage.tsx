import { useMemo, useRef, useState, useEffect } from 'react'
import { useApp } from '../state/AppContext'
import type { Theme } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { LANGUAGES } from '../i18n/translations'
import type { TranslationKey } from '../i18n/translations'
import { download, toProblemPayload } from '../lib/api'
import { createApiKey, listApiKeys, revokeApiKey } from '../lib/apiKeys'
import type { ApiKeyRole, ApiKeySummary } from '../lib/apiKeys'
import {
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
  setMemberBranches,
} from '../lib/memberships'
import type { Member, MemberRole } from '../lib/memberships'
import { createBranch, updateBranch } from '../lib/branchesApi'
import {
  getNotificationSettings,
  putNotificationSettings,
  runAbsenceNotifications,
} from '../lib/notificationsApi'
import type { NotificationSettings } from '../lib/notificationsApi'
import { SchoolWeekFields } from '../components/SchoolWeekFields'
import { ConstraintWeightsEditor } from '../components/ConstraintWeights'
import { RoutingRulesEditor } from '../components/RoutingRules'
import { BreaksEditor } from '../components/BreaksEditor'
import { JsonDialog } from '../components/JsonDialog'

const THEMES: Theme[] = ['auto', 'light', 'dark']

type SettingsTab = 'account' | 'calendar' | 'transport' | 'tuning' | 'team' | 'branches'

const BASE_TABS: Array<{ id: SettingsTab; key: TranslationKey }> = [
  { id: 'account', key: 'settings.tab.account' },
  { id: 'calendar', key: 'settings.tab.calendar' },
  { id: 'transport', key: 'fleet.rules' },
  { id: 'tuning', key: 'panel.tuning' },
]

export function SettingsPage() {
  const { t } = useI18n()
  const { user } = useAuth()
  const [tab, setTab] = useState<SettingsTab>('account')
  // Staff management is an admin+ concern — a scheduler/viewer has no use
  // for it and the API would refuse them anyway (requireRole('admin')).
  const canManageTeam = user?.role === 'owner' || user?.role === 'admin'
  const tabs = canManageTeam
    ? [
        ...BASE_TABS,
        { id: 'branches' as const, key: 'branches.title' as TranslationKey },
        { id: 'team' as const, key: 'settings.tab.team' as TranslationKey },
      ]
    : BASE_TABS

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('settings.title')}</h1>
          <p className="page__subtitle">{t('settings.subtitle')}</p>
        </div>
      </header>

      <div className="page-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.key)}
          </button>
        ))}
      </div>

      {tab === 'account' && <AccountTab />}
      {tab === 'calendar' && <CalendarSettingsTab />}
      {tab === 'transport' && <TransportSettingsTab />}
      {tab === 'tuning' && <TuningSettingsTab />}
      {tab === 'branches' && canManageTeam && <BranchesSettingsTab />}
      {tab === 'team' && canManageTeam && <TeamSettingsTab />}
    </div>
  )
}

/* ----------------------------------------------------------------- account */

const DATASET_FILE = 'timetable-problem.json'

function AccountTab() {
  const { t, n, lang, setLang } = useI18n()
  const { user } = useAuth()
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
            <b>{user ? t(`settings.role.${user.role}` as TranslationKey) : ''}</b>
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
  const { user, getAccessToken } = useAuth()
  const [revealKey, setRevealKey] = useState(false)
  const usingApiKey = Boolean(syncSettings.apiKey)
  const canManageKeys = user?.role === 'owner' || user?.role === 'admin'

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

      {canManageKeys && (
        <ApiKeyManager
          onUseKey={(key) => setSyncSettings({ ...syncSettings, apiKey: key })}
          getAccessToken={getAccessToken}
        />
      )}
    </section>
  )
}

function ApiKeyManager({
  onUseKey,
  getAccessToken,
}: {
  onUseKey: (key: string) => void
  getAccessToken: (force?: boolean) => Promise<string | null>
}) {
  const { t } = useI18n()
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState<ApiKeyRole>('scheduler')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = async () => {
    const token = await getAccessToken()
    if (!token) return
    const result = await listApiKeys(token)
    if (result.kind === 'ok') setKeys(result.data)
  }

  useEffect(() => {
    void refresh()
    // Load once when this section mounts (only shown to admin+).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const result = await createApiKey(token, name.trim(), role)
    setBusy(false)
    if (result.kind === 'ok') {
      setJustCreated({ key: result.data.key, name: name.trim() })
      setName('')
      void refresh()
      return
    }
    setError(result.error)
  }

  const revoke = async (id: string) => {
    const token = await getAccessToken()
    if (!token) return
    await revokeApiKey(token, id)
    void refresh()
  }

  const copyToClipboard = () => {
    if (!justCreated) return
    navigator.clipboard.writeText(justCreated.key).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
      <h3 className="card__subtitle" style={{ margin: '0 0 8px' }}>
        {t('sync.keysTitle')}
      </h3>

      {justCreated && (
        <div className="login__success" style={{ marginBottom: 10 }}>
          <p style={{ margin: '0 0 6px' }}>{t('sync.keyCreated', { name: justCreated.name })}</p>
          <code className="mono" style={{ wordBreak: 'break-all' }}>
            {justCreated.key}
          </code>
          <div className="page__actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={copyToClipboard}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                onUseKey(justCreated.key)
                setJustCreated(null)
              }}
            >
              {t('sync.useThisKey')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setJustCreated(null)}>
              {t('sync.dismiss')}
            </button>
          </div>
        </div>
      )}

      {keys && keys.length > 0 && (
        <table className="table" style={{ marginBottom: 10 }}>
          <thead>
            <tr>
              <th>{t('sync.keyName')}</th>
              <th>{t('sync.keyPreview')}</th>
              <th>{t('sync.keyRole')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="mono">{k.preview}</td>
                <td>{t(`settings.role.${k.role}` as TranslationKey)}</td>
                <td className="row-actions">
                  {k.revoked ? (
                    <span className="chip">{t('sync.keyRevoked')}</span>
                  ) : (
                    <button type="button" className="icon-btn" onClick={() => void revoke(k.id)}>
                      {t('sync.revoke')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="break-card__row" onSubmit={create} style={{ margin: 0 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 120 }}
          placeholder={t('sync.keyNamePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select className="select" value={role} onChange={(event) => setRole(event.target.value as ApiKeyRole)}>
          <option value="admin">{t('settings.role.admin')}</option>
          <option value="scheduler">{t('settings.role.scheduler')}</option>
          <option value="viewer">{t('settings.role.viewer')}</option>
        </select>
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !name.trim()}>
          {busy ? t('sync.creating') : t('sync.newKey')}
        </button>
      </form>
      {error && (
        <p className="login__error" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </div>
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

function TeamSettingsTab() {
  const { t } = useI18n()
  const { user, getAccessToken } = useAuth()
  const { branches } = useApp()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('scheduler')
  const [busy, setBusy] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [rowError, setRowError] = useState<{ userId: string; text: string } | null>(null)

  const refresh = async () => {
    const token = await getAccessToken()
    if (!token) return
    const result = await listMembers(token)
    if (result.kind === 'ok') {
      setMembers(result.data)
      setLoadError(null)
    } else {
      setLoadError(result.error)
    }
  }

  useEffect(() => {
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
    const result = await inviteMember(token, email.trim(), role)
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
      result.error === 'FORBIDDEN'
        ? 'team.errorForbidden'
        : result.error === 'EMAIL_NOT_CONFIGURED'
          ? 'team.errorEmailNotConfigured'
          : result.error === 'EMAIL_SEND_FAILED'
            ? 'team.errorEmailSendFailed'
            : 'login.errorNetwork'
    setInviteMsg({ text: t(key), kind: 'error' })
  }

  const setRoleFor = async (member: Member, nextRole: MemberRole) => {
    setRowError(null)
    const token = await getAccessToken()
    if (!token) return
    const result = await changeMemberRole(token, member.userId, nextRole)
    if (result.kind === 'ok') {
      void refresh()
      return
    }
    const text =
      result.error === 'CANNOT_DEMOTE_LAST_OWNER'
        ? t('team.errorLastOwner')
        : result.error === 'FORBIDDEN'
          ? t('team.errorForbidden')
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
    const result = await setMemberBranches(token, member.userId, branchIds)
    if (result.kind === 'ok') void refresh()
    else setRowError({ userId: member.userId, text: t('login.errorNetwork') })
  }

  const remove = async (member: Member) => {
    if (!window.confirm(t('team.confirmRemove', { name: member.displayName ?? member.email ?? '' }))) return
    setRowError(null)
    const token = await getAccessToken()
    if (!token) return
    const result = await removeMember(token, member.userId)
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
                      <select
                        className="select"
                        value={member.role}
                        disabled={isSelf}
                        onChange={(event) => void setRoleFor(member, event.target.value as MemberRole)}
                      >
                        {MEMBER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {t(`settings.role.${r}`)}
                          </option>
                        ))}
                      </select>
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
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as MemberRole)}>
            {MEMBER_ROLES.filter((r) => r !== 'owner' || user?.role === 'owner').map((r) => (
              <option key={r} value={r}>
                {t(`settings.role.${r}`)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !email.trim()}>
            {busy ? t('team.inviting') : t('team.invite')}
          </button>
        </form>
        {inviteMsg && (
          <p className={inviteMsg.kind === 'success' ? 'login__success' : 'login__error'} style={{ marginTop: 8 }}>
            {inviteMsg.text}
          </p>
        )}
      </section>
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
  const { getAccessToken } = useAuth()
  const { branches, activeBranchId, reloadBranches } = useApp()

  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const branchId = selectedId ?? activeBranchId ?? branches[0]?.id ?? null

  const addBranch = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !code.trim()) return
    setBusy(true)
    setError(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const result = await createBranch(token, {
      name: name.trim(),
      code: code.trim().toLowerCase(),
      address: null,
      timezone: 'Asia/Amman',
    })
    setBusy(false)
    if (result.kind === 'ok') {
      setName('')
      setCode('')
      void reloadBranches()
    } else {
      setError(t('branches.saveError'))
    }
  }

  const patchBranch = async (id: string, changes: Parameters<typeof updateBranch>[2]) => {
    const token = await getAccessToken()
    if (!token) return
    const result = await updateBranch(token, id, changes)
    if (result.kind === 'ok') void reloadBranches()
    else setError(t('branches.saveError'))
  }

  return (
    <div className="card-row">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="card__title">{t('branches.title')}</h2>
        <p className="card__hint">{t('branches.subtitle')}</p>
        {error && <p className="login__error">{error}</p>}

        {branches.length > 0 && (
          <table className="table" style={{ marginBottom: 14 }}>
            <thead>
              <tr>
                <th>{t('branches.name')}</th>
                <th>{t('branches.code')}</th>
                <th>{t('branches.timezone')}</th>
                <th>{t('branches.active')}</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((branch) => (
                <tr key={branch.id}>
                  <td>
                    <input
                      className="cell-input"
                      defaultValue={branch.name}
                      onBlur={(event) => {
                        const next = event.target.value.trim()
                        if (next && next !== branch.name) void patchBranch(branch.id, { name: next })
                      }}
                    />
                  </td>
                  <td className="mono">{branch.code}</td>
                  <td>
                    <input
                      className="cell-input"
                      defaultValue={branch.timezone}
                      onBlur={(event) => {
                        const next = event.target.value.trim()
                        if (next && next !== branch.timezone) void patchBranch(branch.id, { timezone: next })
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={branch.active}
                      onChange={(event) => void patchBranch(branch.id, { active: event.target.checked })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {branches.length === 0 && <p className="card__hint">{t('branches.none')}</p>}

        <h3 className="card__subtitle">{t('branches.add')}</h3>
        <form className="break-card__row" onSubmit={addBranch}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 140 }}
            placeholder={t('branches.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="input"
            style={{ minWidth: 120 }}
            placeholder={t('branches.code')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !name.trim() || !code.trim()}>
            {t('branches.add')}
          </button>
        </form>
        <p className="card__hint">{t('branches.codeHint')}</p>
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
            <NotificationSettingsForm key={branchId} branchId={branchId} />
          </>
        )}
      </section>
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
      const result = await getNotificationSettings(token, branchId)
      if (!cancelled && result.kind === 'ok') setSettings(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [branchId, getAccessToken])

  if (!settings) return <p className="card__hint">…</p>

  const set = <K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current))

  const toggleDay = (day: number) =>
    set(
      'schoolDays',
      settings.schoolDays.includes(day)
        ? settings.schoolDays.filter((d) => d !== day)
        : [...settings.schoolDays, day].sort((a, b) => a - b),
    )

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const { lastSweptDate: _drop, ...body } = settings
    const result = await putNotificationSettings(token, branchId, body)
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
    const result = await runAbsenceNotifications(token, { branchId })
    setBusy(false)
    if (result.kind === 'ok') {
      const { sent, failed, skipped } = result.data
      setMsg({
        text: t('attendance.notifySent', { sent, failed, skipped }),
        kind: failed > 0 ? 'error' : 'success',
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
          {t('notify.schoolDays')}
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {WEEKDAY_KEYS.map((dayKey, day) => (
            <label key={day} className="inline-field">
              <input
                type="checkbox"
                checked={settings.schoolDays.includes(day)}
                onChange={() => toggleDay(day)}
              />
              {t(dayKey)}
            </label>
          ))}
        </div>
      </div>

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
