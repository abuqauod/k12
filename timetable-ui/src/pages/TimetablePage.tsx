import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DayOfWeek } from '../domain/types'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { download, toApiResponse } from '../lib/api'
import { downloadCsv, timetableToCsv } from '../lib/exports'
import { SyncButton } from '../components/SyncButton'
import { Splitter } from '../components/Splitter'
import { useMediaQuery } from '../lib/useMediaQuery'
import type { Dimension } from '../lib/view'
import { violationLessonIds } from '../lib/view'
import { DataPanel } from '../components/DataPanel'
import { InspectorPanel } from '../components/InspectorPanel'
import { JsonDialog } from '../components/JsonDialog'
import { TimetableBoard } from '../components/TimetableBoard'
import type { Layout } from '../components/TimetableBoard'

const BUDGETS = [2000, 5000, 15000, 30000]

const INSPECTOR_KEY = 'timetable.inspector'
const WIDTHS_KEY = 'timetable.layout'

/** Below these the panels stop being usable, so drags clamp here. */
const DEFAULT_LEFT = 322
const DEFAULT_RIGHT = 312
const MIN_LEFT = 260
const MAX_LEFT = 560
const MIN_RIGHT = 250
const MAX_RIGHT = 520
/** The timetable itself never shrinks past this, whatever the side panels do. */
const MIN_BOARD = 420
const SPLITTER = 8

interface PanelWidths {
  left: number
  right: number
}

function readWidths(): PanelWidths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (!raw) return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
    const parsed = JSON.parse(raw) as Partial<PanelWidths>
    return {
      left: Number.isFinite(parsed.left) ? Number(parsed.left) : DEFAULT_LEFT,
      right: Number.isFinite(parsed.right) ? Number(parsed.right) : DEFAULT_RIGHT,
    }
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
  }
}

function readInspectorOpen(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== 'hidden'
  } catch {
    return true
  }
}

export function TimetablePage() {
  const { t, n } = useI18n()
  const {
    problem,
    setProblem,
    solution,
    progress,
    solving,
    error,
    shownScore,
    dirty,
    budget,
    setBudget,
    solve,
    reseed,
    stop,
  } = useApp()

  const [dimension, setDimension] = useState<Dimension>('studentGroup')
  const [focus, setFocus] = useState('')
  const [layout, setLayout] = useState<Layout>('week')
  const [day, setDay] = useState<DayOfWeek | null>(null)
  const [highlight, setHighlight] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<'api' | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(readInspectorOpen)

  // Splitters appear as soon as there are two columns to divide; the solver
  // column itself only exists above the wider breakpoint.
  const roomy = useMediaQuery('(min-width: 861px)')
  const inspectorFits = useMediaQuery('(min-width: 1181px)')
  const inspectorVisible = inspectorOpen && inspectorFits
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<PanelWidths>(readWidths)

  useEffect(() => {
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
    } catch {
      // Preference simply will not persist.
    }
  }, [widths])

  // Observed rather than read from the ref during render, so the clamp also
  // reacts to the sidebar collapsing — not just to window resizes.
  const [workspaceWidth, setWorkspaceWidth] = useState(0)

  useLayoutEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    setWorkspaceWidth(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      setWorkspaceWidth(entries[0].contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [roomy])

  /**
   * The hard limit is the board, not the panel: a panel may only grow while
   * the timetable still has MIN_BOARD left, so it can never be squeezed out of
   * readability.
   */
  const maxFor = useCallback(
    (side: 'left' | 'right') => {
      const ceiling = side === 'left' ? MAX_LEFT : MAX_RIGHT
      if (!workspaceWidth) return ceiling
      const other = side === 'left' ? (inspectorVisible ? widths.right : 0) : widths.left
      const splitters = SPLITTER * (inspectorVisible ? 2 : 1)
      return Math.max(
        side === 'left' ? MIN_LEFT : MIN_RIGHT,
        Math.min(ceiling, workspaceWidth - other - splitters - MIN_BOARD),
      )
    },
    [workspaceWidth, inspectorVisible, widths.left, widths.right],
  )

  const toggleInspector = () =>
    setInspectorOpen((current) => {
      const next = !current
      try {
        localStorage.setItem(INSPECTOR_KEY, next ? 'shown' : 'hidden')
      } catch {
        // Preference simply will not persist.
      }
      return next
    })

  /**
   * What actually gets laid out. Clamping here rather than into state means a
   * layout saved on a wide screen is only *displayed* smaller on a narrow one —
   * the stored preference survives and comes back when the space does.
   */
  const effective = {
    left: Math.min(widths.left, maxFor('left')),
    right: Math.min(widths.right, maxFor('right')),
  }

  const flagged = useMemo(() => violationLessonIds(solution?.violations ?? []), [solution])

  const apiJson = useMemo(
    () => (solution ? JSON.stringify(toApiResponse(problem, solution), null, 2) : '{}'),
    [problem, solution],
  )

  const scoreClass = solving
    ? 'score score--solving'
    : solution?.status === 'SUCCESS'
      ? 'score score--ok'
      : solution
        ? 'score score--bad'
        : 'score'

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span>
            <h1 className="brand__title">{t('nav.timetable')}</h1>
            <p className="brand__subtitle">{t('app.module.timetable')}</p>
          </span>
        </div>

        <div className="header__spacer" />

        <div className="header__controls">
          <span className={scoreClass}>
            <span className="score__dot" />
            {shownScore
              ? t('header.score', { hard: n(shownScore.hard), soft: n(shownScore.soft) })
              : t('header.notSolved')}
          </span>

          {dirty && !solving && <span className="chip">{t('header.dirty')}</span>}

          <select
            className="select"
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
            aria-label={t('header.budget', { seconds: n(budget / 1000) })}
          >
            {BUDGETS.map((value) => (
              <option key={value} value={value}>
                {t('header.budget', { seconds: n(value / 1000) })}
              </option>
            ))}
          </select>

          {solving ? (
            <button type="button" className="btn" onClick={stop}>
              {t('header.stop')}
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => solve()}>
              {t('header.solve')}
            </button>
          )}

          <button
            type="button"
            className="btn"
            disabled={solving}
            title={t('header.reseedTitle')}
            onClick={reseed}
          >
            {t('header.reseed')}
          </button>

          <button type="button" className="btn" disabled={!solution} onClick={() => setDialog('api')}>
            {t('header.apiJson')}
          </button>

          <button
            type="button"
            className="btn"
            disabled={!solution}
            onClick={() =>
              downloadCsv('timetable.csv', timetableToCsv(problem, solution))
            }
          >
            {t('header.csv')}
          </button>

          <button type="button" className="btn" onClick={() => window.print()}>
            {t('header.print')}
          </button>

          <button
            type="button"
            className="btn"
            onClick={toggleInspector}
            aria-pressed={inspectorOpen}
            title={inspectorOpen ? t('inspector.hide') : t('inspector.show')}
          >
            {t('header.solverPanel')}
          </button>

          <SyncButton />

        </div>
      </header>

      <div
        ref={workspaceRef}
        className={`workspace${inspectorOpen ? '' : ' workspace--no-inspector'}`}
        style={
          roomy
            ? {
                gridTemplateColumns: inspectorVisible
                  ? `${effective.left}px ${SPLITTER}px minmax(${MIN_BOARD}px, 1fr) ${SPLITTER}px ${effective.right}px`
                  : `${effective.left}px ${SPLITTER}px minmax(${MIN_BOARD}px, 1fr)`,
              }
            : undefined
        }
      >
        <aside className="column column--left">
          <DataPanel problem={problem} onChange={setProblem} solution={solution} />
        </aside>

        {roomy && (
          <Splitter
            value={effective.left}
            min={MIN_LEFT}
            max={maxFor('left')}
            defaultValue={DEFAULT_LEFT}
            onChange={(next) => setWidths((current) => ({ ...current, left: next }))}
            label={t('layout.resizeEditor')}
          />
        )}

        <main className="column column--center">
          <TimetableBoard
            problem={problem}
            solution={solution}
            solving={solving}
            dimension={dimension}
            onDimensionChange={(next) => {
              setDimension(next)
              setFocus('')
            }}
            focus={focus}
            onFocusChange={setFocus}
            layout={layout}
            onLayoutChange={setLayout}
            day={day}
            onDayChange={setDay}
            flaggedLessons={flagged}
            highlighted={highlight}
            onSelectLesson={(lessonId) =>
              setHighlight((current) => (current.has(lessonId) ? new Set() : new Set([lessonId])))
            }
          />
        </main>

        {inspectorVisible && (
          <Splitter
            value={effective.right}
            min={MIN_RIGHT}
            max={maxFor('right')}
            defaultValue={DEFAULT_RIGHT}
            invert
            onChange={(next) => setWidths((current) => ({ ...current, right: next }))}
            label={t('layout.resizeSolver')}
          />
        )}

        {inspectorOpen && (
          <aside className="column column--right">
            <InspectorPanel
              solution={solution}
              progress={progress}
              solving={solving}
              error={error}
              highlighted={highlight}
              onHighlight={(ids) => setHighlight(new Set(ids))}
              onHide={toggleInspector}
            />
          </aside>
        )}
      </div>

      {dialog === 'api' && solution && (
        <JsonDialog
          title={t('dialog.apiTitle')}
          subtitle={t('dialog.apiSubtitle', {
            status: solution.status,
            rows: n(solution.assignments.length),
          })}
          json={apiJson}
          filename="timetable-response.json"
          onClose={() => setDialog(null)}
          onDownload={download}
        />
      )}

    </div>
  )
}
