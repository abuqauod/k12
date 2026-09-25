import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Guardian, GuardianLanguage, Student } from '../../domain/students'
import { emptyGuardian } from '../../domain/students'
import { getFamily, updateStudent, type FamilyMember } from '../../lib/studentsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'

/**
 * The student's family: parents linked through the Parents module (the
 * real relationship, with its flags), and the older per-student guardian
 * list, still what absence notifications read until SAMS 2.3 merges them.
 */
export function FamilyTab({ student, onChanged }: { student: Student; onChanged: (updated: Student) => void }) {
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

  const flags = (m: FamilyMember) =>
    [
      m.primaryContact && t('profile.family.primary'),
      m.emergencyContact && t('profile.family.emergency'),
      m.authorizedPickup && t('profile.family.pickup'),
      m.financialResponsibility && t('profile.family.financial'),
    ].filter(Boolean) as string[]

  return (
    <div className="profile-grid">
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

      <GuardiansEditor student={student} onChanged={onChanged} />
    </div>
  )
}

function GuardiansEditor({ student, onChanged }: { student: Student; onChanged: (updated: Student) => void }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const editable = can('students.update')
  const [guardians, setGuardians] = useState<Guardian[]>(() => student.guardians ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (i: number, changes: Partial<Guardian>) =>
    setGuardians((gs) => gs.map((g, j) => (j === i ? { ...g, ...changes } : g)))

  const save = async () => {
    if (guardians.filter((g) => g.isPrimary).length > 1) return setError(t('profile.guardians.onePrimary'))
    setSaving(true)
    setError(null)
    const res = await updateStudent(getAccessToken, student.id, { guardians })
    setSaving(false)
    if (res.kind === 'ok') onChanged({ ...res.data, photoDocumentId: student.photoDocumentId })
    else setError(t('profile.error.generic'))
  }

  return (
    <section className="card profile-card profile-card--full">
      <div className="card__head">
        <h2 className="card__title">{t('profile.guardians')}</h2>
        {editable && (
          <button type="button" className="btn btn--sm" onClick={() => setGuardians((gs) => [...gs, emptyGuardian()])}>
            {t('guardian.add')}
          </button>
        )}
      </div>
      <p className="card__hint" style={{ marginTop: 0 }}>
        {t('profile.guardiansHint')}
      </p>
      {guardians.length === 0 && <div className="empty-state">{t('profile.guardians.none')}</div>}
      {guardians.map((g, i) => (
        <fieldset key={g.id ?? i} className="card guardian-row" disabled={!editable}>
          <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <input className="input input--sm" style={{ minWidth: 130 }} aria-label={t('students.name')} placeholder={t('students.name')} value={g.name} onChange={(e) => patch(i, { name: e.target.value })} />
            <input className="input input--sm" style={{ minWidth: 90 }} aria-label={t('profile.relationship')} placeholder={t('profile.relationship')} value={g.relationship} onChange={(e) => patch(i, { relationship: e.target.value })} />
            <input className="input input--sm" style={{ minWidth: 120 }} aria-label={t('profile.phone')} placeholder={t('profile.phone')} value={g.phone} onChange={(e) => patch(i, { phone: e.target.value })} />
            <input className="input input--sm" style={{ minWidth: 150 }} aria-label={t('profile.email')} placeholder={t('profile.email')} value={g.email ?? ''} onChange={(e) => patch(i, { email: e.target.value || null })} />
            <select className="input input--sm" value={g.preferredLanguage} onChange={(e) => patch(i, { preferredLanguage: e.target.value as GuardianLanguage })} aria-label={t('guardian.language')}>
              <option value="en">EN</option>
              <option value="ar">AR</option>
            </select>
          </div>
          <div className="break-card__row" style={{ gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            <label className="inline-field"><input type="checkbox" checked={g.isPrimary} onChange={(e) => patch(i, { isPrimary: e.target.checked })} />{t('profile.guardians.primary')}</label>
            <label className="inline-field"><input type="checkbox" checked={g.notifyByEmail} onChange={(e) => patch(i, { notifyByEmail: e.target.checked })} />{t('guardian.notifyEmail')}</label>
            <label className="inline-field"><input type="checkbox" checked={g.notifyBySms} onChange={(e) => patch(i, { notifyBySms: e.target.checked })} />{t('guardian.notifySms')}</label>
            <label className="inline-field"><input type="checkbox" checked={g.active} onChange={(e) => patch(i, { active: e.target.checked })} />{t('guardian.active')}</label>
            {editable && (
              <button type="button" className="icon-btn" style={{ marginInlineStart: 'auto' }} onClick={() => setGuardians((gs) => gs.filter((_, j) => j !== i))} aria-label={t('guardian.remove')}>
                ×
              </button>
            )}
          </div>
        </fieldset>
      ))}
      {error && <p className="login__error">{error}</p>}
      {editable && (
        <div className="page__actions">
          <button type="button" className="btn btn--sm btn--primary" disabled={saving} onClick={() => void save()}>
            {t('profile.save')}
          </button>
        </div>
      )}
    </section>
  )
}
