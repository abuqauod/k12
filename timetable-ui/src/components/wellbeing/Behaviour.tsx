import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  addIncidentAction,
  notifyIncident,
  reportIncident,
  setIncidentStatus,
  type Incident,
  type IncidentSeverity,
} from '../../lib/wellbeingApi'
import { useLookup } from '../../lib/useLookup'
import { PersonPicker, type PickedPerson } from '../ops/PersonPicker'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { wellbeingError } from './Health'

/** Behaviour incidents (backlog), shared by the student profile and the
 * Behaviour page. */

const SEVERITY_TONE: Record<IncidentSeverity, string> = { minor: '', moderate: 'chip--warn', major: 'chip--bad' }
const STATUS_TONE = { open: 'chip--on', resolved: 'chip--ok', dismissed: '' }

/** Logs an incident about one or more students. */
export function IncidentForm({ preset, branchId, onSaved }: { preset?: PickedPerson; branchId?: string; onSaved: (i: Incident) => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const types = useLookup('incidentType')
  const [students, setStudents] = useState<PickedPerson[]>(preset ? [preset] : [])
  const [f, setF] = useState({
    typeCode: '',
    severity: 'minor' as IncidentSeverity,
    description: '',
    location: '',
    witnesses: '',
    when: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    const res = await reportIncident(getAccessToken, {
      studentIds: students.map((s) => s.id),
      typeCode: f.typeCode,
      severity: f.severity,
      description: f.description.trim(),
      location: f.location.trim() || null,
      witnesses: f.witnesses.trim() || null,
      ...(f.when ? { occurredAt: new Date(f.when).toISOString() } : {}),
    })
    setBusy(false)
    if (res.kind !== 'ok') return setError(wellbeingError(t, res.error))
    setStudents(preset ? [preset] : [])
    setF({ typeCode: '', severity: 'minor', description: '', location: '', witnesses: '', when: '' })
    onSaved(res.data)
  }

  return (
    <div className="stack-form">
      <div className="docs__chips">
        {students.map((s) => (
          <span key={s.id} className="chip">
            {s.label}
            {!preset && (
              <button
                type="button"
                className="chip__x"
                aria-label={t('wb.remove')}
                onClick={() => setStudents(students.filter((x) => x.id !== s.id))}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {!preset && (
        <PersonPicker branchId={branchId} onPick={(p) => !students.some((s) => s.id === p.id) && setStudents([...students, p])} />
      )}
      <div className="inline-form">
        <select
          className="select input--sm"
          aria-label={t('wb.inc.type')}
          value={f.typeCode}
          onChange={(e) => setF({ ...f, typeCode: e.target.value })}
        >
          <option value="">{t('wb.inc.type')}…</option>
          {types.active.map((x) => (
            <option key={x.code} value={x.code}>
              {types.label(x.code)}
            </option>
          ))}
        </select>
        <select
          className="select input--sm"
          aria-label={t('wb.severity')}
          value={f.severity}
          onChange={(e) => setF({ ...f, severity: e.target.value as IncidentSeverity })}
        >
          {(['minor', 'moderate', 'major'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`wb.incSev.${s}` as TranslationKey)}
            </option>
          ))}
        </select>
        <input
          className="input input--sm"
          placeholder={t('wb.inc.location')}
          aria-label={t('wb.inc.location')}
          value={f.location}
          onChange={(e) => setF({ ...f, location: e.target.value })}
        />
        <input
          type="datetime-local"
          className="input input--sm"
          aria-label={t('wb.inc.when')}
          value={f.when}
          onChange={(e) => setF({ ...f, when: e.target.value })}
        />
      </div>
      <textarea
        className="input"
        rows={3}
        placeholder={t('wb.inc.description')}
        aria-label={t('wb.inc.description')}
        value={f.description}
        onChange={(e) => setF({ ...f, description: e.target.value })}
      />
      <input
        className="input input--sm"
        placeholder={t('wb.inc.witnesses')}
        aria-label={t('wb.inc.witnesses')}
        value={f.witnesses}
        onChange={(e) => setF({ ...f, witnesses: e.target.value })}
      />
      {error && <p className="login__error">{error}</p>}
      <div className="inline-form">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || students.length === 0 || !f.typeCode || f.description.trim().length < 3}
          onClick={() => void save()}
        >
          {t('wb.inc.report')}
        </button>
      </div>
    </div>
  )
}

/** One incident: what happened, and for managers what the school does. */
export function IncidentCard({
  incident,
  canManage,
  onChanged,
}: {
  incident: Incident
  canManage: boolean
  onChanged: (i: Incident) => void
}) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const types = useLookup('incidentType')
  const actions = useLookup('disciplineAction')
  const [open, setOpen] = useState(false)
  const [a, setA] = useState({ studentId: incident.students[0]?.id ?? '', code: '', note: '', startDate: '', endDate: '' })
  const [resolution, setResolution] = useState('')
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null)
  const done = (res: { kind: string; error?: string; data?: unknown }, ok?: string) => {
    if (res.kind !== 'ok') return setNote({ text: wellbeingError(t, res.error ?? 'generic'), warn: true })
    if (ok) setNote({ text: ok, warn: false })
    if (res.data && typeof res.data === 'object' && 'id' in res.data) onChanged(res.data as Incident)
  }

  return (
    <li className="record-list__item">
      <button type="button" className="record-list__row incident__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="record-list__main">
          <span className="mono card__hint">{incident.incidentNumber}</span> <b>{types.label(incident.typeCode)}</b>{' '}
          <span className="card__hint">— {incident.students.map((s) => s.name).join(', ')}</span>
        </span>
        <span className="docs__chips">
          <span className={`chip ${SEVERITY_TONE[incident.severity]}`}>{t(`wb.incSev.${incident.severity}` as TranslationKey)}</span>
          <span className={`chip ${STATUS_TONE[incident.status]}`}>{t(`wb.incStatus.${incident.status}` as TranslationKey)}</span>
          <span className="mono card__hint">{new Date(incident.occurredAt).toLocaleDateString(lang)}</span>
        </span>
      </button>
      {open && (
        <div className="incident__body">
          <p className="bidi">{incident.description}</p>
          <p className="card__hint">
            {[incident.location, incident.witnesses && `${t('wb.inc.witnesses')}: ${incident.witnesses}`].filter(Boolean).join(' · ')}
          </p>
          <ul className="incident__students">
            {incident.students.map((s) => (
              <li key={s.id}>
                <Link to={`/students/${s.id}?tab=behaviour`}>{s.name}</Link> <small className="card__hint mono">{s.studentGroup}</small>
                {incident.actions
                  .filter((x) => x.studentId === s.id)
                  .map((x) => (
                    <span key={x.id} className="chip chip--on" title={x.note ?? ''}>
                      {actions.label(x.code)}
                      {x.startDate ? ` · ${x.startDate}${x.endDate && x.endDate !== x.startDate ? ` – ${x.endDate}` : ''}` : ''}
                    </span>
                  ))}
              </li>
            ))}
          </ul>
          {incident.resolution && (
            <p>
              <b>{t('wb.inc.resolution')}:</b> {incident.resolution}
            </p>
          )}
          {incident.parentsNotifiedAt && (
            <p className="card__hint">{t('wb.inc.told', { date: new Date(incident.parentsNotifiedAt).toLocaleString(lang) })}</p>
          )}
          {canManage && incident.status === 'open' && (
            <div className="inline-form">
              <select
                className="select input--sm"
                aria-label={t('wb.visit.student')}
                value={a.studentId}
                onChange={(e) => setA({ ...a, studentId: e.target.value })}
              >
                {incident.students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                className="select input--sm"
                aria-label={t('wb.inc.action')}
                value={a.code}
                onChange={(e) => setA({ ...a, code: e.target.value })}
              >
                <option value="">{t('wb.inc.action')}…</option>
                {actions.active.map((x) => (
                  <option key={x.code} value={x.code}>
                    {actions.label(x.code)}
                  </option>
                ))}
              </select>
              <input
                type="date"
                className="input input--sm"
                aria-label={t('wb.inc.from')}
                value={a.startDate}
                onChange={(e) => setA({ ...a, startDate: e.target.value })}
              />
              <input
                type="date"
                className="input input--sm"
                aria-label={t('wb.inc.to')}
                value={a.endDate}
                onChange={(e) => setA({ ...a, endDate: e.target.value })}
              />
              <input
                className="input input--sm"
                placeholder={t('wb.notes')}
                aria-label={t('wb.notes')}
                value={a.note}
                onChange={(e) => setA({ ...a, note: e.target.value })}
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={!a.code}
                onClick={() =>
                  void addIncidentAction(getAccessToken, incident.id, {
                    studentId: a.studentId,
                    code: a.code,
                    note: a.note.trim() || null,
                    startDate: a.startDate || null,
                    endDate: a.endDate || a.startDate || null,
                  }).then((r) => {
                    done(r)
                    if (r.kind === 'ok') setA({ ...a, code: '', note: '', startDate: '', endDate: '' })
                  })
                }
              >
                {t('wb.inc.addAction')}
              </button>
            </div>
          )}
          {canManage && (
            <div className="inline-form">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  void notifyIncident(getAccessToken, incident.id).then((r) =>
                    r.kind === 'ok'
                      ? setNote({
                          text:
                            r.data.inApp + r.data.email + r.data.sms > 0
                              ? t('wb.inc.sent', { n: String(r.data.families) })
                              : t('wb.inc.nothingNew'),
                          warn: r.data.inApp + r.data.email + r.data.sms === 0,
                        })
                      : done(r),
                  )
                }
              >
                {t('wb.inc.tellFamilies')}
              </button>
              {incident.status === 'open' ? (
                <>
                  <input
                    className="input input--sm"
                    style={{ flex: 1, minWidth: 160 }}
                    placeholder={t('wb.inc.resolution')}
                    aria-label={t('wb.inc.resolution')}
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={!resolution.trim()}
                    onClick={() => void setIncidentStatus(getAccessToken, incident.id, 'resolved', resolution.trim()).then((r) => done(r))}
                  >
                    {t('wb.inc.resolve')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={!resolution.trim()}
                    onClick={() => void setIncidentStatus(getAccessToken, incident.id, 'dismissed', resolution.trim()).then((r) => done(r))}
                  >
                    {t('wb.inc.dismiss')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void setIncidentStatus(getAccessToken, incident.id, 'open', null).then((r) => done(r))}
                >
                  {t('wb.inc.reopen')}
                </button>
              )}
            </div>
          )}
          {note && <p className={`notice${note.warn ? ' notice--warn' : ''}`}>{note.text}</p>}
        </div>
      )}
    </li>
  )
}

export function IncidentList({
  incidents,
  canManage,
  onChanged,
}: {
  incidents: Incident[]
  canManage: boolean
  onChanged: (i: Incident) => void
}) {
  const { t } = useI18n()
  if (incidents.length === 0) return <div className="empty-state">{t('wb.inc.none')}</div>
  return (
    <ul className="record-list">
      {incidents.map((i) => (
        <IncidentCard key={i.id} incident={i} canManage={canManage} onChanged={onChanged} />
      ))}
    </ul>
  )
}
