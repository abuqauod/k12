import { useMemo, useState } from 'react'
import type { DayOfWeek, Solution, Violation } from '../domain/types'
import { CONSTRAINT_META } from '../domain/types'
import type { SolverProgress } from '../lib/useSolver'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

interface Props {
  solution: Solution | null
  progress: SolverProgress | null
  solving: boolean
  error: string | null
  highlighted: Set<string>
  onHighlight: (lessonIds: string[]) => void
  /** Omit to render without a hide control. */
  onHide?: () => void
}

type Filter = 'ALL' | 'HARD' | 'SOFT'

export function InspectorPanel({
  solution,
  progress,
  solving,
  error,
  highlighted,
  onHighlight,
  onHide,
}: Props) {
  const { t, n, day } = useI18n()

  /** Localises the day token a violation carries, then fills the template. */
  const describe = (violation: Violation) => {
    const params = { ...violation.messageParams }
    if (typeof params.dayToken === 'string') {
      params.day = day(params.dayToken as DayOfWeek)
    }
    return t(violation.messageKey as TranslationKey, params)
  }

  const [filter, setFilter] = useState<Filter>('ALL')

  const summary = useMemo(() => {
    const map = new Map<string, { count: number; penalty: number }>()
    for (const violation of solution?.violations ?? []) {
      const current = map.get(violation.constraint) ?? { count: 0, penalty: 0 }
      current.count += 1
      current.penalty += violation.penalty
      map.set(violation.constraint, current)
    }
    return map
  }, [solution])

  const visible: Violation[] = (solution?.violations ?? []).filter((violation) =>
    filter === 'ALL' ? true : violation.level === filter,
  )

  return (
    <>
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('inspector.solver')}</h3>
          <span className="panel__head-end">
            {solving && <span className="chip">{t('inspector.running')}</span>}
            {onHide && (
              <button
                type="button"
                className="icon-btn icon-btn--quiet"
                onClick={onHide}
                title={t('inspector.hide')}
                aria-label={t('inspector.hide')}
              >
                ✕
              </button>
            )}
          </span>
        </div>

        {error && (
          <div className="empty-state" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
            {error}
          </div>
        )}

        <div className="stat-row">
          <span>{t('inspector.status')}</span>
          <b>{t(`status.${solving ? 'SOLVING' : (solution?.status ?? 'IDLE')}` as TranslationKey)}</b>
        </div>
        <div className="stat-row">
          <span>{t('inspector.hard')}</span>
          <b style={{ color: (solution?.score.hard ?? 0) === 0 ? 'var(--ok)' : 'var(--bad)' }}>
            {n(solving ? (progress?.best.hard ?? 0) : (solution?.score.hard ?? 0))}
          </b>
        </div>
        <div className="stat-row">
          <span>{t('inspector.soft')}</span>
          <b>{n(solving ? (progress?.best.soft ?? 0) : (solution?.score.soft ?? 0))}</b>
        </div>
        <div className="stat-row">
          <span>{t('inspector.moves')}</span>
          <b>{n(solving ? (progress?.iterations ?? 0) : (solution?.stats.iterations ?? 0))}</b>
        </div>
        <div className="stat-row">
          <span>{t('inspector.time')}</span>
          <b>{((solving ? (progress?.elapsedMs ?? 0) : (solution?.stats.elapsedMs ?? 0)) / 1000).toFixed(1)}s</b>
        </div>
        <div className="stat-row">
          <span>{t('inspector.reheats')}</span>
          <b>{n(solving ? (progress?.restarts ?? 0) : (solution?.stats.restarts ?? 0))}</b>
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('inspector.matrix')}</h3>
        </div>
        {(Object.keys(CONSTRAINT_META) as Array<keyof typeof CONSTRAINT_META>).map((id) => {
          const meta = CONSTRAINT_META[id]
          const entry = summary.get(id)
          const broken = entry !== undefined && entry.penalty > 0
          return (
            <div className="stat-row" key={id} title={meta.description}>
              <span>
                <span
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: 2,
                    marginInlineEnd: 7,
                    background: broken
                      ? meta.level === 'HARD'
                        ? 'var(--bad)'
                        : 'var(--warn)'
                      : 'var(--ok)',
                  }}
                />
                {t(`constraint.${id}` as TranslationKey)}
              </span>
              <b style={{ color: broken ? 'var(--ink)' : 'var(--muted)' }}>
                {entry ? `−${n(entry.penalty)}` : n(0)}
              </b>
            </div>
          )
        })}
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{t('inspector.violations')}</h3>
          <div className="segmented">
            {(['ALL', 'HARD', 'SOFT'] as Filter[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                onClick={() => setFilter(option)}
              >
                {t(`inspector.filter.${option.toLowerCase()}` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>

        {highlighted.size > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginBlockEnd: 8 }}
            onClick={() => onHighlight([])}
          >
            {t('inspector.clearHighlight', { count: n(highlighted.size) })}
          </button>
        )}

        {visible.length === 0 ? (
          <div className="empty-state">
            {solution
              ? t('inspector.clean')
              : t('inspector.notRun')}
          </div>
        ) : (
          visible.slice(0, 120).map((violation, index) => (
            <button
              type="button"
              className="violation"
              data-level={violation.level}
              key={`${violation.constraint}-${index}`}
              onClick={() => onHighlight(violation.lessonIds)}
            >
              <span className="violation__head">
                <span>{t(`constraint.${violation.constraint}` as TranslationKey)}</span>
                <span className="violation__penalty">−{n(violation.penalty)}</span>
              </span>
              <span className="violation__body">{describe(violation)}</span>
            </button>
          ))
        )}

        {visible.length > 120 && (
          <p className="panel__hint">{t('inspector.truncated', { count: n(visible.length) })}</p>
        )}
      </div>
    </>
  )
}
