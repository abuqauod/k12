import { useMemo, useState } from 'react'
import type { DayOfWeek, Problem, Solution } from '../domain/types'
import { DAYS_OF_WEEK } from '../domain/types'
import { coverage, hhmm, naturalCompare, unique } from '../lib/view'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type Tab = 'lessons' | 'timeslots' | 'rooms' | 'availability'

interface Props {
  problem: Problem
  onChange: (next: Problem) => void
  solution?: Solution | null
}

const TABS: Array<{ id: Tab; key: TranslationKey }> = [
  { id: 'lessons', key: 'panel.lessons' },
  { id: 'timeslots', key: 'panel.timeslots' },
  { id: 'rooms', key: 'panel.rooms' },
  { id: 'availability', key: 'panel.blocks' },
]

export function DataPanel({ problem, onChange, solution }: Props) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('lessons')
  const [query, setQuery] = useState('')

  const counts: Record<Tab, number> = {
    lessons: problem.lessons.length,
    timeslots: problem.timeslots.length,
    rooms: problem.rooms.length,
    availability: problem.unavailability.length,
  }

  return (
    <>
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
            <span className="count">{counts[entry.id]}</span>
          </button>
        ))}
      </div>

      {tab === 'lessons' && (
        <LessonsTab
          problem={problem}
          onChange={onChange}
          solution={solution}
          query={query}
          setQuery={setQuery}
        />
      )}
      {tab === 'timeslots' && <TimeslotsTab problem={problem} onChange={onChange} />}
      {tab === 'rooms' && <RoomsTab problem={problem} onChange={onChange} />}
      {tab === 'availability' && <AvailabilityTab problem={problem} onChange={onChange} />}
    </>
  )
}

/* ------------------------------------------------------------------ lessons */

function LessonsTab({
  problem,
  onChange,
  solution,
  query,
  setQuery,
}: Props & { query: string; setQuery: (value: string) => void }) {
  const { t, n } = useI18n()

  const assignments = useMemo(
    () => new Map((solution?.assignments ?? []).map((a) => [a.lessonId, a])),
    [solution],
  )

  /**
   * Locking freezes a lesson where the solver just put it, so the next run
   * keeps it and re-arranges everything else around it.
   */
  const toggleLock = (index: number) => {
    const lesson = problem.lessons[index]
    if (lesson.pinnedTimeslotId) {
      patch(index, { pinnedTimeslotId: undefined })
      return
    }
    const current = assignments.get(lesson.id)
    if (!current?.timeslotId) return
    patch(index, { pinnedTimeslotId: current.timeslotId })
  }
  const needle = query.trim().toLowerCase()
  const rows = problem.lessons
    .map((lesson, index) => ({ lesson, index }))
    .filter(
      ({ lesson }) =>
        needle === '' ||
        `${lesson.id} ${lesson.subject} ${lesson.teacher} ${lesson.studentGroup}`
          .toLowerCase()
          .includes(needle),
    )

  const patch = (index: number, changes: Partial<Problem['lessons'][number]>) => {
    const lessons = problem.lessons.map((lesson, i) =>
      i === index ? { ...lesson, ...changes } : lesson,
    )
    onChange({ ...problem, lessons })
  }

  const remove = (index: number) => {
    onChange({ ...problem, lessons: problem.lessons.filter((_, i) => i !== index) })
  }

  const add = () => {
    const nextNumber = problem.lessons.length + 1
    onChange({
      ...problem,
      lessons: [
        ...problem.lessons,
        {
          id: `L-${String(nextNumber).padStart(3, '0')}`,
          subject: t('lessons.newSubject'),
          teacher: problem.lessons[0]?.teacher ?? t('lessons.unassignedTeacher'),
          studentGroup: problem.lessons[0]?.studentGroup ?? 'Grade 1-A',
        },
      ],
    })
  }

  const cohorts = coverage(problem)

  return (
    <>
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('lessons.title')}</h3>
          <button type="button" className="btn btn--sm" onClick={add}>
            {t('lessons.add')}
          </button>
        </div>
        <input
          className="input"
          style={{ width: '100%' }}
          placeholder={t('lessons.filter')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 62 }}>{t('lessons.col.id')}</th>
            <th>{t('lessons.col.subject')}</th>
            <th>{t('lessons.col.teacher')}</th>
            <th>{t('lessons.col.cohort')}</th>
            <th style={{ width: 44 }}>{t('lessons.col.double')}</th>
            <th style={{ width: 38 }}>{t('lessons.col.lock')}</th>
            <th style={{ width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ lesson, index }) => (
            <tr key={lesson.id + index}>
              <td className="mono">{lesson.id}</td>
              <td>
                <input
                  className="cell-input"
                  value={lesson.subject}
                  onChange={(event) => patch(index, { subject: event.target.value })}
                />
              </td>
              <td>
                <input
                  className="cell-input"
                  value={lesson.teacher}
                  onChange={(event) => patch(index, { teacher: event.target.value })}
                />
              </td>
              <td>
                <input
                  className="cell-input"
                  value={lesson.studentGroup}
                  onChange={(event) => patch(index, { studentGroup: event.target.value })}
                />
              </td>
              <td style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={lesson.doublePeriod === true}
                  onChange={(event) => patch(index, { doublePeriod: event.target.checked })}
                  aria-label={t('lessons.doublePeriod')}
                />
              </td>
              <td style={{ textAlign: 'center' }}>
                <button
                  type="button"
                  className={`lock-btn${lesson.pinnedTimeslotId ? ' lock-btn--on' : ''}`}
                  onClick={() => toggleLock(index)}
                  disabled={!lesson.pinnedTimeslotId && !assignments.get(lesson.id)?.timeslotId}
                  title={lesson.pinnedTimeslotId ? t('lessons.unlockHint') : t('lessons.lockHint')}
                  aria-pressed={Boolean(lesson.pinnedTimeslotId)}
                  aria-label={t('lessons.lock')}
                >
                  {lesson.pinnedTimeslotId ? '🔒' : '🔓'}
                </button>
              </td>
              <td>
                <div className="row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => remove(index)}
                    aria-label={`Delete ${lesson.id}`}
                  >
                    ×
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length === 0 && <div className="panel">{t('lessons.none')}</div>}

      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('lessons.loadTitle')}</h3>
        </div>
        {cohorts.map((entry) => (
          <div key={entry.group} style={{ marginBlockEnd: 8 }}>
            <div className="stat-row" style={{ borderBlockEnd: 'none', padding: 0 }}>
              <span>{entry.group}</span>
              <b>
                {n(entry.scheduled)}/{n(entry.capacity)}
              </b>
            </div>
            <div className="meter">
              <i style={{ width: `${Math.min(100, (entry.scheduled / entry.capacity) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/* ---------------------------------------------------------------- timeslots */

function TimeslotsTab({ problem, onChange }: Props) {
  const { t, n, dayShort } = useI18n()
  const patch = (index: number, changes: Partial<Problem['timeslots'][number]>) => {
    const timeslots = problem.timeslots.map((slot, i) =>
      i === index ? { ...slot, ...changes } : slot,
    )
    onChange({ ...problem, timeslots })
  }

  const remove = (index: number) => {
    const removed = problem.timeslots[index]
    onChange({
      ...problem,
      timeslots: problem.timeslots.filter((_, i) => i !== index),
      unavailability: problem.unavailability.filter((entry) => entry.timeslotId !== removed.id),
      lessons: problem.lessons.map((lesson) =>
        lesson.pinnedTimeslotId === removed.id ? { ...lesson, pinnedTimeslotId: undefined } : lesson,
      ),
    })
  }

  const add = () => {
    const last = problem.timeslots[problem.timeslots.length - 1]
    onChange({
      ...problem,
      timeslots: [
        ...problem.timeslots,
        {
          id: `TS-${problem.timeslots.length + 1}`,
          dayOfWeek: last?.dayOfWeek ?? 'MONDAY',
          startTime: last?.endTime ?? '08:30:00',
          endTime: last?.endTime ?? '09:15:00',
        },
      ],
    })
  }

  return (
    <>
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('timeslots.title')}</h3>
          <button type="button" className="btn btn--sm" onClick={add}>
            {t('timeslots.add')}
          </button>
        </div>
        <p className="panel__hint">
          {t('timeslots.hint', {
            slots: n(problem.timeslots.length),
            rooms: n(problem.rooms.length),
            placements: n(problem.timeslots.length * problem.rooms.length),
            lessons: n(problem.lessons.length),
          })}
        </p>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 66 }}>{t('lessons.col.id')}</th>
            <th>{t('timeslots.col.day')}</th>
            <th style={{ width: 72 }}>{t('timeslots.col.start')}</th>
            <th style={{ width: 72 }}>{t('timeslots.col.end')}</th>
            <th style={{ width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {problem.timeslots.map((slot, index) => (
            <tr key={slot.id + index}>
              <td className="mono">{slot.id}</td>
              <td>
                <select
                  className="cell-input"
                  value={slot.dayOfWeek}
                  onChange={(event) => patch(index, { dayOfWeek: event.target.value as DayOfWeek })}
                >
                  {DAYS_OF_WEEK.map((day) => (
                    <option key={day} value={day}>
                      {dayShort(day)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="cell-input cell-input--num"
                  value={hhmm(slot.startTime)}
                  onChange={(event) => patch(index, { startTime: `${event.target.value}:00` })}
                />
              </td>
              <td>
                <input
                  className="cell-input cell-input--num"
                  value={hhmm(slot.endTime)}
                  onChange={(event) => patch(index, { endTime: `${event.target.value}:00` })}
                />
              </td>
              <td>
                <div className="row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => remove(index)}
                    aria-label={`Delete ${slot.id}`}
                  >
                    ×
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/* -------------------------------------------------------------------- rooms */

function RoomsTab({ problem, onChange }: Props) {
  const { t } = useI18n()
  const patch = (index: number, changes: Partial<Problem['rooms'][number]>) => {
    const rooms = problem.rooms.map((room, i) => (i === index ? { ...room, ...changes } : room))
    onChange({ ...problem, rooms })
  }

  const remove = (index: number) => {
    const removed = problem.rooms[index]
    onChange({
      ...problem,
      rooms: problem.rooms.filter((_, i) => i !== index),
      lessons: problem.lessons.map((lesson) =>
        lesson.pinnedRoomId === removed.id ? { ...lesson, pinnedRoomId: undefined } : lesson,
      ),
    })
  }

  const add = () => {
    onChange({
      ...problem,
      rooms: [
        ...problem.rooms,
        { id: `RM-${problem.rooms.length + 1}`, name: t('rooms.newRoom'), capacity: 30 },
      ],
    })
  }

  return (
    <>
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('rooms.title')}</h3>
          <button type="button" className="btn btn--sm" onClick={add}>
            {t('rooms.add')}
          </button>
        </div>
        <p className="panel__hint">
          {t('rooms.hint')}
        </p>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 62 }}>{t('lessons.col.id')}</th>
            <th>{t('rooms.col.name')}</th>
            <th style={{ width: 66 }}>{t('rooms.col.seats')}</th>
            <th style={{ width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {problem.rooms.map((room, index) => (
            <tr key={room.id + index}>
              <td className="mono">{room.id}</td>
              <td>
                <input
                  className="cell-input"
                  value={room.name}
                  onChange={(event) => patch(index, { name: event.target.value })}
                />
              </td>
              <td>
                <input
                  className="cell-input cell-input--num"
                  value={room.capacity ?? ''}
                  onChange={(event) =>
                    patch(index, {
                      capacity: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
              </td>
              <td>
                <div className="row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => remove(index)}
                    aria-label={`Delete ${room.id}`}
                  >
                    ×
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/* ------------------------------------------------------------- availability */

function AvailabilityTab({ problem, onChange }: Props) {
  const { t, n, dayShort } = useI18n()
  const teachers = useMemo(
    () => unique(problem.lessons.map((lesson) => lesson.teacher)).sort(naturalCompare),
    [problem.lessons],
  )
  const [teacher, setTeacher] = useState(teachers[0] ?? '')
  const [day, setDay] = useState<DayOfWeek>('MONDAY')

  const blockDay = () => {
    const target = teacher || teachers[0]
    if (!target) return
    const ids = problem.timeslots.filter((slot) => slot.dayOfWeek === day).map((slot) => slot.id)
    const existing = new Set(
      problem.unavailability
        .filter((entry) => entry.teacher === target)
        .map((entry) => entry.timeslotId),
    )
    const additions = ids
      .filter((id) => !existing.has(id))
      .map((id) => ({ teacher: target, timeslotId: id }))
    onChange({ ...problem, unavailability: [...problem.unavailability, ...additions] })
  }

  const grouped = useMemo(() => {
    const slotById = new Map(problem.timeslots.map((slot) => [slot.id, slot]))
    const map = new Map<string, { teacher: string; day: DayOfWeek; count: number }>()
    for (const entry of problem.unavailability) {
      const slot = slotById.get(entry.timeslotId)
      if (!slot) continue
      const key = `${entry.teacher}|${slot.dayOfWeek}`
      const current = map.get(key)
      if (current) current.count += 1
      else map.set(key, { teacher: entry.teacher, day: slot.dayOfWeek, count: 1 })
    }
    return [...map.values()].sort(
      (a, b) => naturalCompare(a.teacher, b.teacher) || naturalCompare(a.day, b.day),
    )
  }, [problem.unavailability, problem.timeslots])

  const removeGroup = (target: { teacher: string; day: DayOfWeek }) => {
    const slotById = new Map(problem.timeslots.map((slot) => [slot.id, slot]))
    onChange({
      ...problem,
      unavailability: problem.unavailability.filter((entry) => {
        const slot = slotById.get(entry.timeslotId)
        return !(entry.teacher === target.teacher && slot?.dayOfWeek === target.day)
      }),
    })
  }

  return (
    <>
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('blocks.title')}</h3>
        </div>
        <p className="panel__hint">
          {t('blocks.hint')}
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select
            className="select"
            value={teacher}
            onChange={(event) => setTeacher(event.target.value)}
            style={{ flex: 1 }}
          >
            {teachers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={day}
            onChange={(event) => setDay(event.target.value as DayOfWeek)}
          >
            {DAYS_OF_WEEK.map((entry) => (
              <option key={entry} value={entry}>
                {dayShort(entry)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm" onClick={blockDay}>
            {t('blocks.blockDay')}
          </button>
        </div>
      </div>

      <div className="panel">
        {grouped.length === 0 ? (
          <div className="empty-state">{t('blocks.none')}</div>
        ) : (
          grouped.map((entry) => (
            <div className="stat-row" key={`${entry.teacher}|${entry.day}`}>
              <span>
                {entry.teacher} <span className="mono">· {dayShort(entry.day)}</span>
              </span>
              <span>
                <b>{n(entry.count)}</b>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => removeGroup(entry)}
                  aria-label={t('blocks.unblock', { teacher: entry.teacher, day: dayShort(entry.day) })}
                >
                  ×
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </>
  )
}
