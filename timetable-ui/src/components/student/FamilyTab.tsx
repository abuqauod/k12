import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Student } from '../../domain/students'
import { getFamily, type FamilyMember } from '../../lib/studentsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'

/**
 * The student's family: parents linked through the Parents module, with
 * each link's flags and absence alerts. Since SAMS 2.3 this is the only
 * family record (the old per-student guardian list is retired); links and
 * alerts are edited on the parent.
 */
export function FamilyTab({ student }: { student: Student }) {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [family, setFamily] = useState<FamilyMember[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!can('parents.read')) return
    void getFamily(getAccessToken, student.id).then((res) => {
      if (res.kind === 'ok') setFamily(res.data)
      else setError(true)
    })
  }, [getAccessToken, student.id, can])

  const alerts = (m: FamilyMember) => {
    const on = (['email', 'sms'] as const).filter((c) => m.communicationPermissions[c])
    return on.length === 0
      ? t('profile.family.noAlerts')
      : t('profile.family.alerts', {
          channels: on.map((c) => t(`parents.alerts.${c}`)).join(' · '),
          language: m.preferredLanguage === 'ar' ? 'العربية' : 'English',
        })
  }

  const flags = (m: FamilyMember) =>
    [
      m.primaryContact && t('profile.family.primary'),
      m.emergencyContact && t('profile.family.emergency'),
      m.authorizedPickup && t('profile.family.pickup'),
      m.financialResponsibility && t('profile.family.financial'),
    ].filter(Boolean) as string[]

  return (
    <div className="profile-grid">
      {!can('parents.read') && <div className="empty-state profile-card--full">{t('profile.error.forbidden')}</div>}
      {can('parents.read') && (
        <section className="card profile-card profile-card--full">
          <div className="card__head">
            <h2 className="card__title">{t('profile.family.parents')}</h2>
            {can('parents.write') && (
              <Link className="btn btn--sm" to="/parents">
                {t('profile.family.manage')}
              </Link>
            )}
          </div>
          {error ? (
            <div className="empty-state">{t('profile.error.generic')}</div>
          ) : family === null ? (
            <div className="skeleton" style={{ height: 56 }} />
          ) : family.length === 0 ? (
            <div className="empty-state">{t('profile.family.none')}</div>
          ) : (
            <ul className="family-list">
              {family.map((m) => (
                <li key={m.linkId} className="family-list__item">
                  <span className="family-list__main">
                    <Link to={`/parents?parent=${encodeURIComponent(m.parentId)}`} className="family-list__name">
                      {(lang === 'ar' && m.fullNameAr) || m.fullName}
                    </Link>
                    <span className="docs__meta">
                      {m.relationshipType} · <span dir="ltr">{m.primaryPhone}</span>
                      {m.email && <> · {m.email}</>}
                    </span>
                    <span className="docs__meta">{alerts(m)}</span>
                  </span>
                  <span className="docs__chips">
                    {flags(m).map((f) => (
                      <span key={f} className="chip">
                        {f}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

    </div>
  )
}
