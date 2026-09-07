import { useMemo } from 'react'
import type { Calendar, DayOfWeek, Problem } from '../domain/types'
import { DAYS_OF_WEEK } from '../domain/types'
import { applyCalendar, breakAt, schoolDays } from '../domain/calendar'
import { hhmm, naturalCompare, unique } from '../lib/view'
import { useI18n } from '../i18n/I18nContext'

interface Props {
  problem: Problem
  onChange: (next: Problem) => void
  /** Rendered inside the caller's own panel when false. */
  standalone?: boolean
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * The shape-of-the-week controls. Shared by the timetable editor and the
 * Settings page so the two can never drift apart — both write the same
 * `problem.calendar` and regenerate the timeslots through `applyCalendar`.
 */
export function SchoolWeekFields({ problem, onChange }: Props) {
  const { t, day: dayName } = useI18n()
  const { calendar } = problem

  const cohorts = useMemo(
    () => unique(problem.lessons.map((lesson) => lesson.studentGroup)).sort(naturalCompare),
    [problem.lessons],
  )

  /** Every calendar edit regenerates the timeslots, so the grid stays in sync. */
  const patch = (changes: Partial<Calendar>) =>
    onChange(applyCalendar(problem, { ...calendar, ...changes }))

  const days = schoolDays(calendar)
  const firstDay = problem.timeslots.filter((slot) => slot.dayOfWeek === days[0])
  const dayEnds = firstDay.length > 0 ? hhmm(firstDay[firstDay.length - 1].endTime) : '—'

  // A cohort only loses the breaks that name it, so staggered lunches cost one
  // period each, not one per rule. Report the range across cohorts.
  const teachingPeriods = (cohorts.length > 0 ? cohorts : ['']).map((group) => {
    let reserved = 0
    for (let period = 0; period < calendar.periodsPerDay; period++) {
      if (breakAt(calendar, group, period)) reserved++
    }
    return calendar.periodsPerDay - reserved
  })
  const minTeaching = Math.min(...teachingPeriods)
  const maxTeaching = Math.max(...teachingPeriods)
  const teachingLabel =
    minTeaching === maxTeaching ? `${minTeaching}` : `${minTeaching}–${maxTeaching}`

  return (
    <>
      <div className="field-grid">
        <label className="field">
          <span>{t('calendar.weekStart')}</span>
          <select
            className="select"
            value={calendar.weekStart}
            onChange={(event) => patch({ weekStart: event.target.value as DayOfWeek })}
          >
            {DAYS_OF_WEEK.map((day) => (
              <option key={day} value={day}>
                {dayName(day)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('calendar.days')}</span>
          <input
            className="input"
            type="number"
            min={1}
            max={7}
            value={calendar.schoolDays}
            onChange={(event) => patch({ schoolDays: clampNumber(Number(event.target.value), 1, 7) })}
          />
        </label>

        <label className="field">
          <span>{t('calendar.dayStart')}</span>
          <input
            className="input"
            type="time"
            value={hhmm(calendar.dayStart)}
            onChange={(event) => patch({ dayStart: `${event.target.value || '08:00'}:00` })}
          />
        </label>

        <label className="field">
          <span>{t('calendar.periodMinutes')}</span>
          <input
            className="input"
            type="number"
            min={5}
            max={180}
            step={5}
            value={calendar.periodMinutes}
            onChange={(event) =>
              patch({ periodMinutes: clampNumber(Number(event.target.value), 5, 180) })
            }
          />
        </label>

        <label className="field">
          <span>{t('calendar.periodsPerDay')}</span>
          <input
            className="input"
            type="number"
            min={1}
            max={32}
            value={calendar.periodsPerDay}
            onChange={(event) =>
              patch({ periodsPerDay: clampNumber(Number(event.target.value), 1, 32) })
            }
          />
        </label>
      </div>

      <p className="panel__hint" style={{ marginBlock: '10px 0' }}>
        {t('calendar.summary', {
          days: days.map((entry) => dayName(entry)).join(' · '),
          from: hhmm(calendar.dayStart),
          to: dayEnds,
          teaching: teachingLabel,
        })}
      </p>
    </>
  )
}
