import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'

/**
 * Transport rules that shape every route: the hard limits the solver must
 * respect, and the travel model it costs distance with.
 *
 * Shared between Settings and the routing page so the two cannot drift apart —
 * both write the same `fleet.settings`.
 */
export function RoutingRulesEditor({ showBellCheck = true }: { showBellCheck?: boolean }) {
  const { t } = useI18n()
  const { fleet, setFleet, problem } = useApp()

  const patch = (changes: Partial<typeof fleet.settings>) =>
    setFleet({ ...fleet, settings: { ...fleet.settings, ...changes } })

  const timetableBell = problem.calendar.dayStart.slice(0, 5)
  const bellMismatch = fleet.settings.bellTime.slice(0, 5) !== timetableBell

  return (
    <>
      <div className="field-grid">
        <label className="field">
          <span>{t('fleet.maxRide')}</span>
          <input
            className="input"
            type="number"
            min={10}
            max={120}
            value={fleet.settings.maxRideMinutes}
            onChange={(event) => patch({ maxRideMinutes: Number(event.target.value) || 45 })}
          />
        </label>
        <label className="field">
          <span>{t('fleet.bell')}</span>
          <input
            className="input"
            type="time"
            value={fleet.settings.bellTime.slice(0, 5)}
            onChange={(event) => patch({ bellTime: `${event.target.value || '08:30'}:00` })}
          />
        </label>
        <label className="field">
          <span>{t('fleet.earliest')}</span>
          <input
            className="input"
            type="time"
            value={fleet.settings.earliestDeparture.slice(0, 5)}
            onChange={(event) => patch({ earliestDeparture: `${event.target.value || '06:30'}:00` })}
          />
        </label>
        <label className="field">
          <span>{t('fleet.buffer')}</span>
          <input
            className="input"
            type="number"
            min={0}
            max={60}
            value={fleet.settings.arrivalBufferMinutes}
            onChange={(event) => patch({ arrivalBufferMinutes: Number(event.target.value) || 0 })}
          />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>{t('fleet.osrmUrl')}</span>
          <input
            className="input"
            type="url"
            placeholder="http://localhost:5001"
            value={fleet.settings.osrmUrl}
            onChange={(event) => patch({ osrmUrl: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('fleet.speed')}</span>
          <input
            className="input"
            type="number"
            min={5}
            max={90}
            value={fleet.settings.averageSpeedKph}
            onChange={(event) => patch({ averageSpeedKph: Number(event.target.value) || 32 })}
          />
        </label>
        <label className="field">
          <span>{t('fleet.roadFactor')}</span>
          <input
            className="input"
            type="number"
            step={0.05}
            min={1}
            max={2}
            value={fleet.settings.roadFactor}
            onChange={(event) => patch({ roadFactor: Number(event.target.value) || 1.35 })}
          />
        </label>
      </div>

      {showBellCheck && bellMismatch && (
        <p className="card__hint" style={{ margin: '10px 0 0' }}>
          {t('fleet.bellMismatch', { timetable: timetableBell })}
        </p>
      )}
      <p className="card__hint" style={{ margin: '10px 0 0' }}>
        {t('fleet.osrmNote')}
      </p>
    </>
  )
}
