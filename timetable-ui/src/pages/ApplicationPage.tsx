import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  STATUS_TONE,
  convertApplication,
  createApplication,
  getApplication,
  stepApplication,
  updateApplication,
  type Applicant,
  type Application,
  type ApplicationGuardian,
  type ApplicationInput,
} from '../lib/admissionsApi'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { listClasses } from '../lib/classesApi'
import { listApprovals, requestApproval, type Approval } from '../lib/approvalsApi'
import { listLookups, lookupLabel, type LookupItem } from '../lib/settingsApi'
import type { SchoolClass } from '../domain/classes'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { DocumentsPanel } from '../components/DocumentsPanel'
import { ApprovalCard } from '../components/ApprovalCard'
import { ReasonDialog } from '../components/ReasonDialog'

const EDITABLE = new Set(['draft', 'submitted', 'under_review', 'waitlisted', 'accepted'])
const DEFAULT_REQUIRED = ['birth_certificate', 'photo', 'previous_report']

const emptyApplicant = (): Applicant => ({
  givenName: '',
  familyName: '',
  givenNameAr: null,
  familyNameAr: null,
  dob: null,
  gender: null,
  nationality: null,
  nationalId: null,
  previousSchool: null,
})

const emptyGuardian = (primary: boolean): ApplicationGuardian => ({
  fullName: '',
  relationship: '',
  phone: '',
  email: null,
  preferredLanguage: 'en',
  primaryContact: primary,
  existingParentId: null,
})

/**
 * One application (SAMS 2.5), or a new one at /admissions/new. The header
 * carries the next step for its status: submit, start review, propose a
 * decision (an approval request someone else decides), convert an
 * accepted applicant into a student, or withdraw.
 */
export function ApplicationPage() {
  const { id = 'new' } = useParams()
  const isNew = id === 'new'
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { branches, activeBranchId } = useApp()
  const navigate = useNavigate()

  const [app, setApp] = useState<Application | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [years, setYears] = useState<AcademicYear[]>([])
  const [sources, setSources] = useState<LookupItem[]>([])
  const [categories, setCategories] = useState<LookupItem[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [withdrawing, setWithdrawing] = useState(false)

  // The editable draft.
  const [branchId, setBranchId] = useState(activeBranchId ?? '')
  const [academicYearId, setAcademicYearId] = useState('')
  const [gradeLevel, setGradeLevel] = useState('')
  const [applicant, setApplicant] = useState<Applicant>(emptyApplicant)
  const [guardians, setGuardians] = useState<ApplicationGuardian[]>(() => [emptyGuardian(true)])
  const [source, setSource] = useState('')
  const [notes, setNotes] = useState('')
  const [required, setRequired] = useState<string[]>(DEFAULT_REQUIRED)

  const fill = (a: Application) => {
    setApp(a)
    setBranchId(a.branchId)
    setAcademicYearId(a.academicYearId)
    setGradeLevel(a.gradeLevel)
    setApplicant(a.applicant)
    setGuardians(a.guardians)
    setSource(a.source ?? '')
    setNotes(a.notes ?? '')
    setRequired(a.requiredDocuments)
  }

  const load = useCallback(async () => {
    if (isNew) return
    const [res, appr] = await Promise.all([
      getApplication(getAccessToken, id),
      listApprovals(getAccessToken, { view: 'all', entity: 'application', entityId: id }),
    ])
    if (res.kind === 'ok') fill(res.data)
    else setError(res.error === 'NOT_FOUND' ? t('admissions.error.notFound') : t('profile.error.generic'))
    if (appr.kind === 'ok') setApprovals(appr.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAccessToken, id, isNew])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((res) => {
      if (res.kind !== 'ok') return
      setYears(res.data)
      // A new application defaults to the year after the current one.
      if (isNew && !academicYearId) {
        const sorted = [...res.data].sort((a, b) => a.startDate.localeCompare(b.startDate))
        const current = sorted.findIndex((y) => y.current)
        setAcademicYearId((sorted[current + 1] ?? sorted[current] ?? sorted[0])?.id ?? '')
      }
    })
    void listLookups(getAccessToken, 'admissionSource', true).then((r) => r.kind === 'ok' && setSources(r.data))
    void listLookups(getAccessToken, 'documentCategory', true).then((r) => r.kind === 'ok' && setCategories(r.data))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAccessToken, isNew])

  const errorText = (code: string) => {
    const key = `admissions.error.${code}` as TranslationKey
    const text = t(key)
    return text === key ? t('profile.error.generic') : text
  }

  const editable = can('admissions.manage') && (isNew || (app !== null && EDITABLE.has(app.status)))
  const input = (): ApplicationInput => ({
    branchId,
    academicYearId,
    gradeLevel: gradeLevel.trim(),
    applicant: Object.fromEntries(
      Object.entries(applicant).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]),
    ) as unknown as Applicant,
    guardians: guardians.map((g) => ({ ...g, email: g.email?.trim() || null })),
    source: source || null,
    notes: notes.trim() || null,
    requiredDocuments: required,
  })

  const save = async () => {
    const body = input()
    if (!body.applicant.givenName || !body.applicant.familyName || !body.gradeLevel || !body.academicYearId || !body.branchId) {
      return setError(t('admissions.error.required'))
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    const { branchId: _b, ...patch } = body
    const res = isNew ? await createApplication(getAccessToken, body) : await updateApplication(getAccessToken, id, patch)
    setBusy(false)
    if (res.kind !== 'ok') return setError(errorText(res.error))
    if (isNew) return navigate(`/admissions/${res.data.id}`, { replace: true })
    setMessage(t('profile.saved'))
    await load()
  }

  const step = async (action: 'submit' | 'review') => {
    setBusy(true)
    setError(null)
    const res = await stepApplication(getAccessToken, id, action)
    setBusy(false)
    if (res.kind !== 'ok') return setError(errorText(res.error))
    await load()
  }

  const pendingDecision = approvals.find((a) => a.status === 'pending' && a.type === 'admissions.decision')
  const status = app?.status

  return (
    <div className="page student-page">
      <Link to="/admissions" className="card__link student-page__back">
        ← {t('admissions.back')}
      </Link>

      <header className="page__head">
        <div>
          <h1 className="page__title">
            {isNew ? t('admissions.new') : `${app?.applicant.givenName ?? ''} ${app?.applicant.familyName ?? ''}`}
          </h1>
          {app && (
            <div className="docs__chips">
              <span className="chip mono">{app.applicationNumber}</span>
              <span className="chip">{app.gradeLevel}</span>
              <span className={`chip ${STATUS_TONE[app.status]}`}>{t(`admissions.status.${app.status}` as TranslationKey)}</span>
            </div>
          )}
        </div>
        {app && can('admissions.manage') && (
          <div className="page__actions">
            {status === 'draft' && (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void step('submit')}>
                {t('admissions.submit')}
              </button>
            )}
            {(status === 'submitted' || (status === 'waitlisted' && !pendingDecision)) && (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void step('review')}>
                {t('admissions.review')}
              </button>
            )}
            {status && !['converted', 'withdrawn', 'rejected'].includes(status) && (
              <button type="button" className="btn" disabled={busy} onClick={() => setWithdrawing(true)}>
                {t('admissions.withdraw')}
              </button>
            )}
          </div>
        )}
      </header>

      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}

      {app && status === 'converted' && app.convertedStudentId && (
        <div className="missing" style={{ borderColor: 'var(--ok)', background: 'var(--ok-soft)' }}>
          <span className="missing__title" style={{ color: 'var(--ok)' }}>
            {t('admissions.converted')}
          </span>
          <Link className="btn btn--sm" to={`/students/${app.convertedStudentId}?tab=enrollment`}>
            {t('admissions.openStudent')}
          </Link>
        </div>
      )}
      {app?.withdrawnReason && <p className="card__hint">{t('admissions.withdrawnBecause', { reason: app.withdrawnReason })}</p>}
      {app?.decision && (
        <p className="card__hint">
          {t('admissions.decided', {
            outcome: t(`admissions.status.${app.decision.outcome}` as TranslationKey),
            date: new Date(app.decision.decidedAt).toLocaleDateString(lang),
          })}
          {app.decision.note && ` — “${app.decision.note}”`}
        </p>
      )}

      {app && (status === 'under_review' || status === 'waitlisted') && (
        <DecisionPanel app={app} pending={pendingDecision ?? null} onChanged={load} />
      )}
      {app && status === 'accepted' && can('admissions.manage') && can('students.create') && (
        <ConvertPanel app={app} onConverted={(studentId) => navigate(`/students/${studentId}?tab=enrollment`)} />
      )}

      <div className="profile-grid">
        <section className="card profile-card">
          <h2 className="card__title">{t('admissions.applicant')}</h2>
          <fieldset className="field-grid" disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
            {(
              [
                ['givenName', 'profile.givenName'],
                ['familyName', 'profile.familyName'],
                ['givenNameAr', 'profile.givenNameAr'],
                ['familyNameAr', 'profile.familyNameAr'],
                ['nationality', 'profile.nationality'],
                ['nationalId', 'profile.nationalId'],
                ['previousSchool', 'profile.previousSchool'],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="field">
                <span>{t(label)}</span>
                <input
                  className="input"
                  value={applicant[field] ?? ''}
                  dir={field.endsWith('Ar') ? 'rtl' : undefined}
                  onChange={(e) => setApplicant((a) => ({ ...a, [field]: e.target.value }))}
                />
              </label>
            ))}
            <label className="field">
              <span>{t('profile.dob')}</span>
              <input type="date" className="input" value={applicant.dob ?? ''} onChange={(e) => setApplicant((a) => ({ ...a, dob: e.target.value || null }))} />
            </label>
            <label className="field">
              <span>{t('profile.gender')}</span>
              <select className="input" value={applicant.gender ?? ''} onChange={(e) => setApplicant((a) => ({ ...a, gender: (e.target.value || null) as Applicant['gender'] }))}>
                <option value="">—</option>
                <option value="female">{t('profile.gender.female')}</option>
                <option value="male">{t('profile.gender.male')}</option>
              </select>
            </label>
          </fieldset>
        </section>

        <section className="card profile-card">
          <h2 className="card__title">{t('admissions.request')}</h2>
          <fieldset className="field-grid" disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
            <label className="field">
              <span>{t('admissions.branch')}</span>
              <select className="input" value={branchId} disabled={!isNew} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">—</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('admissions.col.year')}</span>
              <select className="input" value={academicYearId} onChange={(e) => setAcademicYearId(e.target.value)}>
                <option value="">—</option>
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('admissions.col.grade')}</span>
              <input className="input" value={gradeLevel} placeholder="Grade 1" onChange={(e) => setGradeLevel(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('profile.admissionSource')}</span>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">—</option>
                {sources
                  .filter((s) => s.active || s.code === source)
                  .map((s) => (
                    <option key={s.code} value={s.code}>
                      {lookupLabel(sources, s.code, lang)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field field--wide">
              <span>{t('admissions.notes')}</span>
              <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </fieldset>
        </section>

        <section className="card profile-card profile-card--full">
          <div className="card__head">
            <h2 className="card__title">{t('admissions.guardians')}</h2>
            {editable && guardians.length < 4 && (
              <button type="button" className="btn btn--sm" onClick={() => setGuardians((g) => [...g, emptyGuardian(g.length === 0)])}>
                {t('profile.addContact')}
              </button>
            )}
          </div>
          {guardians.length === 0 && <div className="empty-state">{t('admissions.noGuardians')}</div>}
          <div className="profile-contacts">
            {guardians.map((g, i) => {
              const patch = (c: Partial<ApplicationGuardian>) => setGuardians((all) => all.map((x, j) => (j === i ? { ...x, ...c } : x)))
              return (
                <fieldset key={g.id ?? `new-${i}`} className="profile-contact" disabled={!editable}>
                  <legend className="visually-hidden">{t('profile.contactN', { n: String(i + 1) })}</legend>
                  <label className="field">
                    <span>{t('profile.contactName')}</span>
                    <input className="input" value={g.fullName} onChange={(e) => patch({ fullName: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('profile.relationship')}</span>
                    <input className="input" value={g.relationship} onChange={(e) => patch({ relationship: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('profile.phone')}</span>
                    <input className="input" type="tel" value={g.phone} onChange={(e) => patch({ phone: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('profile.email')}</span>
                    <input className="input" type="email" value={g.email ?? ''} onChange={(e) => patch({ email: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>{t('parents.preferredLanguage')}</span>
                    <select className="input" value={g.preferredLanguage} onChange={(e) => patch({ preferredLanguage: e.target.value as 'en' | 'ar' })}>
                      <option value="en">English</option>
                      <option value="ar">العربية</option>
                    </select>
                  </label>
                  <label className="inline-field">
                    <input
                      type="checkbox"
                      checked={g.primaryContact}
                      onChange={(e) => setGuardians((all) => all.map((x, j) => ({ ...x, primaryContact: j === i ? e.target.checked : false })))}
                    />
                    {t('profile.family.primary')}
                  </label>
                  {editable && (
                    <button
                      type="button"
                      className="icon-btn profile-contact__remove"
                      onClick={() => setGuardians((all) => all.filter((_, j) => j !== i))}
                      aria-label={t('profile.removeContact', { name: g.fullName || String(i + 1) })}
                    >
                      ×
                    </button>
                  )}
                </fieldset>
              )
            })}
          </div>
          <p className="card__hint" style={{ margin: 0 }}>
            {t('admissions.guardiansHint')}
          </p>
        </section>

        <section className="card profile-card profile-card--full">
          <h2 className="card__title">{t('admissions.checklist')}</h2>
          <div className="docs__chips">
            {editable
              ? categories
                  .filter((c) => c.active || required.includes(c.code))
                  .map((c) => (
                    <label key={c.code} className="inline-field">
                      <input
                        type="checkbox"
                        checked={required.includes(c.code)}
                        onChange={(e) =>
                          setRequired((r) => (e.target.checked ? [...r, c.code] : r.filter((x) => x !== c.code)))
                        }
                      />
                      {lookupLabel(categories, c.code, lang)}
                    </label>
                  ))
              : null}
          </div>
          {app?.checklist && (
            <ul className="checklist">
              {app.checklist.map((item) => (
                <li key={item.category}>
                  <span
                    className={`chip ${item.status === 'verified' ? 'chip--ok' : item.status === 'unverified' ? '' : 'chip--bad'}`}
                  >
                    {t(`admissions.check.${item.status}` as TranslationKey)}
                  </span>
                  {lookupLabel(categories, item.category, lang)}
                </li>
              ))}
            </ul>
          )}
          {app && status !== 'converted' && <DocumentsPanel ownerType="application" ownerId={app.id} />}
          {isNew && <p className="card__hint">{t('admissions.docsAfterSave')}</p>}
        </section>

        {editable && (
          <div className="profile-save" aria-live="polite">
            {message && <span className="profile-save__ok">{message}</span>}
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
              {isNew ? t('admissions.create') : t('profile.save')}
            </button>
          </div>
        )}
      </div>

      {withdrawing && app && (
        <ReasonDialog
          title={t('admissions.withdrawTitle', { number: app.applicationNumber })}
          confirmLabel={t('admissions.withdraw')}
          onClose={() => setWithdrawing(false)}
          onConfirm={async (reason) => {
            const res = await stepApplication(getAccessToken, app.id, 'withdraw', { reason })
            if (res.kind !== 'ok') return errorText(res.error)
            setWithdrawing(false)
            await load()
            return null
          }}
        />
      )}
    </div>
  )
}

/** Propose accept / reject / waitlist, or act on the open proposal. */
function DecisionPanel({ app, pending, onChanged }: { app: Application; pending: Approval | null; onChanged: () => void }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [outcome, setOutcome] = useState<'accepted' | 'rejected' | 'waitlisted'>('accepted')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const incomplete = (app.checklist ?? []).some((c) => c.status === 'missing' || c.status === 'rejected')

  const propose = async () => {
    setBusy(true)
    setError(null)
    const res = await requestApproval(getAccessToken, {
      type: 'admissions.decision',
      entityId: app.id,
      payload: { outcome, note: note.trim() || null },
      comment: note.trim() || null,
    })
    setBusy(false)
    if (res.kind !== 'ok') {
      const key = `admissions.error.${res.error}` as TranslationKey
      const text = t(key)
      return setError(text === key ? t('profile.error.generic') : text)
    }
    setNote('')
    onChanged()
  }

  return (
    <section className="card profile-card">
      <h2 className="card__title">{t('admissions.decision')}</h2>
      {pending ? (
        <ApprovalCard approval={pending} canDecide={can('admissions.decide')} onChanged={onChanged} />
      ) : can('admissions.manage') ? (
        <>
          <p className="card__hint" style={{ margin: 0 }}>
            {t('admissions.decisionHint')}
          </p>
          <div className="break-card__row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select className="input input--sm" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label={t('admissions.decision')}>
              <option value="accepted">{t('admissions.status.accepted')}</option>
              <option value="waitlisted" disabled={app.status === 'waitlisted'}>
                {t('admissions.status.waitlisted')}
              </option>
              <option value="rejected">{t('admissions.status.rejected')}</option>
            </select>
            <input className="input input--sm" style={{ flex: 1, minWidth: 180 }} placeholder={t('enroll.note')} value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn--sm btn--primary" disabled={busy || (outcome === 'accepted' && incomplete)} onClick={() => void propose()}>
              {t('admissions.propose')}
            </button>
          </div>
          {outcome === 'accepted' && incomplete && <p className="card__hint">{t('admissions.error.CHECKLIST_INCOMPLETE')}</p>}
          {error && <p className="login__error">{error}</p>}
        </>
      ) : null}
    </section>
  )
}

/** Accepted → a student, their parents and a planned place. */
function ConvertPanel({ app, onConverted }: { app: Application; onConverted: (studentId: string) => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [classId, setClassId] = useState('')
  const [studentNumber, setStudentNumber] = useState('')
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listClasses(getAccessToken, { branchId: app.branchId }).then((res) => {
      if (res.kind === 'ok') setClasses(res.data)
    })
  }, [getAccessToken, app.branchId])

  const options = useMemo(
    () =>
      classes
        .filter((c) => !c.academicYearId || c.academicYearId === app.academicYearId)
        // Classes in the requested grade first.
        .sort((a, b) => Number(b.gradeLevel === app.gradeLevel) - Number(a.gradeLevel === app.gradeLevel)),
    [classes, app.academicYearId, app.gradeLevel],
  )

  const convert = async () => {
    setBusy(true)
    setError(null)
    const res = await convertApplication(getAccessToken, app.id, { classId, studentNumber: studentNumber.trim(), startDate })
    setBusy(false)
    if (res.kind !== 'ok') {
      const key = `admissions.error.${res.error}` as TranslationKey
      const text = t(key)
      return setError(text === key ? t('profile.error.generic') : text)
    }
    onConverted(res.data.studentId)
  }

  return (
    <section className="card profile-card">
      <h2 className="card__title">{t('admissions.convert')}</h2>
      <p className="card__hint" style={{ margin: 0 }}>
        {t('admissions.convertHint')}
      </p>
      <div className="field-grid">
        <label className="field">
          <span>{t('enroll.class')}</span>
          <select className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">—</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('admissions.studentNumber')}</span>
          <input
            className="input"
            placeholder={t('students.number.auto')}
            value={studentNumber}
            onChange={(e) => setStudentNumber(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('enroll.startDate')}</span>
          <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
      </div>
      {error && <p className="login__error">{error}</p>}
      <div className="page__actions">
        <button type="button" className="btn btn--primary" disabled={busy || !classId} onClick={() => void convert()}>
          {t('admissions.convertConfirm')}
        </button>
      </div>
    </section>
  )
}
