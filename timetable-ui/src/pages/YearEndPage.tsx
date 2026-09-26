import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  commitRollover,
  getRollover,
  previewRollover,
  startNewYear,
  type RolloverAction,
  type RolloverCheck,
  type RolloverClass,
  type RolloverProposalRow,
  type RolloverRowInput,
} from '../lib/enrollmentsApi'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { listClasses } from '../lib/classesApi'
import { listLookups, lookupLabel, type LookupItem } from '../lib/settingsApi'
import type { SchoolClass } from '../domain/classes'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type Decision = { action: RolloverAction; toClassId: string | null; reasonCode: string | null }

/**
 * Year-end re-enrollment (SAMS 2.6) for the active branch. Step 1: decide
 * each student's next year (suggestions pre-filled), preview, then commit —
 * all rows or none. Step 2, when the new year begins: start every planned
 * place at once.
 */
export function YearEndPage() {
  const { t, n, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId, branches } = useApp()
  const [years, setYears] = useState<AcademicYear[]>([])
  const [fromYearId, setFromYearId] = useState('')
  const [toYearId, setToYearId] = useState('')
  const [rows, setRows] = useState<RolloverProposalRow[] | null>(null)
  const [toClasses, setToClasses] = useState<RolloverClass[]>([])
  const [fromClasses, setFromClasses] = useState<SchoolClass[]>([])
  const [reasons, setReasons] = useState<LookupItem[]>([])
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [classFilter, setClassFilter] = useState('')
  const [check, setCheck] = useState<RolloverCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)

  const branchId = activeBranchId ?? branches[0]?.id ?? ''
  const branchName = branches.find((b) => b.id === branchId)?.name ?? ''

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((res) => {
      if (res.kind !== 'ok') return
      const sorted = [...res.data].sort((a, b) => a.startDate.localeCompare(b.startDate))
      setYears(sorted)
      const i = Math.max(0, sorted.findIndex((y) => y.current))
      setFromYearId(sorted[i]?.id ?? '')
      setToYearId(sorted[i + 1]?.id ?? '')
    })
    void listLookups(getAccessToken, 'withdrawalReason', true).then((r) => r.kind === 'ok' && setReasons(r.data))
  }, [getAccessToken])

  useEffect(() => {
    if (!branchId) return
    void listClasses(getAccessToken, { branchId }).then((r) => r.kind === 'ok' && setFromClasses(r.data))
  }, [getAccessToken, branchId])

  const load = useCallback(async () => {
    if (!branchId || !fromYearId || !toYearId || fromYearId === toYearId) return
    setRows(null)
    setCheck(null)
    const res = await getRollover(getAccessToken, { branchId, fromYearId, toYearId })
    if (res.kind !== 'ok') return setMessage({ ok: false, text: t('profile.error.generic') })
    setRows(res.data.rows)
    setToClasses(res.data.toClasses)
    setDecisions(
      Object.fromEntries(
        res.data.rows
          .filter((r) => !r.existing)
          .map((r) => [r.studentId, { action: r.suggested.action, toClassId: r.suggested.toClassId, reasonCode: null }]),
      ),
    )
  }, [getAccessToken, branchId, fromYearId, toYearId, t])

  useEffect(() => {
    void load()
  }, [load])

  const classLabel = (id: string) => fromClasses.find((c) => c.id === id)?.label ?? toClasses.find((c) => c.id === id)?.label ?? '—'
  const errors = useMemo(() => new Map((check?.rows ?? []).filter((r) => !r.ok).map((r) => [r.studentId, r.error])), [check])
  const visible = (rows ?? []).filter((r) => !classFilter || r.fromClassId === classFilter)
  const open = (rows ?? []).filter((r) => !r.existing)
  const planned = (rows ?? []).filter((r) => r.existing?.status === 'pending').length

  const set = (studentId: string, change: Partial<Decision>) => {
    setCheck(null)
    setDecisions((d) => ({ ...d, [studentId]: { ...d[studentId]!, ...change } }))
  }

  /** Applies one action to every open row in the current view. */
  const setAll = (action: RolloverAction) => {
    setCheck(null)
    setDecisions((d) => {
      const next = { ...d }
      for (const r of visible) {
        if (r.existing) continue
        const toClassId =
          action === 'promote'
            ? r.suggested.toClassId
            : action === 'hold'
              ? (toClasses.find((c) => c.gradeLevel === r.fromGradeLevel)?.id ?? null)
              : null
        next[r.studentId] = { action, toClassId, reasonCode: next[r.studentId]?.reasonCode ?? null }
      }
      return next
    })
  }

  const input = (): RolloverRowInput[] =>
    open.map((r) => {
      const d = decisions[r.studentId]!
      return {
        studentId: r.studentId,
        action: d.action,
        toClassId: d.action === 'promote' || d.action === 'hold' ? d.toClassId : null,
        reasonCode: d.action === 'withdraw' ? d.reasonCode : null,
      }
    })

  const preview = async () => {
    setBusy(true)
    setMessage(null)
    const res = await previewRollover(getAccessToken, { branchId, fromYearId, toYearId, rows: input() })
    setBusy(false)
    if (res.kind !== 'ok') return setMessage({ ok: false, text: t('profile.error.generic') })
    setCheck(res.data)
  }

  const commit = async () => {
    setBusy(true)
    const res = await commitRollover(getAccessToken, { branchId, fromYearId, toYearId, rows: input() })
    setBusy(false)
    if (res.kind !== 'ok') {
      await preview()
      return setMessage({ ok: false, text: t('yearEnd.error.changed') })
    }
    setMessage({ ok: true, text: t('yearEnd.committed', summaryParams(res.data.summary)) })
    await load()
  }

  const start = async () => {
    setBusy(true)
    const res = await startNewYear(getAccessToken, { branchId, toYearId })
    setBusy(false)
    setConfirmStart(false)
    if (res.kind !== 'ok') return setMessage({ ok: false, text: t('yearEnd.error.start') })
    setMessage({ ok: true, text: t('yearEnd.started', { n: n(res.data.started) }) })
    await load()
  }

  const summaryParams = (s: Partial<Record<RolloverAction, number>>) => ({
    promote: n(s.promote ?? 0),
    hold: n(s.hold ?? 0),
    graduate: n(s.graduate ?? 0),
    withdraw: n(s.withdraw ?? 0),
  })

  if (!can('enrollments.assign')) {
    return (
      <div className="page">
        <div className="empty-state">{t('profile.error.forbidden')}</div>
      </div>
    )
  }

  const toYearName = years.find((y) => y.id === toYearId)?.name ?? ''

  return (
    <div className="page student-page">
      <Link to="/students" className="card__link student-page__back">
        ← {t('profile.back')}
      </Link>
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('yearEnd.title')}</h1>
          <p className="page__subtitle">{t('yearEnd.subtitle', { branch: branchName })}</p>
        </div>
        <div className="page__actions">
          <label className="field">
            <span>{t('yearEnd.from')}</span>
            <select className="input" value={fromYearId} onChange={(e) => setFromYearId(e.target.value)}>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('yearEnd.to')}</span>
            <select className="input" value={toYearId} onChange={(e) => setToYearId(e.target.value)}>
              <option value="">—</option>
              {years.map((y) => (
                <option key={y.id} value={y.id} disabled={y.id === fromYearId}>
                  {y.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {message && (
        <p className={message.ok ? 'profile-save__ok' : 'login__error'} role="status">
          {message.text}
        </p>
      )}

      {!toYearId ? (
        <div className="empty-state">{t('yearEnd.noNextYear')}</div>
      ) : (
        <>
          <section className="card profile-card">
            <div className="card__head">
              <h2 className="card__title">{t('yearEnd.step1', { year: toYearName })}</h2>
              <span className="card__hint">{t('yearEnd.counts', { open: n(open.length), placed: n((rows?.length ?? 0) - open.length) })}</span>
            </div>
            <div className="break-card__row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <select className="input input--sm" value={classFilter} onChange={(e) => setClassFilter(e.target.value)} aria-label={t('yearEnd.filter')}>
                <option value="">{t('yearEnd.allClasses')}</option>
                {[...new Set((rows ?? []).map((r) => r.fromClassId))].map((id) => (
                  <option key={id} value={id}>
                    {classLabel(id)}
                  </option>
                ))}
              </select>
              <span className="card__hint">{t('yearEnd.setAll')}</span>
              {(['promote', 'hold', 'graduate'] as const).map((a) => (
                <button key={a} type="button" className="btn btn--sm" onClick={() => setAll(a)}>
                  {t(`yearEnd.action.${a}` as TranslationKey)}
                </button>
              ))}
            </div>
            {rows === null ? (
              <div className="skeleton" style={{ height: 160 }} />
            ) : rows.length === 0 ? (
              <div className="empty-state">{t('yearEnd.none')}</div>
            ) : (
              <div className="table-scroll">
                <table className="table" style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      <th>{t('yearEnd.student')}</th>
                      <th>{t('yearEnd.currentClass')}</th>
                      <th style={{ width: 150 }}>{t('yearEnd.action')}</th>
                      <th style={{ width: 220 }}>{t('yearEnd.nextClass')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const d = decisions[r.studentId]
                      const error = errors.get(r.studentId)
                      return (
                        <tr key={r.studentId} className={error ? 'row--error' : undefined}>
                          <td>
                            <Link to={`/students/${r.studentId}?tab=enrollment`}>{r.name}</Link>
                            <div className="docs__meta mono">{r.studentNumber}</div>
                          </td>
                          <td>{classLabel(r.fromClassId)}</td>
                          {r.existing || !d ? (
                            <td colSpan={2} className="docs__meta">
                              {t('yearEnd.alreadyPlaced', {
                                class: classLabel(r.existing?.classId ?? ''),
                                status: t(`enroll.status.${r.existing?.status ?? 'pending'}` as TranslationKey),
                              })}
                            </td>
                          ) : (
                            <>
                              <td>
                                <select
                                  className="input input--sm"
                                  value={d.action}
                                  aria-label={`${t('yearEnd.action')} ${r.name}`}
                                  onChange={(e) => {
                                    const action = e.target.value as RolloverAction
                                    set(r.studentId, {
                                      action,
                                      toClassId:
                                        action === 'hold'
                                          ? (toClasses.find((c) => c.gradeLevel === r.fromGradeLevel)?.id ?? null)
                                          : action === 'promote'
                                            ? r.suggested.toClassId
                                            : null,
                                    })
                                  }}
                                >
                                  {(['promote', 'hold', 'graduate', 'withdraw'] as const).map((a) => (
                                    <option key={a} value={a}>
                                      {t(`yearEnd.action.${a}` as TranslationKey)}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                {d.action === 'promote' || d.action === 'hold' ? (
                                  <select
                                    className="input input--sm"
                                    value={d.toClassId ?? ''}
                                    aria-label={`${t('yearEnd.nextClass')} ${r.name}`}
                                    onChange={(e) => set(r.studentId, { toClassId: e.target.value || null })}
                                  >
                                    <option value="">{t('yearEnd.chooseClass')}</option>
                                    {toClasses
                                      .filter((c) => d.action !== 'hold' || c.gradeLevel === r.fromGradeLevel)
                                      .map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.label}
                                        </option>
                                      ))}
                                  </select>
                                ) : d.action === 'withdraw' ? (
                                  <select
                                    className="input input--sm"
                                    value={d.reasonCode ?? ''}
                                    aria-label={`${t('enroll.reasonCode')} ${r.name}`}
                                    onChange={(e) => set(r.studentId, { reasonCode: e.target.value || null })}
                                  >
                                    <option value="">{t('enroll.reasonCode')}…</option>
                                    {reasons
                                      .filter((x) => x.active)
                                      .map((x) => (
                                        <option key={x.code} value={x.code}>
                                          {lookupLabel(reasons, x.code, lang)}
                                        </option>
                                      ))}
                                  </select>
                                ) : (
                                  <span className="docs__meta">—</span>
                                )}
                                {error && <div className="docs__note">{t(`yearEnd.error.${error}` as TranslationKey)}</div>}
                              </td>
                            </>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {check && (
              <p className={check.ok ? 'profile-save__ok' : 'login__error'}>
                {check.ok
                  ? t('yearEnd.previewOk', { ...summaryParams(check.summary), start: check.startDate, close: check.closeDate })
                  : t('yearEnd.previewErrors', { n: n(check.rows.filter((r) => !r.ok).length) })}
              </p>
            )}
            <div className="page__actions">
              <button type="button" className="btn" disabled={busy || open.length === 0} onClick={() => void preview()}>
                {t('yearEnd.preview')}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || !check?.ok} onClick={() => void commit()}>
                {t('yearEnd.commit')}
              </button>
            </div>
          </section>

          <section className="card profile-card">
            <h2 className="card__title">{t('yearEnd.step2', { year: toYearName })}</h2>
            <p className="card__hint" style={{ margin: 0 }}>
              {t('yearEnd.step2Hint', { n: n(planned) })}
            </p>
            {confirmStart ? (
              <div className="page__actions">
                <span className="login__error">{t('yearEnd.startConfirm', { n: n(planned), year: toYearName })}</span>
                <button type="button" className="btn" onClick={() => setConfirmStart(false)}>
                  {t('docs.cancel')}
                </button>
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void start()}>
                  {t('yearEnd.start')}
                </button>
              </div>
            ) : (
              <div className="page__actions">
                <button type="button" className="btn btn--primary" disabled={busy || planned === 0} onClick={() => setConfirmStart(true)}>
                  {t('yearEnd.start')}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
