import { useEffect, useMemo, useState } from 'react'
import type { DuplicateCandidate, LinkedStudentSummary, Parent, PreferredContactMethod } from '../domain/parents'
import { formatMinorUnits } from '../domain/finance'
import { PREFERRED_CONTACT_METHODS, emptyLink, emptyParent } from '../domain/parents'
import type { NewLink, NewParent } from '../lib/parentsApi'
import { ReasonDialog } from './ReasonDialog'
import { createParent, createParentLink, deactivateParentLink, getParent, updateParent } from '../lib/parentsApi'
import { listClasses } from '../lib/classesApi'
import { listStudents, getStudent } from '../lib/studentsApi'
import type { Student } from '../domain/students'
import type { SchoolClass } from '../domain/classes'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { DocumentsPanel } from './DocumentsPanel'
import { StudentDetailDialog } from './StudentDetailDialog'

type Tab = 'basic' | 'contact' | 'work' | 'status'

const TABS: Array<{ id: Tab; key: TranslationKey }> = [
  { id: 'basic', key: 'parents.tab.basic' },
  { id: 'contact', key: 'parents.tab.contact' },
  { id: 'work', key: 'parents.tab.work' },
  { id: 'status', key: 'parents.tab.status' },
]

/** Create/edit a parent record, plus (once it exists) the students linked to
 * it — the section below the form the requirement asks for. Every field on
 * a linked-student card is read live from Student/Enrollment/Class/Branch
 * (composed server-side by GET /parents/:id), never duplicated here. */
export function ParentDetailDialog({
  parentId,
  onClose,
  onSaved,
}: {
  parentId: string | null
  onClose: () => void
  onSaved: (parent: Parent) => void
}) {
  const { t, n } = useI18n()
  // A code with no translation shows the generic message, never a raw key.
  const errorText = (code: string) => {
    const key = `parents.error.${code}` as TranslationKey
    const text = t(key)
    return text === key ? t('parents.error.generic') : text
  }
  const { getAccessToken } = useAuth()
  const { fleet, activeBranchId } = useApp()

  const [id, setId] = useState<string | null>(parentId)
  const [tab, setTab] = useState<Tab>('basic')
  const [form, setForm] = useState<ReturnType<typeof emptyParent>>(emptyParent())
  const [portalAccessEnabled, setPortalAccessEnabled] = useState(false)
  const [status, setStatus] = useState<Parent['status']>('active')
  const [loading, setLoading] = useState(id !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<DuplicateCandidate[]>([])
  const [students, setStudents] = useState<LinkedStudentSummary[]>([])
  const [openStudentId, setOpenStudentId] = useState<string | null>(null)
  const [openStudent, setOpenStudent] = useState<Student | null>(null)
  const [openStudentClasses, setOpenStudentClasses] = useState<SchoolClass[]>([])

  const patch = (changes: Partial<typeof form>) => setForm((f) => ({ ...f, ...changes }))

  const load = async () => {
    if (!id) return
    setLoading(true)
    const res = await getParent(getAccessToken, id)
    setLoading(false)
    if (res.kind !== 'ok') {
      setError(t('parents.error.NOT_FOUND'))
      return
    }
    const { students: linked, ...parent } = res.data
    setForm({
      fullName: parent.fullName,
      fullNameAr: parent.fullNameAr,
      nationalId: parent.nationalId,
      primaryPhone: parent.primaryPhone,
      alternativePhone: parent.alternativePhone,
      email: parent.email,
      address: parent.address,
      city: parent.city,
      preferredContactMethod: parent.preferredContactMethod,
      status: parent.status,
      occupation: parent.occupation,
      employer: parent.employer,
      emergencyContactName: parent.emergencyContactName,
      emergencyContactPhone: parent.emergencyContactPhone,
      notes: parent.notes,
      portalAccess: parent.portalAccess,
    })
    setPortalAccessEnabled(parent.portalAccess.enabled)
    setStatus(parent.status)
    setStudents(linked)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const save = async () => {
    setSaving(true)
    setError(null)
    const body: NewParent = { ...form, portalAccessEnabled }
    const result = id
      ? await updateParent(getAccessToken, id, body)
      : await createParent(getAccessToken, body)
    setSaving(false)
    if (result.kind !== 'ok') {
      setError(errorText(result.error))
      return
    }
    const parent = 'parent' in result.data ? result.data.parent : result.data
    setWarnings(result.data.warnings)
    if (!id) setId(parent.id)
    onSaved(parent)
  }

  // ---------------------------------------------------------- link a student
  const [studentQuery, setStudentQuery] = useState('')
  const [studentResults, setStudentResults] = useState<Student[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [link, setLink] = useState(emptyLink())
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [showLinkForm, setShowLinkForm] = useState(false)

  const searchStudents = async () => {
    if (studentQuery.trim().length < 2) return
    setSearching(true)
    const res = await listStudents(getAccessToken, { search: studentQuery.trim() })
    setSearching(false)
    if (res.kind === 'ok') setStudentResults(res.data)
  }

  const addLink = async () => {
    if (!id || !selectedStudentId) return
    setLinking(true)
    setLinkError(null)
    const body: NewLink = { studentId: selectedStudentId, ...link }
    const res = await createParentLink(getAccessToken, id, body)
    setLinking(false)
    if (res.kind !== 'ok') {
      setLinkError(errorText(res.error))
      return
    }
    setShowLinkForm(false)
    setSelectedStudentId('')
    setStudentQuery('')
    setStudentResults([])
    setLink(emptyLink())
    await load()
  }

  // Removing a relationship asks why first (SAMS 1.12).
  const [removingLink, setRemovingLink] = useState<string | null>(null)
  const removeLink = (linkId: string) => setRemovingLink(linkId)
  const confirmRemoveLink = async (reason: string): Promise<string | null> => {
    if (!id || !removingLink) return null
    const res = await deactivateParentLink(getAccessToken, id, removingLink, reason)
    if (res.kind !== 'ok') return errorText(res.error)
    setRemovingLink(null)
    await load()
    return null
  }

  const openStudentProfile = async (studentId: string) => {
    const res = await getStudent(getAccessToken, studentId)
    if (res.kind !== 'ok') return
    const classesRes = await listClasses(getAccessToken, { branchId: res.data.branchId })
    setOpenStudent(res.data)
    setOpenStudentClasses(classesRes.kind === 'ok' ? classesRes.data : [])
    setOpenStudentId(studentId)
  }

  const activeStudents = useMemo(() => students.filter((s) => s.linkActive), [students])

  const name = form.fullName || t('parents.newParent')

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog__panel" style={{ maxWidth: 760 }}>
        <div className="dialog__head">
          <strong>{name}</strong>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {t('parents.close')}
          </button>
        </div>

        <div className="dialog__body" style={{ display: 'grid', gap: 18 }}>
          {loading ? (
            <p className="card__hint">{t('parents.loading')}</p>
          ) : (
            <>
              {warnings.length > 0 && (
                <div className="card" style={{ padding: 10, borderColor: 'var(--warn, #d97706)' }}>
                  <b>{t('parents.duplicateWarning')}</b>
                  <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                    {warnings.map((w) => (
                      <li key={w.id}>
                        {w.restricted ? (
                          t('parents.duplicateRestricted')
                        ) : (
                          <>
                            {w.fullName} · {w.primaryPhone}
                            {w.email ? ` · ${w.email}` : ''}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="tabs" role="tablist">
                {TABS.map((entry) => (
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

              {tab === 'basic' && (
                <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <label className="field" style={{ minWidth: 200 }}>
                    <span>{t('parents.fullName')}</span>
                    <input className="input" value={form.fullName} onChange={(e) => patch({ fullName: e.target.value })} />
                  </label>
                  <label className="field" style={{ minWidth: 200 }}>
                    <span>{t('parents.fullNameAr')}</span>
                    <input className="input" value={form.fullNameAr ?? ''} onChange={(e) => patch({ fullNameAr: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 160 }}>
                    <span>{t('parents.nationalId')}</span>
                    <input className="input" value={form.nationalId ?? ''} onChange={(e) => patch({ nationalId: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 160 }}>
                    <span>{t('parents.preferredContact')}</span>
                    <select
                      className="input"
                      value={form.preferredContactMethod}
                      onChange={(e) => patch({ preferredContactMethod: e.target.value as PreferredContactMethod })}
                    >
                      {PREFERRED_CONTACT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {t(`parents.contactMethod.${method}` as TranslationKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ minWidth: 320, flexBasis: '100%' }}>
                    <span>{t('parents.notes')}</span>
                    <textarea className="input" rows={2} value={form.notes ?? ''} onChange={(e) => patch({ notes: e.target.value || null })} />
                  </label>
                </div>
              )}

              {tab === 'contact' && (
                <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <label className="field" style={{ minWidth: 160 }}>
                    <span>{t('parents.primaryPhone')}</span>
                    <input className="input" value={form.primaryPhone} onChange={(e) => patch({ primaryPhone: e.target.value })} />
                  </label>
                  <label className="field" style={{ minWidth: 160 }}>
                    <span>{t('parents.alternativePhone')}</span>
                    <input className="input" value={form.alternativePhone ?? ''} onChange={(e) => patch({ alternativePhone: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 200 }}>
                    <span>{t('parents.email')}</span>
                    <input className="input" type="email" value={form.email ?? ''} onChange={(e) => patch({ email: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 160 }}>
                    <span>{t('parents.city')}</span>
                    <input className="input" value={form.city ?? ''} onChange={(e) => patch({ city: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 320, flexBasis: '100%' }}>
                    <span>{t('parents.address')}</span>
                    <input className="input" value={form.address ?? ''} onChange={(e) => patch({ address: e.target.value || null })} />
                  </label>
                </div>
              )}

              {tab === 'work' && (
                <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <label className="field" style={{ minWidth: 200 }}>
                    <span>{t('parents.occupation')}</span>
                    <input className="input" value={form.occupation ?? ''} onChange={(e) => patch({ occupation: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 200 }}>
                    <span>{t('parents.employer')}</span>
                    <input className="input" value={form.employer ?? ''} onChange={(e) => patch({ employer: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 200 }}>
                    <span>{t('parents.emergencyContactName')}</span>
                    <input className="input" value={form.emergencyContactName ?? ''} onChange={(e) => patch({ emergencyContactName: e.target.value || null })} />
                  </label>
                  <label className="field" style={{ minWidth: 160 }}>
                    <span>{t('parents.emergencyContactPhone')}</span>
                    <input className="input" value={form.emergencyContactPhone ?? ''} onChange={(e) => patch({ emergencyContactPhone: e.target.value || null })} />
                  </label>
                </div>
              )}

              {tab === 'status' && (
                <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <div className="field">
                    <span>{t('parents.status')}</span>
                    <span className={`chip${status === 'active' ? ' chip--on' : ''}`}>
                      {t(`parents.status.${status}` as TranslationKey)}
                    </span>
                  </div>
                  <label className="inline-field">
                    <input
                      type="checkbox"
                      checked={portalAccessEnabled}
                      onChange={(e) => setPortalAccessEnabled(e.target.checked)}
                    />
                    {t('parents.portalAccess')}
                  </label>
                  <p className="card__hint" style={{ flexBasis: '100%' }}>{t('parents.portalAccessHint')}</p>
                </div>
              )}

              {error && <p className="login__error">{error}</p>}
              <div className="page__actions">
                <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void save()}>
                  {saving ? t('parents.saving') : t('parents.save')}
                </button>
              </div>

              {id && (
                <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <div className="page__actions" style={{ marginBottom: 8 }}>
                    <h3 className="card__subtitle" style={{ margin: 0, flex: 1 }}>
                      {t('parents.linkedStudents')} ({n(activeStudents.length)})
                    </h3>
                    <button type="button" className="btn btn--sm" onClick={() => setShowLinkForm((v) => !v)}>
                      {t('parents.link.add')}
                    </button>
                  </div>

                  {showLinkForm && (
                    <div className="card" style={{ padding: 10, marginBottom: 10 }}>
                      <div className="break-card__row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <input
                          className="input input--sm"
                          style={{ minWidth: 200 }}
                          placeholder={t('parents.link.searchStudent')}
                          value={studentQuery}
                          onChange={(e) => setStudentQuery(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void searchStudents()}
                        />
                        <button type="button" className="btn btn--sm" disabled={searching} onClick={() => void searchStudents()}>
                          {t('parents.link.search')}
                        </button>
                      </div>
                      {studentResults.length > 0 && (
                        <select
                          className="input input--sm"
                          style={{ marginTop: 6 }}
                          value={selectedStudentId}
                          onChange={(e) => setSelectedStudentId(e.target.value)}
                        >
                          <option value="">{t('parents.link.pickStudent')}</option>
                          {studentResults.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.givenName} {s.familyName} · {s.studentNumber}
                            </option>
                          ))}
                        </select>
                      )}
                      <div className="break-card__row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                        <input
                          className="input input--sm"
                          style={{ minWidth: 140 }}
                          placeholder={t('parents.link.relationshipType')}
                          value={link.relationshipType}
                          onChange={(e) => setLink((l) => ({ ...l, relationshipType: e.target.value }))}
                        />
                      </div>
                      <div className="break-card__row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
                        <label className="inline-field">
                          <input type="checkbox" checked={link.primaryContact} onChange={(e) => setLink((l) => ({ ...l, primaryContact: e.target.checked }))} />
                          {t('parents.link.primaryContact')}
                        </label>
                        <label className="inline-field">
                          <input type="checkbox" checked={link.secondaryContact} onChange={(e) => setLink((l) => ({ ...l, secondaryContact: e.target.checked }))} />
                          {t('parents.link.secondaryContact')}
                        </label>
                        <label className="inline-field">
                          <input type="checkbox" checked={link.emergencyContact} onChange={(e) => setLink((l) => ({ ...l, emergencyContact: e.target.checked }))} />
                          {t('parents.link.emergencyContact')}
                        </label>
                        <label className="inline-field">
                          <input type="checkbox" checked={link.authorizedPickup} onChange={(e) => setLink((l) => ({ ...l, authorizedPickup: e.target.checked }))} />
                          {t('parents.link.authorizedPickup')}
                        </label>
                        <label className="inline-field">
                          <input type="checkbox" checked={link.financialResponsibility} onChange={(e) => setLink((l) => ({ ...l, financialResponsibility: e.target.checked }))} />
                          {t('parents.link.financialResponsibility')}
                        </label>
                        <label className="inline-field">
                          <input type="checkbox" checked={link.portalAccess} onChange={(e) => setLink((l) => ({ ...l, portalAccess: e.target.checked }))} />
                          {t('parents.link.portalAccess')}
                        </label>
                      </div>
                      {linkError && <p className="login__error">{linkError}</p>}
                      <div className="page__actions" style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={!selectedStudentId || linking}
                          onClick={() => void addLink()}
                        >
                          {t('parents.link.confirm')}
                        </button>
                      </div>
                    </div>
                  )}

                  {activeStudents.length === 0 && <p className="card__hint">{t('parents.linkedStudents.none')}</p>}
                  <div style={{ display: 'grid', gap: 8 }}>
                    {activeStudents.map((s) => {
                      const stopName =
                        s.branchId === activeBranchId
                          ? fleet.stops.find((stop) => stop.id === s.stopId)?.name
                          : undefined
                      return (
                        <div key={s.linkId} className="card" style={{ padding: 10 }}>
                          <div className="break-card__row" style={{ justifyContent: 'space-between' }}>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              style={{ fontWeight: 600, padding: 0 }}
                              onClick={() => void openStudentProfile(s.studentId)}
                            >
                              {s.givenName} {s.familyName}
                            </button>
                            <button type="button" className="icon-btn" aria-label={t('parents.link.remove')} onClick={() => removeLink(s.linkId)}>
                              ×
                            </button>
                          </div>
                          <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                            <span className="chip">{s.studentNumber}</span>
                            {s.classLabel && <span className="chip">{s.classLabel}</span>}
                            {s.branchName && <span className="chip">{s.branchName}</span>}
                            {s.age !== null && <span className="chip">{t('parents.card.age', { age: n(s.age) })}</span>}
                            {s.gender && <span className="chip">{t(`parents.card.gender.${s.gender}` as TranslationKey)}</span>}
                            <span className="chip">
                              {t(`parents.card.status.${s.enrollmentStatus ?? s.studentStatus}` as TranslationKey)}
                            </span>
                            <span className="chip">
                              {stopName ?? t(`students.mode.${s.transportMode}` as TranslationKey)}
                            </span>
                            <span className={`chip${s.outstandingBalance > 0 ? '' : ' chip--on'}`}>
                              {t('parents.card.balance', { amount: formatMinorUnits(s.outstandingBalance) })}
                            </span>
                          </div>
                          <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                            {s.relationshipType && <span className="chip chip--on">{s.relationshipType}</span>}
                            {s.primaryContact && <span className="chip">{t('parents.link.primaryContact')}</span>}
                            {s.emergencyContact && <span className="chip">{t('parents.link.emergencyContact')}</span>}
                            {s.authorizedPickup && <span className="chip">{t('parents.link.authorizedPickup')}</span>}
                            {s.financialResponsibility && <span className="chip">{t('parents.link.financialResponsibility')}</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

              {id && (
                <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                  <DocumentsPanel ownerType="parent" ownerId={id} />
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {openStudentId &&
        openStudent &&
        (() => {
          const studentForDialog = openStudent
          return (
            <StudentDetailDialog
              student={studentForDialog}
              classes={openStudentClasses}
              fleet={fleet}
              getAccessToken={getAccessToken}
              onClose={() => setOpenStudentId(null)}
              onChanged={(updated) => setOpenStudent(updated)}
            />
          )
        })()}
      {removingLink && (
        <ReasonDialog
          title={t('parents.link.remove')}
          confirmLabel={t('parents.link.remove')}
          onConfirm={confirmRemoveLink}
          onClose={() => setRemovingLink(null)}
        />
      )}
    </div>
  )
}
