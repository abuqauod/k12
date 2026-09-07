import { useMemo } from 'react'
import type { BreakRule, DayOfWeek, Problem, Solution } from '../domain/types'
import { breakAt, clockGaps, wholeSchoolBreakAt } from '../domain/calendar'
import type { Dimension, GridAxes, PlacedLesson } from '../lib/view'
import { buildAxes, dimensionOptions, dimensionValue, placeLessons } from '../lib/view'
import { LessonCard } from './LessonCard'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

export type Layout = 'week' | 'day'

interface Props {
  problem: Problem
  solution: Solution | null
  solving: boolean
  dimension: Dimension
  onDimensionChange: (dimension: Dimension) => void
  focus: string
  onFocusChange: (value: string) => void
  layout: Layout
  onLayoutChange: (layout: Layout) => void
  day: DayOfWeek | null
  onDayChange: (day: DayOfWeek) => void
  flaggedLessons: Set<string>
  highlighted: Set<string>
  onSelectLesson: (lessonId: string) => void
}

const DIMENSION_KEYS: Record<Dimension, TranslationKey> = {
  studentGroup: 'board.cohort',
  teacher: 'board.teacher',
  room: 'board.room',
}

type Period = GridAxes['periods'][number]

/** The day read top to bottom: teaching periods with clock gaps between them. */
type DaySlot =
  | { kind: 'period'; key: string; period: Period }
  | { kind: 'gap'; key: string; rules: BreakRule[] }

export function TimetableBoard(props: Props) {
  const {
    problem,
    solution,
    solving,
    dimension,
    onDimensionChange,
    focus,
    onFocusChange,
    layout,
    onLayoutChange,
    day,
    onDayChange,
    flaggedLessons,
    highlighted,
    onSelectLesson,
  } = props

  const { t, n, dayShort } = useI18n()

  const axes = useMemo(
    () => buildAxes(problem.timeslots, problem.calendar.weekStart),
    [problem.timeslots, problem.calendar.weekStart],
  )
  const placed = useMemo(() => placeLessons(problem, solution), [problem, solution])
  const options = useMemo(() => dimensionOptions(problem, dimension), [problem, dimension])

  const activeFocus = options.includes(focus) ? focus : (options[0] ?? '')
  const activeDay = day && axes.days.includes(day) ? day : (axes.days[0] ?? null)

  const sequence = useMemo<DaySlot[]>(() => {
    const gaps = clockGaps(problem.calendar)
    const out: DaySlot[] = []
    for (const period of axes.periods) {
      out.push({ kind: 'period', key: `p${period.index}`, period })
      const rules = gaps.get(period.index + 1)
      if (rules && rules.length > 0) {
        out.push({ kind: 'gap', key: `g${period.index}`, rules })
      }
    }
    return out
  }, [axes.periods, problem.calendar])

  const cells = useMemo(() => {
    const map = new Map<string, PlacedLesson[]>()
    for (const item of placed) {
      if (!item.timeslot || item.period < 0) continue
      const key =
        layout === 'week'
          ? `${item.dayOfWeek}|${item.period}`
          : `${dimensionValue(item, dimension)}|${item.period}`
      const inScope =
        layout === 'week'
          ? dimensionValue(item, dimension) === activeFocus
          : item.dayOfWeek === activeDay
      if (!inScope) continue
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    return map
  }, [placed, layout, dimension, activeFocus, activeDay])

  const scheduledCount = useMemo(
    () =>
      placed.filter(
        (item) => item.timeslot !== null && dimensionValue(item, dimension) === activeFocus,
      ).length,
    [placed, dimension, activeFocus],
  )

  /**
   * A reserved break for the row being drawn. In cohort view that is the
   * focused cohort's own break; otherwise only a whole-school break applies.
   */
  const breakForCohort = (group: string, periodIndex: number) =>
    breakAt(problem.calendar, group, periodIndex)

  const breakForRow = (periodIndex: number) =>
    dimension === 'studentGroup' && layout === 'week'
      ? breakForCohort(activeFocus, periodIndex)
      : wholeSchoolBreakAt(problem.calendar, periodIndex)

  const rowCount = layout === 'week' ? axes.periods.length : options.length

  const gridStyle =
    layout === 'week'
      ? { gridTemplateColumns: `84px repeat(${axes.days.length}, minmax(124px, 1fr))` }
      : {
          gridTemplateColumns: `148px ${sequence
            .map((item) => (item.kind === 'period' ? 'minmax(118px, 1fr)' : '26px'))
            .join(' ')}`,
        }

  return (
    <section className="board">
      <div className="board__bar">
        <div>
          <h2 className="board__title">
            {layout === 'week'
              ? activeFocus || t('board.noData')
              : t('board.allOf', {
                  day: activeDay ? dayShort(activeDay) : '—',
                  dimension: t(DIMENSION_KEYS[dimension]),
                })}
          </h2>
          <p className="board__meta">
            {!solution && solving
              ? t('board.searching', { count: n(problem.lessons.length) })
              : layout === 'week'
                ? t('board.placed', {
                    count: n(scheduledCount),
                    days: n(axes.days.length),
                  })
                : t('board.weekTotals', {
                    count: n(problem.lessons.length),
                    periods: n(axes.periods.length),
                  })}
          </p>
        </div>

        <div className="header__spacer" />

        <div className="segmented" role="group" aria-label={t('board.groupBy')}>
          {(Object.keys(DIMENSION_KEYS) as Dimension[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={dimension === key}
              onClick={() => onDimensionChange(key)}
            >
              {t(DIMENSION_KEYS[key])}
            </button>
          ))}
        </div>

        {layout === 'week' ? (
          <select
            className="select"
            value={activeFocus}
            onChange={(event) => onFocusChange(event.target.value)}
            aria-label={t('board.select', { dimension: t(DIMENSION_KEYS[dimension]) })}
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <select
            className="select"
            value={activeDay ?? ''}
            onChange={(event) => onDayChange(event.target.value as DayOfWeek)}
            aria-label={t('board.selectDay')}
          >
            {axes.days.map((option) => (
              <option key={option} value={option}>
                {dayShort(option)}
              </option>
            ))}
          </select>
        )}

        <div className="segmented" role="group" aria-label={t('board.layout')}>
          <button
            type="button"
            aria-pressed={layout === 'week'}
            onClick={() => onLayoutChange('week')}
          >
            {t('board.week')}
          </button>
          <button type="button" aria-pressed={layout === 'day'} onClick={() => onLayoutChange('day')}>
            {t('board.dayMatrix')}
          </button>
        </div>
      </div>

      {problem.timeslots.length === 0 || rowCount === 0 ? (
        <div className="empty-state">{t('board.empty')}</div>
      ) : (
        <div className="grid" style={gridStyle}>
          {/* ---- header row ---- */}
          <div className="grid__cell grid__head" />
          {layout === 'week'
            ? axes.days.map((column) => (
                <div key={column} className="grid__cell grid__head">
                  {dayShort(column)}
                </div>
              ))
            : sequence.map((item) =>
                item.kind === 'period' ? (
                  <div key={item.key} className="grid__cell grid__head">
                    {t('period.short', { n: n(item.period.index + 1) })} · {item.period.start}
                  </div>
                ) : (
                  <div
                    key={item.key}
                    className="grid__cell grid__head grid__gapcol"
                    title={item.rules.map((rule) => rule.name).join(', ')}
                  >
                    <span>{item.rules.reduce((sum, rule) => sum + rule.minutes, 0)}′</span>
                  </div>
                ),
              )}

          {/* ---- body ---- */}
          {layout === 'week'
            ? sequence.map((item) => {
                if (item.kind === 'gap') {
                  return (
                    <div className="grid__band" key={item.key}>
                      {item.rules
                        .map((rule) =>
                          t('board.breakMinutes', { name: rule.name, minutes: n(rule.minutes) }),
                        )
                        .join('  ·  ')}
                    </div>
                  )
                }
                const reserved = breakForRow(item.period.index)
                return (
                  <PeriodRow
                    key={item.key}
                    period={item.period}
                    label={t('period.short', { n: n(item.period.index + 1) })}
                    reserved={reserved}
                    columns={
                      reserved
                        ? []
                        : axes.days.map((columnDay) => ({
                            key: `${columnDay}|${item.period.index}`,
                            lessons: cells.get(`${columnDay}|${item.period.index}`) ?? [],
                          }))
                    }
                    dimension={dimension}
                    flaggedLessons={flaggedLessons}
                    highlighted={highlighted}
                    onSelectLesson={onSelectLesson}
                  />
                )
              })
            : options.map((entity) => (
                <EntityRow
                  key={entity}
                  entity={entity}
                  sequence={sequence}
                  cells={cells}
                  reservedAt={(periodIndex) =>
                    dimension === 'studentGroup'
                      ? breakForCohort(entity, periodIndex)
                      : wholeSchoolBreakAt(problem.calendar, periodIndex)
                  }
                  dimension={dimension}
                  flaggedLessons={flaggedLessons}
                  highlighted={highlighted}
                  onSelectLesson={onSelectLesson}
                />
              ))}
        </div>
      )}
    </section>
  )
}

interface PeriodRowProps {
  period: Period
  label: string
  reserved: BreakRule | undefined
  columns: Array<{ key: string; lessons: PlacedLesson[] }>
  dimension: Dimension
  flaggedLessons: Set<string>
  highlighted: Set<string>
  onSelectLesson: (lessonId: string) => void
}

function PeriodRow({
  period,
  label,
  reserved,
  columns,
  dimension,
  flaggedLessons,
  highlighted,
  onSelectLesson,
}: PeriodRowProps) {
  return (
    <>
      <div className="grid__cell grid__time">
        <b>{label}</b>
        <span>
          {period.start}–{period.end}
        </span>
      </div>
      {reserved ? (
        <div className="grid__cell grid__rest grid__rest--row">{reserved.name}</div>
      ) : (
        columns.map((column) => (
          <div
            key={column.key}
            className={`grid__cell${column.lessons.length === 0 ? ' grid__cell--empty' : ''}`}
          >
            {column.lessons.map((item) => (
              <LessonCard
                key={item.lesson.id}
                placed={item}
                dimension={dimension}
                flagged={flaggedLessons.has(item.lesson.id)}
                dimmed={highlighted.size > 0 && !highlighted.has(item.lesson.id)}
                onSelect={onSelectLesson}
              />
            ))}
          </div>
        ))
      )}
    </>
  )
}

interface EntityRowProps {
  entity: string
  sequence: DaySlot[]
  cells: Map<string, PlacedLesson[]>
  reservedAt: (periodIndex: number) => BreakRule | undefined
  dimension: Dimension
  flaggedLessons: Set<string>
  highlighted: Set<string>
  onSelectLesson: (lessonId: string) => void
}

function EntityRow({
  entity,
  sequence,
  cells,
  reservedAt,
  dimension,
  flaggedLessons,
  highlighted,
  onSelectLesson,
}: EntityRowProps) {
  return (
    <>
      <div className="grid__cell grid__time">
        <b>{entity}</b>
      </div>
      {sequence.map((item) => {
        if (item.kind === 'gap') {
          return <div key={item.key} className="grid__cell grid__gapcol" />
        }
        const reserved = reservedAt(item.period.index)
        if (reserved) {
          return (
            <div key={item.key} className="grid__cell grid__rest">
              {reserved.name}
            </div>
          )
        }
        const lessons = cells.get(`${entity}|${item.period.index}`) ?? []
        return (
          <div
            key={item.key}
            className={`grid__cell${lessons.length === 0 ? ' grid__cell--empty' : ''}`}
          >
            {lessons.map((placed) => (
              <LessonCard
                key={placed.lesson.id}
                placed={placed}
                dimension={dimension}
                flagged={flaggedLessons.has(placed.lesson.id)}
                dimmed={highlighted.size > 0 && !highlighted.has(placed.lesson.id)}
                onSelect={onSelectLesson}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}
