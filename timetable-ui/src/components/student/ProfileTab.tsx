import { useEffect, useMemo, useState } from 'react'
import type { EmergencyContact, Student } from '../../domain/students'
import type { FleetProblem } from '../../domain/fleet'
import { findNearestStop } from '../../domain/fleet'
import { updateStudent, type NewStudent } from '../../lib/studentsApi'
import { listLookups, lookupLabel, type LookupItem } from '../../lib/settingsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { LocationPicker } from '../LocationPicker'

/** The editable scalar fields, as the form holds them (strings, '' = empty). */
const FIELDS = [
  'givenName',
  'familyName',
  'givenNameAr',
  'familyNameAr',
  'preferredName',
  'dob',
  'gender',
  'nationality',
  'nationalId',
  'admissionDate',
  'admissionSource',
  'previousSchool',
  'address',
  'primaryPhone',
  'secondaryPhone',
  'medicalNotes',
  'custodyNotes',
] as const
type Field = (typeof FIELDS)[number]
type Form = Record<Field, string>

/** Fields the server requires as strings rather than null when empty. */
const NON_NULL: ReadonlySet<Field> = new Set(['givenName', 'familyName', 'primaryPhone', 'secondaryPhone'])

function toForm(student: Student): Form {
  const form = {} as Form
  for (const field of FIELDS) form[field] = ((student as unknown as Record<string, unknown>)[field] as string) ?? ''
  return form
}

const emptyContact = (): EmergencyContact => ({ name: '', relationship: '', phone: '', alternatePhone: null, notes: null })

const ERRORS: Record<string, TranslationKey> = {
  INVALID_BODY: 'profile.error.invalid',
  INVALID_ADMISSION_SOURCE: 'profile.error.source',
  FORBIDDEN: 'profile.error.forbidden',
  BRANCH_FORBIDDEN: 'profile.error.forbidden',
}

/**
 * Identity, admission, contact, health, custody (with `students.custody`
 * only), emergency contacts and home location. One Save sends only the
 * fields that changed, so two people editing different parts don't
 * overwrite each other.
 */
export function ProfileTab({
  student,
  fleet,
  onChanged,
}: {
  student: Student
  fleet: FleetProblem
  onChanged: (updated: Student) => void
}) {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const editable = can('students.update')
  const custody = can('students.custody') && 'custodyNotes' in student

  const [form, setForm] = useState<Form>(() => toForm(student))
  const [contacts, setContacts] = useState<EmergencyContact[]>(() => student.emergencyContacts ?? [])
  const [sources, setSources] = useState<LookupItem[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void listLookups(getAccessToken, 'admissionSource', true).then((res) => {
      if (res.kind === 'ok') setSources(res.data)
    })
  }, [getAccessToken])

  const original = useMemo(() => toForm(student), [student])
  const changedFields = FIELDS.filter((f) => form[f] !== original[f] && (f !== 'custodyNotes' || custody))
  const contactsChanged = JSON.stringify(contacts) !== JSON.stringify(student.emergencyContacts ?? [])
  const dirty = changedFields.length > 0 || contactsChanged
  const contactsValid = contacts.every((c) => c.name.trim() && c.relationship.trim() && c.phone.trim().length >= 5)

  const set = (field: Field) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: event.target.value }))

  const save = async () => {
    if (!contactsValid) return setMessage({ ok: false, text: t('profile.error.contacts') })
    const patch: Record<string, unknown> = {}
    for (const f of changedFields) {
      const value = form[f].trim()
      patch[f] = value === '' && !NON_NULL.has(f) ? null : value
    }
    if (contactsChanged) patch.emergencyContacts = contacts
    setSaving(true)
    setMessage(null)
    const res = await updateStudent(getAccessToken, student.id, patch as Partial<NewStudent>)
    setSaving(false)
    if (res.kind !== 'ok') return setMessage({ ok: false, text: t(ERRORS[res.error] ?? 'profile.error.generic') })
    setMessage({ ok: true, text: t('profile.saved') })
    setContacts(res.data.emergencyContacts ?? [])
    onChanged({ ...res.data, photoDocumentId: student.photoDocumentId })
  }

  const text = (field: Field, label: TranslationKey, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field">
      <span>{t(label)}</span>
      <input className="input" value={form[field]} onChange={set(field)} disabled={!editable} {...props} />
    </label>
  )

  const activeSources = sources.filter((s) => s.active || s.code === form.admissionSource)

  return (
    <div className="profile-grid">
      <section className="card profile-card">
        <h2 className="card__title">{t('profile.identity')}</h2>
        <div className="field-grid">
          {text('givenName', 'profile.givenName', { required: true })}
          {text('familyName', 'profile.familyName', { required: true })}
          {text('givenNameAr', 'profile.givenNameAr', { dir: 'rtl' })}
          {text('familyNameAr', 'profile.familyNameAr', { dir: 'rtl' })}
          {text('preferredName', 'profile.preferredName')}
          {text('dob', 'profile.dob', { type: 'date' })}
          <label className="field">
            <span>{t('profile.gender')}</span>
            <select className="input" value={form.gender} onChange={set('gender')} disabled={!editable}>
              <option value="">—</option>
              <option value="female">{t('profile.gender.female')}</option>
              <option value="male">{t('profile.gender.male')}</option>
            </select>
          </label>
          {text('nationality', 'profile.nationality')}
          {text('nationalId', 'profile.nationalId')}
        </div>
      </section>

      <section className="card profile-card">
        <h2 className="card__title">{t('profile.admission')}</h2>
        <div className="field-grid">
          {text('admissionDate', 'profile.admissionDate', { type: 'date' })}
          <label className="field">
            <span>{t('profile.admissionSource')}</span>
            <select className="input" value={form.admissionSource} onChange={set('admissionSource')} disabled={!editable}>
              <option value="">—</option>
              {activeSources.map((s) => (
                <option key={s.code} value={s.code}>
                  {lookupLabel(sources, s.code, lang)}
                </option>
              ))}
            </select>
          </label>
          {text('previousSchool', 'profile.previousSchool')}
        </div>
      </section>

      <section className="card profile-card">
        <h2 className="card__title">{t('profile.contact')}</h2>
        <div className="field-grid">
          {text('primaryPhone', 'profile.primaryPhone', { type: 'tel' })}
          {text('secondaryPhone', 'profile.secondaryPhone', { type: 'tel' })}
          <label className="field field--wide">
            <span>{t('profile.address')}</span>
            <input className="input" value={form.address} onChange={set('address')} disabled={!editable} />
          </label>
        </div>
      </section>

      <section className="card profile-card">
        <h2 className="card__title">{t('profile.health')}</h2>
        <label className="field">
          <span>{t('profile.medicalNotes')}</span>
          <textarea className="input" rows={3} value={form.medicalNotes} onChange={set('medicalNotes')} disabled={!editable} />
        </label>
      </section>

      {custody && (
        <section className="card profile-card profile-card--restricted">
          <h2 className="card__title">{t('profile.custody')}</h2>
          <p className="card__hint">{t('profile.custodyHint')}</p>
          <label className="field">
            <span>{t('profile.custodyNotes')}</span>
            <textarea className="input" rows={3} value={form.custodyNotes} onChange={set('custodyNotes')} disabled={!editable} />
          </label>
        </section>
      )}

      <section className="card profile-card">
        <div className="card__head">
          <h2 className="card__title">{t('profile.emergencyContacts')}</h2>
          {editable && contacts.length < 5 && (
            <button type="button" className="btn btn--sm" onClick={() => setContacts((c) => [...c, emptyContact()])}>
              {t('profile.addContact')}
            </button>
          )}
        </div>
        {contacts.length === 0 && <div className="empty-state">{t('profile.noContacts')}</div>}
        <div className="profile-contacts">
          {contacts.map((c, i) => {
            const patch = (changes: Partial<EmergencyContact>) =>
              setContacts((all) => all.map((x, j) => (j === i ? { ...x, ...changes } : x)))
            return (
              <fieldset key={c.id ?? `new-${i}`} className="profile-contact" disabled={!editable}>
                <legend className="visually-hidden">{t('profile.contactN', { n: String(i + 1) })}</legend>
                <label className="field">
                  <span>{t('profile.contactName')}</span>
                  <input className="input" value={c.name} onChange={(e) => patch({ name: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t('profile.relationship')}</span>
                  <input className="input" value={c.relationship} onChange={(e) => patch({ relationship: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t('profile.phone')}</span>
                  <input className="input" type="tel" value={c.phone} onChange={(e) => patch({ phone: e.target.value })} />
                </label>
                <label className="field">
                  <span>{t('profile.alternatePhone')}</span>
                  <input
                    className="input"
                    type="tel"
                    value={c.alternatePhone ?? ''}
                    onChange={(e) => patch({ alternatePhone: e.target.value || null })}
                  />
                </label>
                <label className="field field--wide">
                  <span>{t('profile.contactNotes')}</span>
                  <input className="input" value={c.notes ?? ''} onChange={(e) => patch({ notes: e.target.value || null })} />
                </label>
                {editable && (
                  <button
                    type="button"
                    className="icon-btn profile-contact__remove"
                    onClick={() => setContacts((all) => all.filter((_, j) => j !== i))}
                    aria-label={t('profile.removeContact', { name: c.name || String(i + 1) })}
                  >
                    ×
                  </button>
                )}
              </fieldset>
            )
          })}
        </div>
      </section>

      {editable && (
        <div className={`profile-save${dirty ? ' profile-save--dirty' : ''}`} aria-live="polite">
          {message && <span className={message.ok ? 'profile-save__ok' : 'login__error'}>{message.text}</span>}
          <button
            type="button"
            className="btn"
            disabled={!dirty || saving}
            onClick={() => {
              setForm(original)
              setContacts(student.emergencyContacts ?? [])
              setMessage(null)
            }}
          >
            {t('profile.discard')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t('profile.saving') : t('profile.save')}
          </button>
        </div>
      )}

      <HomeLocation student={student} fleet={fleet} editable={editable} onChanged={onChanged} />
    </div>
  )
}

/** The student's pickup pin and the nearest-stop suggestion. Saves on each
 * change, like the routes map does. */
function HomeLocation({
  student,
  fleet,
  editable,
  onChanged,
}: {
  student: Student
  fleet: FleetProblem
  editable: boolean
  onChanged: (updated: Student) => void
}) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [location, setLocation] = useState({ lat: student.lat ?? null, lng: student.lng ?? null })
  const [saving, setSaving] = useState(false)

  const save = async (next: { lat: number | null; lng: number | null }) => {
    const previous = location
    setLocation(next)
    setSaving(true)
    const res = await updateStudent(getAccessToken, student.id, next)
    setSaving(false)
    if (res.kind === 'ok') onChanged({ ...res.data, photoDocumentId: student.photoDocumentId })
    else setLocation(previous)
  }

  // Suggest, never auto-assign: the school confirms the nearest stop.
  const nearest = useMemo(
    () =>
      location.lat != null && location.lng != null
        ? findNearestStop({ lat: location.lat, lng: location.lng }, fleet.stops)
        : null,
    [location.lat, location.lng, fleet.stops],
  )

  const assignNearest = async () => {
    if (!nearest) return
    const res = await updateStudent(getAccessToken, student.id, { stopId: nearest.stop.id })
    if (res.kind === 'ok') onChanged({ ...res.data, photoDocumentId: student.photoDocumentId })
  }

  return (
    <section className="card profile-card profile-card--full">
      <div className="card__head">
        <h2 className="card__title">{t('students.location')}</h2>
        {saving && <span className="card__hint">{t('students.saving')}</span>}
        {editable && location.lat != null && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void save({ lat: null, lng: null })}>
            {t('students.clearLocation')}
          </button>
        )}
      </div>
      <p className="card__hint" style={{ marginTop: 0 }}>
        {t('students.locationHint')}
      </p>
      <LocationPicker
        lat={location.lat}
        lng={location.lng}
        center={fleet.depot}
        onChange={(lat, lng) => {
          if (editable) void save({ lat, lng })
        }}
      />
      {editable && (
        <div className="break-card__row" style={{ gap: 6, marginTop: 8 }}>
          {(['lat', 'lng'] as const).map((axis) => (
            <input
              key={`${axis}-${location[axis] ?? ''}`}
              className="input input--sm"
              style={{ maxWidth: 140 }}
              inputMode="decimal"
              aria-label={t(axis === 'lat' ? 'students.lat' : 'students.lng')}
              placeholder={t(axis === 'lat' ? 'students.lat' : 'students.lng')}
              defaultValue={location[axis] ?? ''}
              // Commits on blur, so a half-typed "-3" or "31." isn't parsed.
              onBlur={(e) => {
                const raw = e.target.value.trim()
                const value = raw === '' ? null : Number(raw)
                if (value !== null && !Number.isFinite(value)) return
                if (value !== location[axis]) void save({ ...location, [axis]: value })
              }}
            />
          ))}
        </div>
      )}
      {nearest && nearest.stop.id !== student.stopId && editable && (
        <p className="card__hint" style={{ marginTop: 8 }}>
          {t('students.nearestStop', { stop: nearest.stop.name, distance: String(Math.round(nearest.distanceM)) })}{' '}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void assignNearest()}>
            {t('students.useNearestStop')}
          </button>
        </p>
      )}
    </section>
  )
}
