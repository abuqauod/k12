import { useMemo, useState } from 'react'
import type { Student, TransportMode } from '../domain/students'
import { TRANSPORT_MODES, auditStudents, isValidPhone } from '../domain/students'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type ModeFilter = TransportMode | 'ALL' | 'ISSUES'

export function StudentsPage() {
  const { t, n } = useI18n()
  const { students, setStudents, fleet } = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ModeFilter>('ALL')

  const issues = useMemo(() => auditStudents(students), [students])
  const issueIds = useMemo(() => new Set(issues.map((i) => i.studentId)), [issues])

  const stopName = useMemo(
    () => new Map(fleet.stops.map((stop) => [stop.id, stop.name])),
    [fleet.stops],
  )

  const counts = useMemo(() => {
    const out = { TWO_WAY: 0, MORNING: 0, EVENING: 0, NONE: 0 }
    for (const student of students) {
      if (student.active) out[student.transportMode]++
    }
    return out
  }, [students])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return students
      .map((student, index) => ({ student, index }))
      .filter(({ student }) => {
        if (filter === 'ISSUES' && !issueIds.has(student.id)) return false
        if (filter !== 'ALL' && filter !== 'ISSUES' && student.transportMode !== filter) return false
        if (!needle) return true
        return `${student.studentNumber} ${student.givenName} ${student.familyName} ${student.givenNameAr ?? ''} ${student.familyNameAr ?? ''} ${student.studentGroup} ${student.primaryPhone} ${student.secondaryPhone}`
          .toLowerCase()
          .includes(needle)
      })
  }, [students, query, filter, issueIds])

  const patch = (index: number, changes: Partial<Student>) =>
    setStudents(students.map((student, i) => (i === index ? { ...student, ...changes } : student)))

  const remove = (index: number) => setStudents(students.filter((_, i) => i !== index))

  const add = () =>
    setStudents([
      {
        id: `S-${Date.now().toString(36)}`,
        studentNumber: '',
        givenName: '',
        familyName: '',
        studentGroup: fleet.stops.length ? '' : '',
        stopId: fleet.stops[0]?.id ?? '',
        transportMode: 'TWO_WAY',
        primaryPhone: '',
        secondaryPhone: '',
        active: true,
      },
      ...students,
    ])

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.students')}</h1>
          <p className="page__subtitle">{t('students.subtitle')}</p>
        </div>
        <div className="page__actions">
          <button type="button" className="btn btn--primary" onClick={add}>
            {t('students.add')}
          </button>
        </div>
      </header>

      <section className="kpi-row">
        <article className="kpi">
          <span className="kpi__label">{t('students.total')}</span>
          <b className="kpi__value">{n(students.filter((s) => s.active).length)}</b>
        </article>
        <article className="kpi">
          <span className="kpi__label">{t('students.mode.TWO_WAY')}</span>
          <b className="kpi__value">{n(counts.TWO_WAY)}</b>
          <small className="kpi__hint">{t('students.bothRuns')}</small>
        </article>
        <article className="kpi">
          <span className="kpi__label">{t('students.mode.MORNING')}</span>
          <b className="kpi__value">{n(counts.MORNING)}</b>
        </article>
        <article className="kpi">
          <span className="kpi__label">{t('students.mode.EVENING')}</span>
          <b className="kpi__value">{n(counts.EVENING)}</b>
        </article>
        <article className="kpi">
          <span className="kpi__label">{t('students.issues')}</span>
          <b className="kpi__value" style={{ color: issues.length ? 'var(--bad)' : undefined }}>
            {n(issueIds.size)}
          </b>
          <small className="kpi__hint">{t('students.issuesHint')}</small>
        </article>
      </section>

      <div className="card">
        <div className="page__actions" style={{ marginBlockEnd: 12 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('students.filter')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="segmented">
            {(['ALL', 'TWO_WAY', 'MORNING', 'EVENING', 'ISSUES'] as ModeFilter[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                onClick={() => setFilter(option)}
              >
                {option === 'ALL'
                  ? t('inspector.filter.all')
                  : option === 'ISSUES'
                    ? t('students.issues')
                    : t(`students.mode.${option}` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 940 }}>
            <thead>
              <tr>
                <th style={{ width: 92 }}>{t('students.number')}</th>
                <th>{t('students.name')}</th>
                <th style={{ width: 120 }}>{t('lessons.col.cohort')}</th>
                <th style={{ width: 130 }}>{t('students.stop')}</th>
                <th style={{ width: 128 }}>{t('students.mode')}</th>
                <th style={{ width: 148 }}>{t('students.primaryPhone')}</th>
                <th style={{ width: 148 }}>{t('students.secondaryPhone')}</th>
                <th style={{ width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ student, index }) => {
                const primaryBad = !isValidPhone(student.primaryPhone)
                const secondaryBad = !isValidPhone(student.secondaryPhone)
                const sameNumber =
                  !secondaryBad &&
                  student.secondaryPhone.replace(/\D/g, '') ===
                    student.primaryPhone.replace(/\D/g, '')
                return (
                  <tr key={student.id}>
                    <td>
                      <input
                        className="cell-input mono"
                        value={student.studentNumber}
                        onChange={(event) => patch(index, { studentNumber: event.target.value })}
                      />
                    </td>
                    <td>
                      <div className="name-cell">
                        <input
                          className="cell-input"
                          value={student.givenName}
                          placeholder={t('students.givenName')}
                          onChange={(event) => patch(index, { givenName: event.target.value })}
                        />
                        <input
                          className="cell-input"
                          value={student.familyName}
                          placeholder={t('students.familyName')}
                          onChange={(event) => patch(index, { familyName: event.target.value })}
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        value={student.studentGroup}
                        onChange={(event) => patch(index, { studentGroup: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="cell-input"
                        value={student.stopId}
                        onChange={(event) => patch(index, { stopId: event.target.value })}
                      >
                        <option value="">{t('students.noStop')}</option>
                        {fleet.stops.map((stop) => (
                          <option key={stop.id} value={stop.id}>
                            {stopName.get(stop.id)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="cell-input"
                        value={student.transportMode}
                        onChange={(event) =>
                          patch(index, { transportMode: event.target.value as TransportMode })
                        }
                      >
                        {TRANSPORT_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {t(`students.mode.${mode}` as TranslationKey)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className={`cell-input${primaryBad ? ' cell-input--bad' : ''}`}
                        value={student.primaryPhone}
                        placeholder="+962 79 000 0000"
                        onChange={(event) => patch(index, { primaryPhone: event.target.value })}
                        aria-invalid={primaryBad}
                      />
                    </td>
                    <td>
                      <input
                        className={`cell-input${secondaryBad || sameNumber ? ' cell-input--bad' : ''}`}
                        value={student.secondaryPhone}
                        placeholder="+962 79 000 0000"
                        onChange={(event) => patch(index, { secondaryPhone: event.target.value })}
                        aria-invalid={secondaryBad || sameNumber}
                        title={sameNumber ? t('students.sameNumber') : undefined}
                      />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => remove(index)}
                          aria-label={`${t('students.remove')} ${student.studentNumber}`}
                        >
                          ×
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && <div className="empty-state">{t('students.none')}</div>}
        <p className="card__hint" style={{ margin: '12px 0 0' }}>
          {t('students.demandNote')}
        </p>
      </div>
    </div>
  )
}
