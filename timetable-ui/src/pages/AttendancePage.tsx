import { useEffect, useMemo, useState } from 'react'
import type { AttendanceStatus, RegisterRow } from '../lib/attendanceApi'
import { getRegister, markAttendance } from '../lib/attendanceApi'
import { listClasses } from '../lib/classesApi'
import type { SchoolClass } from '../domain/classes'
import { runAbsenceNotifications } from '../lib/notificationsApi'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

const STATUSES: AttendanceStatus[] = ['present', 'absent', 'late', 'excused', 'early_departure']

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Local edit on top of a fetched register row — kept separate from the
 * server response so a half-marked class survives a slow save without
 * flicker, and so "dirty" is easy to tell from "not yet marked". */
type Edit = { status: AttendanceStatus | null; note: string }

export function AttendancePage() {
  const { t } = useI18n()
  const { activeBranchId } = useApp()
  const { getAccessToken } = useAuth()

  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [classChoice, setClassChoice] = useState('')
  const classId = classChoice || classes[0]?.id || ''
  const [branchIdOfRegister, setBranchIdOfRegister] = useState<string | null>(null)

  const [date, setDate] = useState(today)
  const [rows, setRows] = useState<RegisterRow[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notifying, setNotifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!activeBranchId) {
      setClasses([])
      return
    }
    let cancelled = false
    void (async () => {
      const token = await getAccessToken()
      if (!token) return
      const result = await listClasses(token, { branchId: activeBranchId })
      if (!cancelled && result.kind === 'ok') setClasses(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [activeBranchId, getAccessToken])

  useEffect(() => {
    if (!classId) {
      setRows([])
      setEdits({})
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setSavedAt(null)
    setNotifyMsg(null)
    void (async () => {
      const token = await getAccessToken()
      if (!token) {
        if (!cancelled) setLoading(false)
        return
      }
      const result = await getRegister(token, date, classId)
      if (cancelled) return
      setLoading(false)
      if (result.kind === 'ok') {
        setRows(result.data.students)
        setBranchIdOfRegister(result.data.branchId)
        setEdits(
          Object.fromEntries(
            result.data.students.map((row) => [
              row.studentId,
              { status: row.status, note: row.note ?? '' },
            ]),
          ),
        )
      } else {
        setError(t('attendance.loadError'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [classId, date, getAccessToken, t])

  const setStatus = (studentId: string, status: AttendanceStatus) =>
    setEdits((current) => ({
      ...current,
      [studentId]: { status, note: current[studentId]?.note ?? '' },
    }))

  const setNote = (studentId: string, note: string) =>
    setEdits((current) => ({
      ...current,
      [studentId]: { status: current[studentId]?.status ?? null, note },
    }))

  const markAllPresent = () =>
    setEdits((current) => {
      const next = { ...current }
      for (const row of rows) next[row.studentId] = { status: 'present', note: next[row.studentId]?.note ?? '' }
      return next
    })

  const summary = useMemo(() => {
    const counts = { present: 0, absent: 0, late: 0, excused: 0, early_departure: 0, unmarked: 0 }
    for (const row of rows) {
      const status = edits[row.studentId]?.status ?? null
      if (status) counts[status]++
      else counts.unmarked++
    }
    return counts
  }, [rows, edits])

  const save = async () => {
    setSaving(true)
    setError(null)
    const token = await getAccessToken()
    if (!token) {
      setSaving(false)
      return
    }
    const records = rows
      .map((row) => ({ studentId: row.studentId, edit: edits[row.studentId] }))
      .filter(
        (r): r is { studentId: string; edit: Edit & { status: AttendanceStatus } } =>
          r.edit?.status != null,
      )
      .map(({ studentId, edit }) => ({ studentId, status: edit.status, note: edit.note.trim() || null }))
    if (records.length === 0) {
      setSaving(false)
      return
    }
    const result = await markAttendance(token, date, records)
    setSaving(false)
    if (result.kind === 'ok') setSavedAt(Date.now())
    else setError(t('attendance.saveError'))
  }

  const notify = async (studentId?: string) => {
    const branchId = branchIdOfRegister ?? activeBranchId
    if (!branchId) return
    setNotifying(true)
    setNotifyMsg(null)
    const token = await getAccessToken()
    if (!token) {
      setNotifying(false)
      return
    }
    const result = await runAbsenceNotifications(token, { branchId, date, studentId })
    setNotifying(false)
    if (result.kind === 'ok') {
      const { enqueued, alreadyQueued, delivered, dead } = result.data
      setNotifyMsg(
        enqueued + alreadyQueued === 0
          ? t('attendance.notifyNothing')
          : t('attendance.notifySent', { sent: delivered, failed: dead, skipped: alreadyQueued }),
      )
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.attendance')}</h1>
          <p className="page__subtitle">{t('attendance.subtitle')}</p>
        </div>
        <div className="page__actions">
          <button type="button" className="btn" onClick={markAllPresent} disabled={rows.length === 0}>
            {t('attendance.markAll')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void notify()}
            disabled={notifying || rows.length === 0}
          >
            {t('attendance.notifyAll')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={saving || rows.length === 0}
          >
            {saving ? t('students.saving') : t('attendance.save')}
          </button>
        </div>
      </header>

      <div className="card">
        <div className="page__actions" style={{ marginBlockEnd: 12 }}>
          <label className="field">
            <span>{t('attendance.pickGroup')}</span>
            <select
              className="input"
              value={classId}
              onChange={(event) => setClassChoice(event.target.value)}
            >
              {classes.length === 0 && <option value="">{t('attendance.pickGroup.empty')}</option>}
              {classes.map((klass) => (
                <option key={klass.id} value={klass.id}>
                  {klass.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('attendance.date')}</span>
            <input
              type="date"
              className="input"
              value={date}
              max={today()}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        </div>

        {!classId && <div className="empty-state">{t('attendance.noGroup')}</div>}
        {classId && loading && <div className="empty-state">{t('attendance.loading')}</div>}
        {error && (
          <p className="card__hint" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}
        {savedAt && (
          <p className="card__hint" style={{ color: 'var(--good, #2a9d5c)' }}>
            {t('attendance.saved')}
          </p>
        )}
        {notifyMsg && <p className="card__hint">{notifyMsg}</p>}

        {classId && !loading && rows.length === 0 && !error && (
          <div className="empty-state">{t('attendance.none')}</div>
        )}

        {classId && !loading && rows.length > 0 && (
          <>
            <p className="card__hint" style={{ marginBottom: 12 }}>
              {t('attendance.summary', summary)}
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th>{t('students.name')}</th>
                    <th style={{ width: 420 }}>{t('students.mode')}</th>
                    <th>{t('attendance.note')}</th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const edit = edits[row.studentId]
                    const canNotify = !edit?.status || edit.status === 'absent'
                    return (
                      <tr key={row.studentId}>
                        <td>
                          {row.givenName} {row.familyName}
                        </td>
                        <td>
                          <div className="segmented">
                            {STATUSES.map((status) => (
                              <button
                                key={status}
                                type="button"
                                aria-pressed={edit?.status === status}
                                onClick={() => setStatus(row.studentId, status)}
                              >
                                {t(`attendance.status.${status}` as TranslationKey)}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <input
                            className="cell-input"
                            placeholder={t('attendance.notePlaceholder')}
                            value={edit?.note ?? ''}
                            onChange={(event) => setNote(row.studentId, event.target.value)}
                          />
                        </td>
                        <td>
                          {canNotify && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={notifying}
                              onClick={() => void notify(row.studentId)}
                            >
                              {t('attendance.notify')}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
