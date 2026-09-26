import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { listClasses } from '../lib/classesApi'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { useLookup } from '../lib/useLookup'
import { openApiPage } from '../lib/printPage'
import {
  getGrading,
  getResults,
  getSheet,
  listPlans,
  release,
  reportCardsPath,
  saveComment,
  saveGrading,
  savePlan,
  saveSheet,
  unrelease,
  type GradeBand,
  type Plan,
  type Results,
  type Sheet,
} from '../lib/gradesApi'
import type { SchoolClass } from '../domain/classes'

/**
 * SAMS 11.2 — the gradebook: teachers enter marks per class, subject and
 * term; results and report cards are worked out from the grade's plan;
 * a coordinator sets the plans and the scale and releases report cards to
 * families.
 */

type Tab = 'entry' | 'results' | 'plans'

function errorText(t: (k: TranslationKey, p?: Record<string, string | number>) => string, code: string) {
  const key = `grades.error.${code}` as TranslationKey
  return t(key) === key ? t('grades.error.generic') : t(key)
}

export function GradesPage() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [params, setParams] = useSearchParams()
  const tab = (['entry', 'results', 'plans'].includes(params.get('tab') ?? '') ? params.get('tab') : 'entry') as Tab
  const [years, setYears] = useState<AcademicYear[]>([])
  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [classId, setClassId] = useState('')

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((r) => r.kind === 'ok' && setYears(r.data))
  }, [getAccessToken])
  useEffect(() => {
    void listClasses(getAccessToken, { branchId: activeBranchId || undefined }).then(
      (r) => r.kind === 'ok' && setClasses(r.data.filter((c) => c.active && c.academicYearId)),
    )
  }, [getAccessToken, activeBranchId])

  const cls = classes.find((c) => c.id === classId) ?? null
  const year = years.find((y) => y.id === cls?.academicYearId) ?? null

  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('grades.title')}</h1>
          <p className="page__subtitle">{t('grades.subtitle')}</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={t('grades.title')}>
        {(['entry', 'results', 'plans'] as Tab[]).map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className="tabs__tab"
            onClick={() => setParams({ tab: x }, { replace: true })}
          >
            {t(`grades.tab.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      {tab !== 'plans' && (
        <div className="inline-form grades-toolbar">
          <label className="field field--inline">
            <span>{t('grades.class')}</span>
            <select className="select" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">{t('grades.pickClass')}</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || `${c.gradeLevel} ${c.name}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {tab === 'entry' && cls && year && <MarkEntry cls={cls} year={year} />}
      {tab === 'results' && cls && year && (
        <ResultsView cls={cls} year={year} canManage={can('grades.manage')} canEnter={can('grades.enter')} />
      )}
      {tab !== 'plans' && !cls && <div className="empty-state">{t('grades.pickClassHint')}</div>}
      {tab === 'plans' && <Plans years={years} classes={classes} canManage={can('grades.manage')} />}
    </div>
  )
}

function termsOf(year: AcademicYear) {
  return year.terms ?? []
}

function MarkEntry({ cls, year }: { cls: SchoolClass; year: AcademicYear }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const subjects = useLookup('subject')
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined)
  const [subject, setSubject] = useState('')
  const [termId, setTermId] = useState(termsOf(year)[0]?.id ?? '')
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    void listPlans(getAccessToken, year.id).then((r) => {
      const p = r.kind === 'ok' ? (r.data.plans.find((x) => x.gradeLevel === cls.gradeLevel) ?? null) : null
      setPlan(p)
      setSubject((s) => (p && p.subjects.includes(s) ? s : (p?.subjects[0] ?? '')))
    })
  }, [getAccessToken, year.id, cls.gradeLevel])

  const load = useCallback(async () => {
    if (!subject || !termId) return setSheet(null)
    const r = await getSheet(getAccessToken, { classId: cls.id, subjectCode: subject, termId })
    if (r.kind !== 'ok') return setSheet(null)
    setSheet(r.data)
    setDraft(Object.fromEntries(r.data.marks.map((m) => [`${m.studentId}:${m.assessmentId}`, m.score === null ? '' : String(m.score)])))
    setMsg(null)
  }, [getAccessToken, cls.id, subject, termId])
  useEffect(() => {
    void load()
  }, [load])

  if (plan === undefined) return <div className="skeleton" style={{ height: 160 }} />
  if (plan === null) return <div className="empty-state">{t('grades.noPlan', { grade: cls.gradeLevel })}</div>

  const save = async () => {
    if (!sheet) return
    const entries = sheet.students.flatMap((s) =>
      sheet.assessments.map((a) => {
        const raw = (draft[`${s.id}:${a.id}`] ?? '').trim()
        return { studentId: s.id, assessmentId: a.id, score: raw === '' ? null : Number(raw) }
      }),
    )
    if (entries.some((e) => e.score !== null && Number.isNaN(e.score))) return setMsg({ tone: 'error', text: t('grades.error.notANumber') })
    const r = await saveSheet(getAccessToken, { classId: cls.id, subjectCode: subject, termId, entries })
    if (r.kind === 'ok') setMsg({ tone: 'ok', text: t('grades.saved', { n: r.data.saved }) })
    else setMsg({ tone: 'error', text: errorText(t, r.error) })
  }

  const locked = !sheet || sheet.released || !can('grades.enter')
  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('grades.tab.entry')}</h2>
        <div className="inline-form">
          <select
            className="select input--sm"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            aria-label={t('grades.subject')}
          >
            {plan.subjects.map((s) => (
              <option key={s} value={s}>
                {subjects.label(s)}
              </option>
            ))}
          </select>
          <select className="select input--sm" value={termId} onChange={(e) => setTermId(e.target.value)} aria-label={t('grades.term')}>
            {termsOf(year)
              .filter((x) => plan.terms.some((p) => p.termId === x.id))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      {sheet?.released && <p className="notice notice--warn">{t('grades.lockedReleased')}</p>}
      {!sheet ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : sheet.students.length === 0 ? (
        <div className="empty-state">{t('grades.noStudents')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table grade-sheet">
            <thead>
              <tr>
                <th>{t('grades.student')}</th>
                {sheet.assessments.map((a) => (
                  <th key={a.id} className="num">
                    {a.name}
                    <small className="card__hint"> /{a.maxScore}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.students.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name} <small className="card__hint mono">{s.studentNumber}</small>
                  </td>
                  {sheet.assessments.map((a) => {
                    const k = `${s.id}:${a.id}`
                    const v = draft[k] ?? ''
                    const bad = v.trim() !== '' && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) > a.maxScore)
                    return (
                      <td key={a.id} className="num">
                        <input
                          className={`input input--sm mono grade-input${bad ? ' input--bad' : ''}`}
                          inputMode="decimal"
                          dir="ltr"
                          value={v}
                          disabled={locked}
                          aria-label={`${s.name} — ${a.name}`}
                          onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {msg && <p className={msg.tone === 'ok' ? 'notice' : 'notice notice--warn'}>{msg.text}</p>}
      {!locked && (
        <div className="page__actions" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn--primary" onClick={() => void save()}>
            {t('grades.save')}
          </button>
        </div>
      )}
    </section>
  )
}

function ResultsView({ cls, year, canManage, canEnter }: { cls: SchoolClass; year: AcademicYear; canManage: boolean; canEnter: boolean }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const subjects = useLookup('subject')
  const [termId, setTermId] = useState(termsOf(year)[0]?.id ?? 'year')
  const [data, setData] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  const load = useCallback(async () => {
    const r = await getResults(getAccessToken, { classId: cls.id, termId })
    if (r.kind === 'ok') {
      setData(r.data)
      setError(null)
    } else {
      setData(null)
      setError(errorText(t, r.error))
    }
  }, [getAccessToken, cls.id, termId, t])
  useEffect(() => {
    void load()
  }, [load])

  const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
  const band = (b: GradeBand | null) => (b ? b.code : '')
  const doRelease = async (on: boolean) => {
    const r = on ? await release(getAccessToken, { classId: cls.id, termId }) : await unrelease(getAccessToken, { classId: cls.id, termId })
    if (r.kind !== 'ok') setError(errorText(t, r.error))
    await load()
  }
  const saveNote = async () => {
    if (!editing) return
    const r = await saveComment(getAccessToken, { studentId: editing.id, termId, comment: editing.text })
    if (r.kind !== 'ok') setError(errorText(t, r.error))
    setEditing(null)
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('grades.tab.results')}</h2>
        <div className="inline-form">
          <select className="select input--sm" value={termId} onChange={(e) => setTermId(e.target.value)} aria-label={t('grades.term')}>
            {termsOf(year).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="year">{t('grades.fullYear')}</option>
          </select>
          {data && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void openApiPage(getAccessToken, reportCardsPath({ classId: cls.id, termId, lang }))}
            >
              {t('grades.printCards')}
            </button>
          )}
          {data && canManage && (
            <button
              type="button"
              className={`btn btn--sm${data.released ? '' : ' btn--primary'}`}
              onClick={() => void doRelease(!data.released)}
            >
              {data.released ? t('grades.unrelease') : t('grades.release')}
            </button>
          )}
        </div>
      </div>
      {data?.released && <p className="notice">{t('grades.releasedNote')}</p>}
      {error && <p className="notice notice--warn">{error}</p>}
      {!data ? (
        !error && <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('grades.student')}</th>
                {data.subjects.map((s) => (
                  <th key={s} className="num">
                    {subjects.label(s)}
                  </th>
                ))}
                <th className="num">{t('grades.average')}</th>
                <th className="num">{t('grades.rank')}</th>
                <th>{t('grades.remark')}</th>
              </tr>
            </thead>
            <tbody>
              {data.students.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name} <small className="card__hint mono">{r.studentNumber}</small>
                  </td>
                  {data.subjects.map((s) => {
                    const x = r.subjects[s]
                    return (
                      <td key={s} className={`num mono${x?.passed === false ? ' text-bad' : ''}`}>
                        {pct(x?.percent ?? null)} <small>{band(x?.band ?? null)}</small>
                      </td>
                    )
                  })}
                  <td className="num mono">
                    <b>{pct(r.average)}</b> <small>{band(r.band)}</small>
                  </td>
                  <td className="num">{r.rank ?? '—'}</td>
                  <td>
                    {editing?.id === r.id ? (
                      <span className="inline-form">
                        <input
                          className="input input--sm"
                          value={editing.text}
                          maxLength={1000}
                          onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                        />
                        <button type="button" className="btn btn--sm btn--primary" onClick={() => void saveNote()}>
                          {t('grades.save')}
                        </button>
                      </span>
                    ) : (
                      <span className="bidi">
                        {r.comment ?? ''}{' '}
                        {canEnter && !data.released && termId !== 'year' && (
                          <button type="button" className="link-btn" onClick={() => setEditing({ id: r.id, text: r.comment ?? '' })}>
                            {r.comment ? t('grades.editRemark') : t('grades.addRemark')}
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <p className="card__hint">{t('grades.passMarkNote', { n: data.passMark })}</p>}
    </section>
  )
}

function Plans({ years, classes, canManage }: { years: AcademicYear[]; classes: SchoolClass[]; canManage: boolean }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const subjects = useLookup('subject')
  const [yearId, setYearId] = useState('')
  const [grade, setGrade] = useState('')
  const [plans, setPlans] = useState<Plan[]>([])
  const [draft, setDraft] = useState<Plan | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!yearId) setYearId(years.find((y) => y.current)?.id ?? years[0]?.id ?? '')
  }, [years, yearId])
  const year = years.find((y) => y.id === yearId) ?? null
  const grades = useMemo(
    () => [...new Set(classes.filter((c) => c.academicYearId === yearId).map((c) => c.gradeLevel))].sort(),
    [classes, yearId],
  )

  const load = useCallback(async () => {
    if (!yearId) return
    const r = await listPlans(getAccessToken, yearId)
    setPlans(r.kind === 'ok' ? r.data.plans : [])
  }, [getAccessToken, yearId])
  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!year || !grade) return setDraft(null)
    const existing = plans.find((p) => p.gradeLevel === grade)
    setDraft(
      existing
        ? structuredClone(existing)
        : {
            academicYearId: year.id,
            gradeLevel: grade,
            subjects: [],
            terms: termsOf(year).map((x) => ({
              termId: x.id,
              weight: 1,
              assessments: [
                { name: lang === 'ar' ? 'أعمال الفصل' : 'Coursework', nameAr: 'أعمال الفصل', weight: 40, maxScore: 40 },
                { name: lang === 'ar' ? 'الامتحان النهائي' : 'Final exam', nameAr: 'الامتحان النهائي', weight: 60, maxScore: 60 },
              ],
            })),
          },
    )
  }, [plans, grade, year, lang])
  useEffect(() => setMsg(null), [grade, yearId])

  const save = async () => {
    if (!draft) return
    // Only the plan's own fields: the server refuses anything else.
    const { academicYearId, gradeLevel, subjects: codes, terms } = draft
    const r = await savePlan(getAccessToken, { academicYearId, gradeLevel, subjects: codes, terms })
    if (r.kind === 'ok') {
      setMsg({ tone: 'ok', text: t('grades.planSaved') })
      await load()
    } else setMsg({ tone: 'error', text: errorText(t, r.error) })
  }
  const setTerm = (i: number, fn: (x: Plan['terms'][number]) => Plan['terms'][number]) =>
    setDraft((d) => (d ? { ...d, terms: d.terms.map((x, k) => (k === i ? fn(x) : x)) } : d))

  return (
    <>
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">{t('grades.tab.plans')}</h2>
          <div className="inline-form">
            <select className="select input--sm" value={yearId} onChange={(e) => setYearId(e.target.value)} aria-label={t('grades.year')}>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
            <select className="select input--sm" value={grade} onChange={(e) => setGrade(e.target.value)} aria-label={t('grades.grade')}>
              <option value="">{t('grades.pickGrade')}</option>
              {grades.map((g) => (
                <option key={g} value={g}>
                  {g} {plans.some((p) => p.gradeLevel === g) ? '✓' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="card__hint">{t('grades.plansHint')}</p>
        {year && termsOf(year).length === 0 && <p className="notice notice--warn">{t('grades.error.YEAR_HAS_NO_TERMS')}</p>}
        {draft && (
          <>
            <h3 className="card__subtitle">{t('grades.subjects')}</h3>
            <div className="chips-select">
              {subjects.active.map((s) => (
                <label key={s.code} className="checkbox-inline">
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={draft.subjects.includes(s.code)}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, subjects: e.target.checked ? [...d.subjects, s.code] : d.subjects.filter((x) => x !== s.code) } : d,
                      )
                    }
                  />
                  <span>{subjects.label(s.code)}</span>
                </label>
              ))}
            </div>
            {draft.terms.map((term, i) => (
              <div key={term.termId} className="plan-term">
                <div className="inline-form">
                  <h3 className="card__subtitle">{termsOf(year!).find((x) => x.id === term.termId)?.name ?? term.termId}</h3>
                  <label className="field field--inline">
                    <span>{t('grades.termWeight')}</span>
                    <input
                      className="input input--sm mono"
                      inputMode="decimal"
                      value={term.weight}
                      disabled={!canManage}
                      onChange={(e) => setTerm(i, (x) => ({ ...x, weight: Number(e.target.value) || 0 }))}
                    />
                  </label>
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('grades.assessment')}</th>
                      <th>{t('grades.assessmentAr')}</th>
                      <th className="num">{t('grades.weight')}</th>
                      <th className="num">{t('grades.maxScore')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {term.assessments.map((a, k) => {
                      const set = (patch: Partial<typeof a>) =>
                        setTerm(i, (x) => ({ ...x, assessments: x.assessments.map((y, j) => (j === k ? { ...y, ...patch } : y)) }))
                      return (
                        <tr key={a.id ?? `new-${k}`}>
                          <td>
                            <input
                              className="input input--sm"
                              value={a.name}
                              disabled={!canManage}
                              onChange={(e) => set({ name: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              className="input input--sm"
                              dir="rtl"
                              value={a.nameAr ?? ''}
                              disabled={!canManage}
                              onChange={(e) => set({ nameAr: e.target.value || null })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input input--sm mono grade-input"
                              inputMode="decimal"
                              value={a.weight}
                              disabled={!canManage}
                              onChange={(e) => set({ weight: Number(e.target.value) || 0 })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input input--sm mono grade-input"
                              inputMode="decimal"
                              value={a.maxScore}
                              disabled={!canManage}
                              onChange={(e) => set({ maxScore: Number(e.target.value) || 0 })}
                            />
                          </td>
                          <td>
                            {canManage && (
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => setTerm(i, (x) => ({ ...x, assessments: x.assessments.filter((_, j) => j !== k) }))}
                              >
                                {t('grades.remove')}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {canManage && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() =>
                      setTerm(i, (x) => ({ ...x, assessments: [...x.assessments, { name: '', nameAr: null, weight: 10, maxScore: 10 }] }))
                    }
                  >
                    {t('grades.addAssessment')}
                  </button>
                )}
              </div>
            ))}
            {msg && <p className={msg.tone === 'ok' ? 'notice' : 'notice notice--warn'}>{msg.text}</p>}
            {canManage && (
              <div className="page__actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn--primary" onClick={() => void save()}>
                  {t('grades.savePlan')}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <ScaleCard canManage={canManage} />
    </>
  )
}

function ScaleCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [bands, setBands] = useState<GradeBand[] | null>(null)
  const [passMark, setPassMark] = useState(50)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    void getGrading(getAccessToken).then((r) => {
      if (r.kind !== 'ok') return
      setBands(r.data.bands)
      setPassMark(r.data.passMark)
    })
  }, [getAccessToken])
  if (!bands) return null
  const set = (i: number, patch: Partial<GradeBand>) => setBands((b) => b!.map((x, k) => (k === i ? { ...x, ...patch } : x)))
  const save = async () => {
    const r = await saveGrading(getAccessToken, { bands, passMark })
    if (r.kind === 'ok') {
      setBands(r.data.bands)
      setMsg({ tone: 'ok', text: t('grades.scaleSaved') })
    } else setMsg({ tone: 'error', text: errorText(t, r.error) })
  }
  return (
    <section className="card">
      <h2 className="card__title">{t('grades.scale')}</h2>
      <p className="card__hint">{t('grades.scaleHint')}</p>
      <table className="table">
        <thead>
          <tr>
            <th className="num">{t('grades.from')}</th>
            <th>{t('grades.code')}</th>
            <th>{t('grades.label')}</th>
            <th>{t('grades.labelAr')}</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={i}>
              <td className="num">
                <input
                  className="input input--sm mono grade-input"
                  inputMode="decimal"
                  value={b.min}
                  disabled={!canManage}
                  onChange={(e) => set(i, { min: Number(e.target.value) || 0 })}
                />
              </td>
              <td>
                <input
                  className="input input--sm mono grade-input"
                  value={b.code}
                  disabled={!canManage}
                  onChange={(e) => set(i, { code: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input input--sm"
                  value={b.label}
                  disabled={!canManage}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input input--sm"
                  dir="rtl"
                  value={b.labelAr}
                  disabled={!canManage}
                  onChange={(e) => set(i, { labelAr: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="field field--inline">
        <span>{t('grades.passMark')}</span>
        <input
          className="input input--sm mono grade-input"
          inputMode="decimal"
          value={passMark}
          disabled={!canManage}
          onChange={(e) => setPassMark(Number(e.target.value) || 0)}
        />
      </label>
      {msg && <p className={msg.tone === 'ok' ? 'notice' : 'notice notice--warn'}>{msg.text}</p>}
      {canManage && (
        <div className="page__actions" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setBands((b) => [...b!, { min: 0, code: '', label: '', labelAr: '' }])}
          >
            {t('grades.addBand')}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()}>
            {t('grades.saveScale')}
          </button>
        </div>
      )}
    </section>
  )
}
