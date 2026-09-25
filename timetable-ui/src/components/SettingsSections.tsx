import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { getTenant, updateTenantProfile } from '../lib/tenantApi'
import type { ContactProfile } from '../lib/tenantApi'
import { createAcademicYear, listAcademicYears, setCurrentAcademicYear } from '../lib/academicYearsApi'
import type { AcademicYear } from '../lib/academicYearsApi'
import { getRoleCatalog } from '../lib/memberships'
import type { RoleCatalog } from '../lib/memberships'

/* Settings sections added by SAMS 1.11. Each is self-contained: it loads its
 * own data and shows loading / empty / error states. */

const PROFILE_FIELDS: Array<{ key: keyof ContactProfile; label: TranslationKey; type?: string; dir?: 'rtl' }> = [
  { key: 'nameAr', label: 'settings.profile.nameAr', dir: 'rtl' },
  { key: 'phone', label: 'settings.profile.phone', type: 'tel' },
  { key: 'email', label: 'settings.profile.email', type: 'email' },
  { key: 'website', label: 'settings.profile.website', type: 'url' },
  { key: 'address', label: 'settings.profile.address' },
  { key: 'taxNumber', label: 'settings.profile.taxNumber' },
]

const EMPTY_PROFILE: ContactProfile = {
  nameAr: null,
  phone: null,
  email: null,
  address: null,
  website: null,
  taxNumber: null,
}

/** The school's own contact details — editable with settings.manage. */
export function OrganizationProfileCard() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canManage = can('settings.manage')
  const [profile, setProfile] = useState<ContactProfile | null>(null)
  const [draft, setDraft] = useState<ContactProfile | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getTenant(getAccessToken).then((result) => {
      if (result.kind === 'ok') {
        // Older servers omit profile — treat it as blank rather than hang.
        const loaded = { ...EMPTY_PROFILE, ...result.data.profile }
        setProfile(loaded)
        setDraft(loaded)
      } else setStatus({ kind: 'error', text: t('settings.organization.loadError') })
    })
  }, [getAccessToken, t])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft) return
    setBusy(true)
    const result = await updateTenantProfile(getAccessToken, draft)
    setBusy(false)
    if (result.kind === 'ok') {
      setProfile(result.data.profile)
      setDraft(result.data.profile)
      setStatus({ kind: 'ok', text: t('settings.profile.saved') })
    } else {
      setStatus({ kind: 'error', text: t('settings.profile.saveError') })
    }
  }

  const dirty = JSON.stringify(profile) !== JSON.stringify(draft)

  return (
    <section className="card" aria-labelledby="org-profile">
      <h2 id="org-profile" className="card__title">
        {t('settings.profile.title')}
      </h2>
      <p className="card__hint">{t(canManage ? 'settings.profile.hint' : 'settings.profile.readOnly')}</p>
      {!draft ? (
        !status && (
          <p className="card__hint" aria-busy="true">
            <span className="skeleton" />
          </p>
        )
      ) : (
        <form className="field-grid" onSubmit={save}>
          {PROFILE_FIELDS.map((field) => (
            <label key={field.key} className="field">
              <span>{t(field.label)}</span>
              <input
                className="input"
                type={field.type ?? 'text'}
                dir={field.dir}
                value={draft[field.key] ?? ''}
                readOnly={!canManage}
                onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value || null })}
              />
            </label>
          ))}
          {canManage && (
            <div className="page__actions">
              <button type="submit" className="btn btn--primary" disabled={busy || !dirty}>
                {t('settings.profile.save')}
              </button>
            </div>
          )}
        </form>
      )}
      {status && (
        <p className={status.kind === 'ok' ? 'login__success' : 'login__error'} role="status">
          {status.text}
        </p>
      )}
    </section>
  )
}

/** Academic years — list, set current, create (academicYears.write). */
export function AcademicYearsSection() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canWrite = can('academicYears.write')
  const [years, setYears] = useState<AcademicYear[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const load = useCallback(async () => {
    const result = await listAcademicYears(getAccessToken)
    if (result.kind === 'ok') setYears(result.data)
    else setError(t('settings.years.loadError'))
  }, [getAccessToken, t])

  useEffect(() => {
    void load()
  }, [load])

  const makeCurrent = async (id: string) => {
    const result = await setCurrentAcademicYear(getAccessToken, id)
    if (result.kind !== 'ok') setError(t('settings.years.saveError'))
    void load()
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !start || !end) return
    if (end <= start) return setError(t('settings.years.rangeError'))
    const result = await createAcademicYear(getAccessToken, { name: name.trim(), startDate: start, endDate: end })
    if (result.kind !== 'ok') return setError(t('settings.years.saveError'))
    setName('')
    setStart('')
    setEnd('')
    setError(null)
    void load()
  }

  return (
    <section className="card" aria-labelledby="years-title">
      <h2 id="years-title" className="card__title">
        {t('settings.section.academicYears')}
      </h2>
      <p className="card__hint">{t('settings.years.hint')}</p>
      {years === null && !error ? (
        <p className="card__hint" aria-busy="true">
          <span className="skeleton" />
        </p>
      ) : years && years.length === 0 ? (
        <p className="card__empty">{t('settings.years.empty')}</p>
      ) : (
        years && (
          <table className="table">
            <thead>
              <tr>
                <th>{t('settings.years.name')}</th>
                <th>{t('settings.years.start')}</th>
                <th>{t('settings.years.end')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {years.map((year) => (
                <tr key={year.id}>
                  <td>{year.name}</td>
                  <td className="mono">{year.startDate}</td>
                  <td className="mono">{year.endDate}</td>
                  <td className="row-actions">
                    {year.current ? (
                      <span className="chip chip--ok">{t('settings.years.current')}</span>
                    ) : (
                      canWrite && (
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void makeCurrent(year.id)}>
                          {t('settings.years.makeCurrent')}
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {canWrite && (
        <form className="lookup__add" onSubmit={create}>
          <input
            className="input input--sm"
            placeholder={t('settings.years.namePlaceholder')}
            aria-label={t('settings.years.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input className="input input--sm" type="date" aria-label={t('settings.years.start')} value={start} onChange={(event) => setStart(event.target.value)} />
          <input className="input input--sm" type="date" aria-label={t('settings.years.end')} value={end} onChange={(event) => setEnd(event.target.value)} />
          <button type="submit" className="btn btn--sm btn--primary" disabled={!name.trim() || !start || !end}>
            {t('settings.years.add')}
          </button>
        </form>
      )}
      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** Read-only view of what each role preset may do (memberships.manage). */
export function RolesSection() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    void getRoleCatalog(getAccessToken).then((result) => {
      if (result.kind === 'ok') setCatalog(result.data)
      else setError(true)
    })
  }, [getAccessToken])

  return (
    <section className="card" aria-labelledby="roles-title">
      <h2 id="roles-title" className="card__title">
        {t('settings.section.roles')}
      </h2>
      <p className="card__hint">{t('settings.roles.hint')}</p>
      {error ? (
        <p className="card__empty">{t('settings.roles.loadError')}</p>
      ) : !catalog ? (
        <p className="card__hint" aria-busy="true">
          <span className="skeleton" />
        </p>
      ) : (
        <div className="role-list">
          {catalog.presets.map((preset) => (
            <details key={preset.key} className="role-list__item">
              <summary>
                <b>{t(`settings.role.${preset.key}`)}</b>
                <span className="chip">{t('settings.roles.scopes', { n: preset.scopes.length })}</span>
                {preset.requiresBranches && <span className="chip chip--warn">{t('settings.roles.branchOnly')}</span>}
              </summary>
              <p className="mono role-list__scopes">{preset.scopes.join(' · ')}</p>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

/** Grades and classes are managed on their own page; settings links there. */
export function GradesClassesSection() {
  const { t } = useI18n()
  return (
    <section className="card">
      <h2 className="card__title">{t('settings.section.gradesClasses')}</h2>
      <p className="card__hint">{t('settings.gradesClasses.hint')}</p>
      <Link className="btn" to="/classes">
        {t('settings.gradesClasses.open')}
      </Link>
    </section>
  )
}

/** Placeholder until Phase 6 builds general notification templates. */
export function NotificationTemplatesSection() {
  const { t } = useI18n()
  return (
    <section className="card">
      <h2 className="card__title">{t('settings.section.notificationTemplates')}</h2>
      <p className="card__empty">{t('settings.templates.placeholder')}</p>
    </section>
  )
}
