import { useMemo } from 'react'
import type { BreakRule } from '../domain/types'
import { applyCalendar } from '../domain/calendar'
import { naturalCompare, unique } from '../lib/view'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { clampNumber as clamp } from './SchoolWeekFields'

let breakSeq = 0

/**
 * Break rules for the school day. Editing any of them regenerates the
 * timeslots, so this writes through `applyCalendar` like the week fields do.
 */
export function BreaksEditor() {
  const { t, n } = useI18n()
  const { problem, setProblem } = useApp()
  const { calendar } = problem

  const cohorts = useMemo(
    () => unique(problem.lessons.map((lesson) => lesson.studentGroup)).sort(naturalCompare),
    [problem.lessons],
  )

  const patch = (changes: Partial<typeof calendar>) =>
    setProblem(applyCalendar(problem, { ...calendar, ...changes }))

  const patchBreak = (id: string, changes: Partial<BreakRule>) =>
    patch({
      breaks: calendar.breaks.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)),
    })

  const addBreak = () =>
    patch({
      breaks: [
        ...calendar.breaks,
        {
          id: `BR-${Date.now().toString(36)}-${breakSeq++}`,
          name: t('calendar.newBreak', { n: n(calendar.breaks.length + 1) }),
          kind: 'CLOCK',
          period: Math.min(calendar.periodsPerDay, calendar.breaks.length + 2),
          minutes: 15,
          studentGroups: [],
        },
      ],
    })

  const removeBreak = (id: string) =>
    patch({ breaks: calendar.breaks.filter((rule) => rule.id !== id) })

  const toggleCohort = (rule: BreakRule, group: string) => {
    const has = rule.studentGroups.includes(group)
    patchBreak(rule.id, {
      studentGroups: has
        ? rule.studentGroups.filter((entry) => entry !== group)
        : [...rule.studentGroups, group],
    })
  }

  return (
    <>
      <div className="page__actions" style={{ marginBlockEnd: 10 }}>
        <button type="button" className="btn btn--sm" onClick={addBreak}>
          {t('calendar.addBreak')}
        </button>
      </div>
      <p className="card__hint">{t('calendar.breakHint')}</p>

      {calendar.breaks.length === 0 && (
        <div className="empty-state">{t('calendar.noBreaks')}</div>
      )}

      {calendar.breaks.map((rule) => (
        <div className="break-card" key={rule.id}>
          <div className="break-card__head">
            <input
              className="cell-input"
              value={rule.name}
              onChange={(event) => patchBreak(rule.id, { name: event.target.value })}
              aria-label={t('calendar.breakName')}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => removeBreak(rule.id)}
              aria-label={t('calendar.delete', { name: rule.name })}
            >
              ×
            </button>
          </div>

          <div className="break-card__row">
            <select
              className="select"
              value={rule.kind}
              onChange={(event) =>
                patchBreak(rule.id, { kind: event.target.value as BreakRule['kind'] })
              }
              aria-label={t('calendar.breakKind')}
            >
              <option value="CLOCK">{t('calendar.kind.clock')}</option>
              <option value="PERIOD">{t('calendar.kind.period')}</option>
            </select>

            <label className="inline-field">
              <span>
                {rule.kind === 'CLOCK' ? t('calendar.afterPeriod') : t('calendar.atPeriod')}
              </span>
              <input
                className="input cell-input--num"
                type="number"
                min={1}
                max={calendar.periodsPerDay}
                value={rule.period}
                onChange={(event) =>
                  patchBreak(rule.id, {
                    period: clamp(Number(event.target.value), 1, calendar.periodsPerDay),
                  })
                }
              />
            </label>

            {rule.kind === 'CLOCK' && (
              <label className="inline-field">
                <span>{t('calendar.minutes')}</span>
                <input
                  className="input cell-input--num"
                  type="number"
                  min={0}
                  max={240}
                  step={5}
                  value={rule.minutes}
                  onChange={(event) =>
                    patchBreak(rule.id, { minutes: clamp(Number(event.target.value), 0, 240) })
                  }
                />
              </label>
            )}
          </div>

          {rule.kind === 'PERIOD' && (
            <div className="break-card__cohorts">
              <button
                type="button"
                className={`chip chip--toggle${rule.studentGroups.length === 0 ? ' chip--on' : ''}`}
                onClick={() => patchBreak(rule.id, { studentGroups: [] })}
              >
                {t('calendar.allClasses')}
              </button>
              {cohorts.map((group) => (
                <button
                  type="button"
                  key={group}
                  className={`chip chip--toggle${
                    rule.studentGroups.includes(group) ? ' chip--on' : ''
                  }`}
                  onClick={() => toggleCohort(rule, group)}
                >
                  {group}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
