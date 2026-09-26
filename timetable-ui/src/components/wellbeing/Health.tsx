import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getAlerts,
  getHealth,
  OUTCOMES,
  recordVisit,
  saveHealth,
  type Allergy,
  type ClinicVisit,
  type HealthAlert,
  type HealthItem,
  type HealthProfile,
  type Medication,
  type Outcome,
} from '../../lib/wellbeingApi'
import { PersonPicker, type PickedPerson } from '../ops/PersonPicker'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

/** Health and clinic pieces (backlog), shared by the student profile and
 * the Clinic page. */

export function wellbeingError(t: (key: TranslationKey) => string, code: string): string {
  const key = `wb.error.${code}` as TranslationKey
  const text = t(key)
  return text === key ? t('wb.error.generic') : text
}

const OUTCOME_TONE: Record<Outcome, string> = {
  returned_to_class: 'chip--ok',
  rested: '',
  sent_home: 'chip--warn',
  referred: 'chip--warn',
  emergency: 'chip--bad',
}

/** The items marked as alerts, for anyone who can see the student. */
export function HealthAlertsBanner({ studentId }: { studentId: string }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [alerts, setAlerts] = useState<HealthAlert[]>([])
  useEffect(() => {
    void getAlerts(getAccessToken, studentId).then((r) => setAlerts(r.kind === 'ok' ? r.data : []))
  }, [getAccessToken, studentId])
  if (alerts.length === 0) return null
  return (
    <section className="health-alert" role="note" aria-label={t('wb.alerts')}>
      <b>{t('wb.alerts')}</b>
      {alerts.map((a, i) => (
        <span key={i} className={`chip ${a.severity === 'severe' ? 'chip--bad' : 'chip--warn'}`} title={a.notes ?? ''}>
          {a.name}
          {a.severity ? ` · ${t(`wb.sev.${a.severity}` as TranslationKey)}` : ''}
        </span>
      ))}
    </section>
  )
}

export function VisitList({ visits, showStudent }: { visits: ClinicVisit[]; showStudent: boolean }) {
  const { t, lang } = useI18n()
  if (visits.length === 0) return <div className="empty-state">{t('wb.visits.none')}</div>
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>{t('wb.visit.when')}</th>
            {showStudent && <th>{t('wb.visit.student')}</th>}
            <th>{t('wb.visit.complaint')}</th>
            <th>{t('wb.visit.treatment')}</th>
            <th>{t('wb.visit.outcome')}</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => (
            <tr key={v.id}>
              <td className="mono">{new Date(v.visitedAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' })}</td>
              {showStudent && (
                <td>
                  <Link to={`/students/${v.studentId}?tab=health`}>{v.studentName}</Link>{' '}
                  <small className="card__hint mono">{v.studentNumber}</small>
                </td>
              )}
              <td>
                {v.complaint}
                {v.temperature !== null && <small className="card__hint"> · {v.temperature}°C</small>}
              </td>
              <td>{[v.treatment, v.medicationGiven].filter(Boolean).join(' · ') || '—'}</td>
              <td>
                <span className={`chip ${OUTCOME_TONE[v.outcome]}`}>{t(`wb.outcome.${v.outcome}` as TranslationKey)}</span>
                {v.parentsNotifiedAt && <small className="card__hint"> {t('wb.visit.told')}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Records a visit: for one student (profile) or a picked one (Clinic). */
export function VisitForm({ studentId, branchId, onSaved }: { studentId?: string; branchId?: string; onSaved: () => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [picked, setPicked] = useState<PickedPerson | null>(null)
  const empty = {
    complaint: '',
    temperature: '',
    treatment: '',
    medicationGiven: '',
    outcome: 'returned_to_class' as Outcome,
    notes: '',
    notify: false,
  }
  const [f, setF] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null)
  const who = studentId ?? picked?.id
  const tells = f.outcome === 'sent_home' || f.outcome === 'referred' || f.outcome === 'emergency'

  const save = async () => {
    if (!who || !f.complaint.trim()) return
    setBusy(true)
    setNote(null)
    const res = await recordVisit(getAccessToken, {
      studentId: who,
      complaint: f.complaint.trim(),
      temperature: f.temperature ? Number(f.temperature) : null,
      treatment: f.treatment.trim() || null,
      medicationGiven: f.medicationGiven.trim() || null,
      outcome: f.outcome,
      notes: f.notes.trim() || null,
      notifyParents: f.notify,
    })
    setBusy(false)
    if (res.kind !== 'ok') return setNote({ text: wellbeingError(t, res.error), warn: true })
    setNote({ text: res.data.parentsNotifiedAt ? t('wb.visit.savedTold') : t('wb.visit.saved'), warn: false })
    setF(empty)
    if (!studentId) setPicked(null)
    onSaved()
  }

  return (
    <div className="stack-form">
      {!studentId &&
        (picked ? (
          <p>
            <b>{picked.label}</b>{' '}
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPicked(null)}>
              {t('wb.change')}
            </button>
          </p>
        ) : (
          <PersonPicker branchId={branchId} onPick={setPicked} />
        ))}
      {studentId || picked ? <HealthAlertsBanner studentId={(studentId ?? picked?.id)!} /> : null}
      <div className="inline-form">
        <input
          className="input input--sm"
          style={{ flex: 2, minWidth: 200 }}
          placeholder={t('wb.visit.complaint')}
          aria-label={t('wb.visit.complaint')}
          value={f.complaint}
          onChange={(e) => setF({ ...f, complaint: e.target.value })}
        />
        <input
          className="input input--sm"
          style={{ width: 90 }}
          inputMode="decimal"
          placeholder="°C"
          aria-label={t('wb.visit.temperature')}
          value={f.temperature}
          onChange={(e) => setF({ ...f, temperature: e.target.value.replace(/[^\d.]/g, '') })}
        />
        <select
          className="select input--sm"
          aria-label={t('wb.visit.outcome')}
          value={f.outcome}
          onChange={(e) => setF({ ...f, outcome: e.target.value as Outcome })}
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t(`wb.outcome.${o}` as TranslationKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-form">
        <input
          className="input input--sm"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('wb.visit.treatment')}
          aria-label={t('wb.visit.treatment')}
          value={f.treatment}
          onChange={(e) => setF({ ...f, treatment: e.target.value })}
        />
        <input
          className="input input--sm"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('wb.visit.medication')}
          aria-label={t('wb.visit.medication')}
          value={f.medicationGiven}
          onChange={(e) => setF({ ...f, medicationGiven: e.target.value })}
        />
      </div>
      <div className="inline-form">
        {tells ? (
          <small className="card__hint">{t('wb.visit.willTell')}</small>
        ) : (
          <label className="checkbox-inline">
            <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} />
            {t('wb.visit.tellFamily')}
          </label>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={busy || !who || !f.complaint.trim()}
          onClick={() => void save()}
        >
          {t('wb.visit.record')}
        </button>
      </div>
      {note && <p className={`notice${note.warn ? ' notice--warn' : ''}`}>{note.text}</p>}
    </div>
  )
}

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
const EMPTY: HealthProfile = {
  bloodType: null,
  allergies: [],
  conditions: [],
  medications: [],
  doctorName: null,
  doctorPhone: null,
  notes: null,
}

/** The student profile's Health tab: the record, and the visits. */
export function HealthTab({ studentId }: { studentId: string }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canEdit = can('health.write')
  const [profile, setProfile] = useState<HealthProfile | null>(null)
  const [visits, setVisits] = useState<ClinicVisit[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<HealthProfile>(EMPTY)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await getHealth(getAccessToken, studentId)
    if (res.kind !== 'ok') return setError(wellbeingError(t, res.error))
    setProfile(res.data.profile ?? EMPTY)
    setVisits(res.data.visits)
  }, [getAccessToken, studentId, t])
  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    const res = await saveHealth(getAccessToken, studentId, draft)
    if (res.kind !== 'ok') return setError(wellbeingError(t, res.error))
    setEditing(false)
    setError(null)
    await load()
  }

  if (error) return <div className="empty-state">{error}</div>
  if (!profile || !visits) return <div className="skeleton" style={{ height: 160 }} />
  const setList = <K extends 'allergies' | 'conditions' | 'medications'>(k: K, rows: HealthProfile[K]) => setDraft({ ...draft, [k]: rows })
  const text = (v: string) => v || null

  return (
    <div className="card-row card-row--wide-first">
      <section className="card profile-card">
        <div className="card__head">
          <h2 className="card__title">{t('wb.profile')}</h2>
          {canEdit && !editing && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setDraft(profile)
                setEditing(true)
              }}
            >
              {t('rep.sch.edit')}
            </button>
          )}
        </div>
        {!editing ? (
          <>
            <div className="stat-row">
              <span>{t('wb.bloodType')}</span>
              <b className="mono">{profile.bloodType ?? '—'}</b>
            </div>
            <h3 className="card__subtitle">{t('wb.allergies')}</h3>
            {profile.allergies.length === 0 ? (
              <p className="card__hint">{t('wb.none')}</p>
            ) : (
              profile.allergies.map((a) => (
                <div key={a.id} className="stat-row">
                  <span>
                    {a.name} {a.alert && <span className="chip chip--bad">{t('wb.alert')}</span>}
                    <small className="card__hint">{[a.reaction, a.notes].filter(Boolean).map((x) => ` · ${x}`)}</small>
                  </span>
                  <span className={`chip ${a.severity === 'severe' ? 'chip--bad' : a.severity === 'moderate' ? 'chip--warn' : ''}`}>
                    {t(`wb.sev.${a.severity}` as TranslationKey)}
                  </span>
                </div>
              ))
            )}
            <h3 className="card__subtitle">{t('wb.conditions')}</h3>
            {profile.conditions.length === 0 ? (
              <p className="card__hint">{t('wb.none')}</p>
            ) : (
              profile.conditions.map((c) => (
                <div key={c.id} className="stat-row">
                  <span>
                    {c.name} {c.alert && <span className="chip chip--bad">{t('wb.alert')}</span>}
                    {c.notes && <small className="card__hint"> · {c.notes}</small>}
                  </span>
                </div>
              ))
            )}
            <h3 className="card__subtitle">{t('wb.medications')}</h3>
            {profile.medications.length === 0 ? (
              <p className="card__hint">{t('wb.none')}</p>
            ) : (
              profile.medications.map((m) => (
                <div key={m.id} className="stat-row">
                  <span>
                    {m.name}
                    <small className="card__hint">{[m.dose, m.schedule].filter(Boolean).map((x) => ` · ${x}`)}</small>
                  </span>
                  {m.atSchool && <span className="chip chip--on">{t('wb.atSchool')}</span>}
                </div>
              ))
            )}
            <h3 className="card__subtitle">{t('wb.doctor')}</h3>
            <p>
              {[profile.doctorName, profile.doctorPhone].filter(Boolean).join(' · ') || '—'}
              {profile.notes && <span className="card__hint"> — {profile.notes}</span>}
            </p>
          </>
        ) : (
          <div className="stack-form">
            <label className="field field--inline">
              <span>{t('wb.bloodType')}</span>
              <select
                className="select input--sm"
                value={draft.bloodType ?? ''}
                onChange={(e) => setDraft({ ...draft, bloodType: e.target.value || null })}
              >
                <option value="">—</option>
                {BLOOD.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <h3 className="card__subtitle">{t('wb.allergies')}</h3>
            {draft.allergies.map((a, i) => (
              <div key={i} className="inline-form">
                <input
                  className="input input--sm"
                  placeholder={t('wb.name')}
                  aria-label={t('wb.name')}
                  value={a.name}
                  onChange={(e) =>
                    setList(
                      'allergies',
                      draft.allergies.map((x, j): Allergy => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <select
                  className="select input--sm"
                  aria-label={t('wb.severity')}
                  value={a.severity}
                  onChange={(e) =>
                    setList(
                      'allergies',
                      draft.allergies.map((x, j): Allergy => (j === i ? { ...x, severity: e.target.value as Allergy['severity'] } : x)),
                    )
                  }
                >
                  {(['mild', 'moderate', 'severe'] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`wb.sev.${s}` as TranslationKey)}
                    </option>
                  ))}
                </select>
                <input
                  className="input input--sm"
                  placeholder={t('wb.reaction')}
                  aria-label={t('wb.reaction')}
                  value={a.reaction ?? ''}
                  onChange={(e) =>
                    setList(
                      'allergies',
                      draft.allergies.map((x, j): Allergy => (j === i ? { ...x, reaction: text(e.target.value) } : x)),
                    )
                  }
                />
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={a.alert}
                    onChange={(e) =>
                      setList(
                        'allergies',
                        draft.allergies.map((x, j): Allergy => (j === i ? { ...x, alert: e.target.checked } : x)),
                      )
                    }
                  />
                  {t('wb.showStaff')}
                </label>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() =>
                    setList(
                      'allergies',
                      draft.allergies.filter((_, j) => j !== i),
                    )
                  }
                >
                  {t('wb.remove')}
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() =>
                  setList('allergies', [...draft.allergies, { name: '', severity: 'moderate', reaction: null, notes: null, alert: false }])
                }
              >
                + {t('wb.addAllergy')}
              </button>
            </div>
            <h3 className="card__subtitle">{t('wb.conditions')}</h3>
            {draft.conditions.map((c, i) => (
              <div key={i} className="inline-form">
                <input
                  className="input input--sm"
                  placeholder={t('wb.name')}
                  aria-label={t('wb.name')}
                  value={c.name}
                  onChange={(e) =>
                    setList(
                      'conditions',
                      draft.conditions.map((x, j): HealthItem => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <input
                  className="input input--sm"
                  style={{ flex: 1 }}
                  placeholder={t('wb.notes')}
                  aria-label={t('wb.notes')}
                  value={c.notes ?? ''}
                  onChange={(e) =>
                    setList(
                      'conditions',
                      draft.conditions.map((x, j): HealthItem => (j === i ? { ...x, notes: text(e.target.value) } : x)),
                    )
                  }
                />
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={c.alert}
                    onChange={(e) =>
                      setList(
                        'conditions',
                        draft.conditions.map((x, j): HealthItem => (j === i ? { ...x, alert: e.target.checked } : x)),
                      )
                    }
                  />
                  {t('wb.showStaff')}
                </label>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() =>
                    setList(
                      'conditions',
                      draft.conditions.filter((_, j) => j !== i),
                    )
                  }
                >
                  {t('wb.remove')}
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => setList('conditions', [...draft.conditions, { name: '', notes: null, alert: false }])}
              >
                + {t('wb.addCondition')}
              </button>
            </div>
            <h3 className="card__subtitle">{t('wb.medications')}</h3>
            {draft.medications.map((m, i) => (
              <div key={i} className="inline-form">
                <input
                  className="input input--sm"
                  placeholder={t('wb.name')}
                  aria-label={t('wb.name')}
                  value={m.name}
                  onChange={(e) =>
                    setList(
                      'medications',
                      draft.medications.map((x, j): Medication => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <input
                  className="input input--sm"
                  placeholder={t('wb.dose')}
                  aria-label={t('wb.dose')}
                  value={m.dose ?? ''}
                  onChange={(e) =>
                    setList(
                      'medications',
                      draft.medications.map((x, j): Medication => (j === i ? { ...x, dose: text(e.target.value) } : x)),
                    )
                  }
                />
                <input
                  className="input input--sm"
                  placeholder={t('wb.schedule')}
                  aria-label={t('wb.schedule')}
                  value={m.schedule ?? ''}
                  onChange={(e) =>
                    setList(
                      'medications',
                      draft.medications.map((x, j): Medication => (j === i ? { ...x, schedule: text(e.target.value) } : x)),
                    )
                  }
                />
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={m.atSchool}
                    onChange={(e) =>
                      setList(
                        'medications',
                        draft.medications.map((x, j): Medication => (j === i ? { ...x, atSchool: e.target.checked } : x)),
                      )
                    }
                  />
                  {t('wb.atSchool')}
                </label>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() =>
                    setList(
                      'medications',
                      draft.medications.filter((_, j) => j !== i),
                    )
                  }
                >
                  {t('wb.remove')}
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => setList('medications', [...draft.medications, { name: '', dose: null, schedule: null, atSchool: false }])}
              >
                + {t('wb.addMedication')}
              </button>
            </div>
            <h3 className="card__subtitle">{t('wb.doctor')}</h3>
            <div className="inline-form">
              <input
                className="input input--sm"
                placeholder={t('wb.name')}
                aria-label={t('wb.doctor')}
                value={draft.doctorName ?? ''}
                onChange={(e) => setDraft({ ...draft, doctorName: text(e.target.value) })}
              />
              <input
                className="input input--sm"
                dir="ltr"
                placeholder={t('wb.phone')}
                aria-label={t('wb.phone')}
                value={draft.doctorPhone ?? ''}
                onChange={(e) => setDraft({ ...draft, doctorPhone: text(e.target.value) })}
              />
            </div>
            <textarea
              className="input"
              rows={3}
              placeholder={t('wb.notes')}
              aria-label={t('wb.notes')}
              value={draft.notes ?? ''}
              onChange={(e) => setDraft({ ...draft, notes: text(e.target.value) })}
            />
            <div className="inline-form">
              <button
                type="button"
                className="btn btn--primary"
                disabled={[...draft.allergies, ...draft.conditions, ...draft.medications].some((x) => !x.name.trim())}
                onClick={() => void save()}
              >
                {t('comm.save')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>
                {t('docs.cancel')}
              </button>
            </div>
          </div>
        )}
        {profile.updatedAt && <p className="card__hint">{t('wb.updated', { date: profile.updatedAt.slice(0, 10) })}</p>}
      </section>
      {canEdit && (
        <section className="card profile-card">
          <h2 className="card__title">{t('wb.visit.new')}</h2>
          <VisitForm studentId={studentId} onSaved={() => void load()} />
        </section>
      )}
      <section className="card profile-card profile-card--full">
        <h2 className="card__title">{t('wb.visits')}</h2>
        <VisitList visits={visits} showStudent={false} />
      </section>
    </div>
  )
}
