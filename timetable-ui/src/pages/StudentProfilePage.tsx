import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { CompletenessItem, Student } from '../domain/students'
import type { SchoolClass } from '../domain/classes'
import { getStudent } from '../lib/studentsApi'
import { listClasses } from '../lib/classesApi'
import { documentFileUrl } from '../lib/documentsApi'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { useApp } from '../state/AppContext'
import { DocumentsPanel } from '../components/DocumentsPanel'
import { ProfileTab } from '../components/student/ProfileTab'
import { FamilyTab } from '../components/student/FamilyTab'
import { EnrollmentTab } from '../components/student/EnrollmentTab'
import { FinanceTab } from '../components/student/FinanceTab'
import { ActivityTab } from '../components/student/ActivityTab'

type Tab = 'profile' | 'family' | 'enrollment' | 'finance' | 'documents' | 'activity'

const TABS: { id: Tab; label: TranslationKey; scope?: string }[] = [
  { id: 'profile', label: 'profile.tab.profile' },
  { id: 'family', label: 'profile.tab.family' },
  { id: 'enrollment', label: 'profile.tab.enrollment', scope: 'enrollments.read' },
  { id: 'finance', label: 'profile.tab.finance', scope: 'finance.read' },
  { id: 'documents', label: 'profile.tab.documents' },
  { id: 'activity', label: 'profile.tab.activity', scope: 'audit.read' },
]

/** Where each missing item gets fixed. */
const FIX_IN: Record<CompletenessItem, Tab> = {
  dob: 'profile',
  gender: 'profile',
  nationality: 'profile',
  nationalId: 'profile',
  address: 'profile',
  primaryPhone: 'profile',
  emergencyContact: 'profile',
  guardian: 'family',
  birthCertificate: 'documents',
  photo: 'documents',
}

/**
 * One student's full record (SAMS 2.2): a header with photo, class, status
 * and what is still missing, then Profile, Family, Enrollment, Finance,
 * Documents and Activity tabs. The tab is in the URL (?tab=), so it can be
 * linked to and survives a reload. Tabs the viewer has no scope for are
 * not shown.
 */
export function StudentProfilePage() {
  const { id = '' } = useParams()
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { fleet, students, setStudents } = useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const [student, setStudent] = useState<Student | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)

  const tabs = TABS.filter((tab) => !tab.scope || can(tab.scope))
  const requested = searchParams.get('tab') as Tab | null
  const tab: Tab = tabs.some((x) => x.id === requested) ? requested! : 'profile'
  const selectTab = (next: Tab) =>
    setSearchParams(
      (prev) => {
        prev.set('tab', next)
        return prev
      },
      { replace: true },
    )

  const load = useCallback(async () => {
    const res = await getStudent(getAccessToken, id)
    if (res.kind === 'ok') {
      setStudent(res.data)
      setError(null)
    } else setError(res.error)
  }, [getAccessToken, id])

  // Reloaded on every tab switch: documents and family links change the
  // completeness and photo, and are edited outside the profile form.
  useEffect(() => {
    void load()
  }, [load, tab])

  useEffect(() => {
    if (!student?.branchId) return
    void listClasses(getAccessToken, { branchId: student.branchId }).then((res) => {
      if (res.kind === 'ok') setClasses(res.data)
    })
  }, [getAccessToken, student?.branchId])

  const photoId = student?.photoDocumentId ?? null
  useEffect(() => {
    let live = true
    if (!photoId) {
      setPhotoUrl(null)
      return
    }
    void documentFileUrl(getAccessToken, photoId).then((res) => {
      if (live) setPhotoUrl(res.kind === 'ok' ? res.data : null)
    })
    return () => {
      live = false
    }
  }, [getAccessToken, photoId])

  /** Keeps this page and the roster in step after an edit. */
  const onChanged = (updated: Student) => {
    setStudent((current) => ({ ...current, ...updated, photoDocumentId: current?.photoDocumentId ?? null }))
    if (students.some((s) => s.id === updated.id)) {
      setStudents(students.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)))
    }
  }

  if (error) {
    return (
      <div className="page">
        <Link to="/students" className="card__link">
          ← {t('profile.back')}
        </Link>
        <div className="empty-state">
          {t(error === 'NOT_FOUND' ? 'profile.error.notFound' : error === 'BRANCH_FORBIDDEN' ? 'profile.error.forbidden' : 'profile.error.generic')}
        </div>
      </div>
    )
  }

  if (!student) {
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton" style={{ height: 96 }} />
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    )
  }

  const name = `${student.givenName} ${student.familyName}`.trim()
  const nameAr = `${student.givenNameAr ?? ''} ${student.familyNameAr ?? ''}`.trim()
  const shownName = (lang === 'ar' && nameAr) || name
  const initials = (student.givenName[0] ?? '') + (student.familyName[0] ?? '')
  const classLabel = classes.find((c) => c.id === student.classId)?.label ?? student.studentGroup
  const missing = student.completeness?.missing ?? []
  const status = student.status ?? 'enrolled'

  return (
    <div className="page student-page">
      <Link to="/students" className="card__link student-page__back">
        ← {t('profile.back')}
      </Link>

      <header className="student-head">
        <button
          type="button"
          className="student-head__photo"
          onClick={() => selectTab('documents')}
          aria-label={t(photoUrl ? 'profile.photo.view' : 'profile.photo.add')}
        >
          {photoUrl ? <img src={photoUrl} alt="" /> : <span aria-hidden="true">{initials.toUpperCase()}</span>}
        </button>
        <div className="student-head__main">
          <h1 className="page__title">
            {shownName || student.studentNumber}
            {student.preferredName && <span className="student-head__preferred"> “{student.preferredName}”</span>}
          </h1>
          {lang !== 'ar' && nameAr && (
            <p className="student-head__alt" dir="rtl">
              {nameAr}
            </p>
          )}
          <div className="docs__chips">
            <span className="chip mono">{student.studentNumber}</span>
            {classLabel && <span className="chip">{classLabel}</span>}
            <span className={`chip${status === 'enrolled' ? ' chip--ok' : ''}`}>
              {t(`profile.status.${status}` as TranslationKey)}
            </span>
            {student.completeness &&
              (student.completeness.complete ? (
                <span className="chip chip--ok">{t('profile.complete')}</span>
              ) : (
                <span className="chip chip--warn">{t('profile.incomplete', { n: String(missing.length) })}</span>
              ))}
          </div>
        </div>
      </header>

      {status === 'enrolled' && missing.length > 0 && (
        <section className="missing" aria-labelledby="missing-title">
          <h2 id="missing-title" className="missing__title">
            {t('profile.missing.title')}
          </h2>
          <ul className="missing__list">
            {missing.map((item) => (
              <li key={item}>
                <button type="button" className="chip chip--toggle" onClick={() => selectTab(FIX_IN[item])}>
                  {t(`profile.missing.${item}` as TranslationKey)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="tabs" role="tablist" aria-label={t('profile.tabs')}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`panel-${x.id}`}
            className="tabs__tab"
            onClick={() => selectTab(x.id)}
          >
            {t(x.label)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'profile' && <ProfileTab key={student.id} student={student} fleet={fleet} onChanged={onChanged} />}
        {tab === 'family' && <FamilyTab key={student.id} student={student} />}
        {tab === 'enrollment' && <EnrollmentTab student={student} classes={classes} onChanged={onChanged} />}
        {tab === 'finance' && <FinanceTab student={student} />}
        {tab === 'documents' && (
          <section className="card profile-card">
            <DocumentsPanel ownerType="student" ownerId={student.id} />
          </section>
        )}
        {tab === 'activity' && <ActivityTab studentId={student.id} />}
      </div>
    </div>
  )
}
