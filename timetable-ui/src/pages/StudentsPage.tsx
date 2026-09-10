import { useEffect, useMemo, useRef, useState } from 'react'
import type { Student, TransportMode } from '../domain/students'
import { TRANSPORT_MODES, auditStudents, isValidPhone } from '../domain/students'
import type { NewStudent } from '../lib/studentsApi'
import { createStudent, listStudents, updateStudent } from '../lib/studentsApi'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type ModeFilter = TransportMode | 'ALL' | 'ISSUES'

const NEW_PREFIX = 'NEW-'

/** Everything the server needs to create a row — the four fields the schema
 * requires with no default. Until all four are filled, a draft row stays
 * local-only rather than round-tripping a 400. */
function readyToCreate(student: Student): boolean {
  return Boolean(
    student.studentNumber.trim() && student.givenName.trim() && student.familyName.trim() && student.studentGroup.trim(),
  )
}

function toPayload(student: Student): NewStudent {
  const { id: _id, active: _active, ...rest } = student
  return rest
}

export function StudentsPage() {
  const { t, n } = useI18n()
  const { students, setStudents, fleet } = useApp()
  const { getAccessToken } = useAuth()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ModeFilter>('ALL')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [pendingSaves, setPendingSaves] = useState(0)

  // The server is the source of truth once reachable — the roster loaded
  // from localStorage (or the bundled sample) is only what renders until
  // then, so the page is never empty on first paint.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const token = await getAccessToken()
      if (!token) {
        if (!cancelled) setLoading(false)
        return
      }
      const result = await listStudents(token)
      if (cancelled) return
      setLoading(false)
      if (result.kind === 'ok') setStudents(result.data)
      else setLoadError(true)
    })()
    return () => {
      cancelled = true
    }
    // Runs once on mount — the roster then lives in AppContext like the rest of the app's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced per-row save: rapid keystrokes coalesce into one request per
  // row rather than one per character.
  const pending = useRef<Record<string, Partial<NewStudent>>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const latestStudents = useRef(students)
  latestStudents.current = students

  const flush = async (id: string) => {
    const changes = pending.current[id]
    delete pending.current[id]
    if (!changes) return
    const row = latestStudents.current.find((s) => s.id === id)
    if (!row) return

    const token = await getAccessToken()
    if (!token) return

    setPendingSaves((count) => count + 1)
    try {
      if (id.startsWith(NEW_PREFIX)) {
        if (!readyToCreate(row)) return
        const result = await createStudent(token, toPayload(row))
        if (result.kind === 'ok') {
          setStudents(latestStudents.current.map((s) => (s.id === id ? { ...s, id: result.data.id } : s)))
        }
      } else {
        await updateStudent(token, id, changes)
      }
    } finally {
      setPendingSaves((count) => count - 1)
    }
  }

  const scheduleSave = (id: string, changes: Partial<NewStudent>) => {
    pending.current[id] = { ...pending.current[id], ...changes }
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => void flush(id), 700)
  }

  useEffect(
    () => () => {
      // Flush anything still pending rather than lose it on navigation.
      for (const id of Object.keys(timers.current)) {
        clearTimeout(timers.current[id])
        void flush(id)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

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

  const patch = (index: number, changes: Partial<Student>) => {
    const id = students[index]!.id
    setStudents(students.map((student, i) => (i === index ? { ...student, ...changes } : student)))
    scheduleSave(id, changes)
  }

  // No delete endpoint yet — a real withdrawal should flip `status` to
  // 'withdrawn' server-side, not erase the record. Until that lands this
  // only removes the row from view; it reappears on the next server fetch.
  const remove = (index: number) => setStudents(students.filter((_, i) => i !== index))

  const add = () =>
    setStudents([
      {
        id: `${NEW_PREFIX}${Date.now().toString(36)}`,
        studentNumber: '',
        givenName: '',
        familyName: '',
        studentGroup: '',
        stopId: fleet.stops[0]?.id ?? '',
        transportMode: 'TWO_WAY',
        primaryPhone: '',
        secondaryPhone: '',
        active: true,
        status: 'enrolled',
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
          {pendingSaves > 0 && <span className="card__hint">{t('students.saving')}</span>}
          <button type="button" className="btn btn--primary" onClick={add}>
            {t('students.add')}
          </button>
        </div>
      </header>

      {loading && <p className="card__hint">{t('students.syncing')}</p>}
      {loadError && <p className="card__hint" style={{ color: 'var(--bad)' }}>{t('students.syncError')}</p>}

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
