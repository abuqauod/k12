import { useEffect, useState } from 'react'
import { globalSearch } from '../../lib/searchApi'
import { listEmployees } from '../../lib/hrApi'
import { listStudents } from '../../lib/studentsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'

export interface PickedPerson {
  type: 'student' | 'employee'
  id: string
  label: string
}

/**
 * Finds a student (tenant search) or, for callers who can see HR, an
 * employee. Used to lend library books and to register for events.
 */
export function PersonPicker({
  onPick,
  types = ['student'],
  branchId,
  gradeLevels,
}: {
  onPick: (p: PickedPerson) => void
  types?: ('student' | 'employee')[]
  branchId?: string
  /** Offer only enrolled students in these grades (an event for Grade 4). */
  gradeLevels?: string[]
}) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const allowed = types.filter((x) => x === 'student' || can('hr.read'))
  const [type, setType] = useState<'student' | 'employee'>(allowed[0] ?? 'student')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<PickedPerson[]>([])

  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setResults([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      if (type === 'student' && gradeLevels && gradeLevels.length > 0) {
        void listStudents(getAccessToken, { branchId, search: needle, status: 'enrolled' }).then(
          (res) =>
            live &&
            setResults(
              res.kind === 'ok'
                ? res.data
                    .filter((s) => gradeLevels.some((g) => s.studentGroup === g || s.studentGroup.startsWith(`${g} `)))
                    .slice(0, 10)
                    .map((s) => ({
                      type: 'student',
                      id: s.id,
                      label: `${s.givenName} ${s.familyName} · ${s.studentNumber} · ${s.studentGroup}`,
                    }))
                : [],
            ),
        )
      } else if (type === 'student') {
        void globalSearch(getAccessToken, { q: needle, branchId }).then(
          (res) =>
            live &&
            setResults(
              res.kind === 'ok'
                ? res.data
                    .filter((r) => r.type === 'student')
                    .map((r) => ({ type: 'student', id: r.id, label: r.meta ? `${r.label} · ${r.meta}` : r.label }))
                : [],
            ),
        )
      } else {
        void listEmployees(getAccessToken, { q: needle, branchId, status: 'active' }).then(
          (res) =>
            live &&
            setResults(
              res.kind === 'ok' ? res.data.map((e) => ({ type: 'employee', id: e.id, label: `${e.fullName} · ${e.employeeNumber}` })) : [],
            ),
        )
      }
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [q, type, getAccessToken, branchId, gradeLevels])

  return (
    <div className="person-picker">
      <div className="inline-form" style={{ padding: 0 }}>
        {allowed.length > 1 && (
          <select
            className="input input--sm"
            value={type}
            onChange={(e) => setType(e.target.value as 'student' | 'employee')}
            aria-label={t('ops.picker.type')}
          >
            <option value="student">{t('ops.picker.student')}</option>
            <option value="employee">{t('ops.picker.employee')}</option>
          </select>
        )}
        <input
          className="input input--sm"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('ops.picker.search')}
          aria-label={t('ops.picker.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {results.length > 0 && (
        <ul className="person-picker__results" role="listbox">
          {results.slice(0, 8).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPick(r)
                  setQ('')
                  setResults([])
                }}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
