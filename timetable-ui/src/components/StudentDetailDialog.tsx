import { useEffect, useMemo, useState } from 'react'
import type { Guardian, GuardianLanguage, Student } from '../domain/students'
import { emptyGuardian } from '../domain/students'
import type { SchoolClass } from '../domain/classes'
import type { FleetProblem } from '../domain/fleet'
import { findNearestStop } from '../domain/fleet'
import type { FeeStructure, Invoice, StudentBalance } from '../domain/finance'
import { formatMinorUnits } from '../domain/finance'
import { updateStudent } from '../lib/studentsApi'
import { getEnrollments, transferStudent, withdrawStudent } from '../lib/enrollmentsApi'
import type { Enrollment } from '../lib/enrollmentsApi'
import { generateInvoice, getStudentBalance, listFeeStructures, listInvoices } from '../lib/financeApi'
import type { TokenGetter } from '../lib/http'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { LocationPicker } from './LocationPicker'
import { InvoiceDetailDialog } from './InvoiceDetailDialog'

/**
 * Everything about one student that doesn't belong in the roster table:
 * the full guardian list (with per-guardian language and notification
 * opt-in), and the enrolment actions — transfer and withdraw — plus the
 * enrolment history they produce.
 */
export function StudentDetailDialog({
  student,
  classes,
  fleet,
  getAccessToken,
  onClose,
  onChanged,
}: {
  student: Student
  classes: SchoolClass[]
  fleet: FleetProblem
  getAccessToken: TokenGetter
  onClose: () => void
  onChanged: (updated: Student) => void
}) {
  const { t } = useI18n()
  const { can } = useAuth()
  const name = `${student.givenName} ${student.familyName}`.trim()

  const [balance, setBalance] = useState<StudentBalance | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [feeStructures, setFeeStructures] = useState<FeeStructure[]>([])
  const [generating, setGenerating] = useState(false)
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null)

  const loadBilling = async () => {
    const [balanceRes, invoicesRes] = await Promise.all([
      getStudentBalance(getAccessToken, student.id),
      listInvoices(getAccessToken, { studentId: student.id }),
    ])
    if (balanceRes.kind === 'ok') setBalance(balanceRes.data)
    if (invoicesRes.kind === 'ok') setInvoices(invoicesRes.data)
  }
  useEffect(() => {
    void loadBilling()
    if (student.branchId) {
      void listFeeStructures(getAccessToken, { branchId: student.branchId }).then((res) => {
        if (res.kind === 'ok') setFeeStructures(res.data)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id])

  const generateFromStructure = async (feeStructureId: string) => {
    if (!feeStructureId) return
    setGenerating(true)
    await generateInvoice(getAccessToken, { studentId: student.id, feeStructureId })
    setGenerating(false)
    await loadBilling()
  }

  const [guardians, setGuardians] = useState<Guardian[]>(() => student.guardians ?? [])
  const [savingG, setSavingG] = useState(false)
  const [gErr, setGErr] = useState<string | null>(null)

  const [location, setLocation] = useState<{ lat: number | null; lng: number | null }>({
    lat: student.lat ?? null,
    lng: student.lng ?? null,
  })
  const [savingLoc, setSavingLoc] = useState(false)

  const saveLocation = async (next: { lat: number | null; lng: number | null }) => {
    const previous = location
    setLocation(next)
    setSavingLoc(true)
    const token = await getAccessToken()
    if (!token) return setSavingLoc(false)
    const res = await updateStudent(getAccessToken, student.id, { lat: next.lat, lng: next.lng })
    setSavingLoc(false)
    if (res.kind === 'ok') onChanged(res.data)
    else setLocation(previous)
  }

  // Suggest, never auto-assign — a pin's nearest stop is a hint the school
  // confirms with a click, not a silent rewrite of an existing assignment.
  const nearestStop = useMemo(
    () => (location.lat != null && location.lng != null ? findNearestStop({ lat: location.lat, lng: location.lng }, fleet.stops) : null),
    [location.lat, location.lng, fleet.stops],
  )

  const assignNearestStop = async () => {
    if (!nearestStop) return
    const res = await updateStudent(getAccessToken, student.id, { stopId: nearestStop.stop.id })
    if (res.kind === 'ok') onChanged(res.data)
  }

  // Separate draft text so an in-progress keystroke like "-" (typing a
  // negative coordinate) or "12." isn't immediately parsed, found invalid,
  // and silently discarded — which made the controlled input snap back and
  // look like the keystroke did nothing. The draft only commits (and syncs
  // back from) `location` once it parses to a real number.
  const [latDraft, setLatDraft] = useState(String(location.lat ?? ''))
  const [lngDraft, setLngDraft] = useState(String(location.lng ?? ''))
  useEffect(() => {
    setLatDraft(String(location.lat ?? ''))
  }, [location.lat])
  useEffect(() => {
    setLngDraft(String(location.lng ?? ''))
  }, [location.lng])

  const [toClassId, setToClassId] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [wStatus, setWStatus] = useState<'withdrawn' | 'graduated'>('withdrawn')
  const [busy, setBusy] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const [history, setHistory] = useState<Enrollment[]>([])

  const loadHistory = async () => {
    const token = await getAccessToken()
    if (!token) return
    const res = await getEnrollments(getAccessToken, student.id)
    if (res.kind === 'ok') setHistory(res.data)
  }
  useEffect(() => {
    void loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student.id])

  const patchGuardian = (i: number, changes: Partial<Guardian>) =>
    setGuardians((gs) => gs.map((g, j) => (j === i ? { ...g, ...changes } : g)))

  const saveGuardians = async () => {
    if (guardians.filter((g) => g.isPrimary).length > 1) {
      setGErr(t('students.sameNumber'))
      return
    }
    setSavingG(true)
    setGErr(null)
    const token = await getAccessToken()
    if (!token) return setSavingG(false)
    const res = await updateStudent(getAccessToken, student.id, { guardians })
    setSavingG(false)
    if (res.kind === 'ok') onChanged(res.data)
    else setGErr(t('enroll.error.generic'))
  }

  const doTransfer = async () => {
    if (!toClassId) return
    setBusy(true)
    setActionErr(null)
    const token = await getAccessToken()
    if (!token) return setBusy(false)
    const res = await transferStudent(getAccessToken, student.id, {
      toClassId,
      effectiveDate,
      reason: reason.trim() || null,
    })
    setBusy(false)
    if (res.kind === 'ok') {
      setReason('')
      await loadHistory()
      onChanged({ ...student, classId: toClassId, branchId: res.data.to.branchId })
    } else {
      setActionErr(t(`enroll.error.${res.error}` as TranslationKey, {}) || t('enroll.error.generic'))
    }
  }

  const doWithdraw = async () => {
    setBusy(true)
    setActionErr(null)
    const token = await getAccessToken()
    if (!token) return setBusy(false)
    const res = await withdrawStudent(getAccessToken, student.id, {
      status: wStatus,
      effectiveDate,
      reason: reason.trim() || null,
    })
    setBusy(false)
    if (res.kind === 'ok') {
      setReason('')
      await loadHistory()
      onChanged({ ...student, status: wStatus, active: false })
    } else {
      setActionErr(t(`enroll.error.${res.error}` as TranslationKey, {}) || t('enroll.error.generic'))
    }
  }

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog__panel" style={{ maxWidth: 720 }}>
        <div className="dialog__head">
          <strong>{name || student.studentNumber}</strong>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="dialog__body" style={{ display: 'grid', gap: 18 }}>
          <section>
            <div className="page__actions" style={{ marginBottom: 8 }}>
              <h3 className="card__subtitle" style={{ margin: 0, flex: 1 }}>{t('nav.students')}</h3>
              <button type="button" className="btn btn--sm" onClick={() => setGuardians((gs) => [...gs, emptyGuardian()])}>
                {t('guardian.add')}
              </button>
            </div>
            {guardians.length === 0 && <p className="card__hint">—</p>}
            {guardians.map((g, i) => (
              <div key={g.id ?? i} className="card" style={{ padding: 10, marginBottom: 8 }}>
                <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <input className="input input--sm" style={{ minWidth: 130 }} placeholder={t('students.name')} value={g.name} onChange={(e) => patchGuardian(i, { name: e.target.value })} />
                  <input className="input input--sm" style={{ minWidth: 90 }} placeholder="relationship" value={g.relationship} onChange={(e) => patchGuardian(i, { relationship: e.target.value })} />
                  <input className="input input--sm" style={{ minWidth: 120 }} placeholder={t('students.primaryPhone')} value={g.phone} onChange={(e) => patchGuardian(i, { phone: e.target.value })} />
                  <input className="input input--sm" style={{ minWidth: 150 }} placeholder="email" value={g.email ?? ''} onChange={(e) => patchGuardian(i, { email: e.target.value || null })} />
                  <select className="input input--sm" value={g.preferredLanguage} onChange={(e) => patchGuardian(i, { preferredLanguage: e.target.value as GuardianLanguage })} aria-label={t('guardian.language')}>
                    <option value="en">EN</option>
                    <option value="ar">AR</option>
                  </select>
                </div>
                <div className="break-card__row" style={{ gap: 12, marginTop: 6 }}>
                  <label className="inline-field"><input type="checkbox" checked={g.isPrimary} onChange={(e) => patchGuardian(i, { isPrimary: e.target.checked })} />{t('students.primaryPhone')}</label>
                  <label className="inline-field"><input type="checkbox" checked={g.notifyByEmail} onChange={(e) => patchGuardian(i, { notifyByEmail: e.target.checked })} />{t('guardian.notifyEmail')}</label>
                  <label className="inline-field"><input type="checkbox" checked={g.notifyBySms} onChange={(e) => patchGuardian(i, { notifyBySms: e.target.checked })} />{t('guardian.notifySms')}</label>
                  <label className="inline-field"><input type="checkbox" checked={g.active} onChange={(e) => patchGuardian(i, { active: e.target.checked })} />{t('guardian.active')}</label>
                  <button type="button" className="icon-btn" style={{ marginInlineStart: 'auto' }} onClick={() => setGuardians((gs) => gs.filter((_, j) => j !== i))} aria-label={t('guardian.remove')}>×</button>
                </div>
              </div>
            ))}
            {gErr && <p className="login__error">{gErr}</p>}
            <button type="button" className="btn btn--sm btn--primary" disabled={savingG} onClick={() => void saveGuardians()}>
              {t('notify.save')}
            </button>
          </section>

          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div className="page__actions" style={{ marginBottom: 8 }}>
              <h3 className="card__subtitle" style={{ margin: 0, flex: 1 }}>{t('students.location')}</h3>
              {savingLoc && <span className="card__hint">{t('students.saving')}</span>}
              {location.lat != null && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void saveLocation({ lat: null, lng: null })}
                >
                  {t('students.clearLocation')}
                </button>
              )}
            </div>
            <p className="card__hint" style={{ marginTop: 0 }}>{t('students.locationHint')}</p>
            <LocationPicker
              lat={location.lat}
              lng={location.lng}
              center={fleet.depot}
              onChange={(lat, lng) => void saveLocation({ lat, lng })}
            />
            <div className="break-card__row" style={{ gap: 6, marginTop: 8 }}>
              <input
                className="input input--sm"
                style={{ maxWidth: 140 }}
                type="text"
                inputMode="decimal"
                placeholder={t('students.lat')}
                value={latDraft}
                onChange={(e) => {
                  const raw = e.target.value
                  setLatDraft(raw)
                  if (raw.trim() === '') return void saveLocation({ lat: null, lng: location.lng })
                  const value = Number(raw)
                  if (Number.isFinite(value)) void saveLocation({ lat: value, lng: location.lng })
                }}
              />
              <input
                className="input input--sm"
                style={{ maxWidth: 140 }}
                type="text"
                inputMode="decimal"
                placeholder={t('students.lng')}
                value={lngDraft}
                onChange={(e) => {
                  const raw = e.target.value
                  setLngDraft(raw)
                  if (raw.trim() === '') return void saveLocation({ lat: location.lat, lng: null })
                  const value = Number(raw)
                  if (Number.isFinite(value)) void saveLocation({ lat: location.lat, lng: value })
                }}
              />
            </div>
            {nearestStop && nearestStop.stop.id !== student.stopId && (
              <p className="card__hint" style={{ marginTop: 8 }}>
                {t('students.nearestStop', {
                  stop: nearestStop.stop.name,
                  distance: String(Math.round(nearestStop.distanceM)),
                })}{' '}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void assignNearestStop()}
                >
                  {t('students.useNearestStop')}
                </button>
              </p>
            )}
          </section>

          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <h3 className="card__subtitle" style={{ marginTop: 0 }}>{t('enroll.transfer')} / {t('enroll.withdraw')}</h3>
            <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <select className="input input--sm" value={toClassId} onChange={(e) => setToClassId(e.target.value)}>
                <option value="">{t('enroll.toClass')}…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <input type="date" className="input input--sm" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
              <input className="input input--sm" style={{ minWidth: 150 }} placeholder={t('enroll.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn btn--sm" disabled={busy || !toClassId} onClick={() => void doTransfer()}>
                {t('enroll.confirmTransfer')}
              </button>
            </div>
            <div className="break-card__row" style={{ gap: 6, marginTop: 8 }}>
              <select className="input input--sm" value={wStatus} onChange={(e) => setWStatus(e.target.value as 'withdrawn' | 'graduated')}>
                <option value="withdrawn">{t('enroll.status.withdrawn')}</option>
                <option value="graduated">{t('enroll.status.graduated')}</option>
              </select>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void doWithdraw()}>
                {t('enroll.withdraw')}
              </button>
            </div>
            {actionErr && <p className="login__error">{actionErr}</p>}
          </section>

          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <h3 className="card__subtitle" style={{ marginTop: 0 }}>{t('enroll.history')}</h3>
            <table className="table" style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>{t('enroll.effectiveDate')}</th>
                  <th>{t('lessons.col.cohort')}</th>
                  <th>{t('logs.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((e) => {
                  const label = classes.find((c) => c.id === e.classId)?.label ?? e.classId
                  return (
                    <tr key={e.id}>
                      <td>{e.startDate}{e.endDate ? ` → ${e.endDate}` : ` (${t('enroll.current')})`}</td>
                      <td>{label}</td>
                      <td>{e.status}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div className="page__actions" style={{ marginBottom: 8 }}>
              <h3 className="card__subtitle" style={{ margin: 0, flex: 1 }}>{t('billing.title')}</h3>
              {balance && (
                <span className={`chip${balance.outstandingBalance > 0 ? '' : ' chip--on'}`}>
                  {t('billing.balance', { amount: formatMinorUnits(balance.outstandingBalance) })}
                </span>
              )}
            </div>
            {can('finance.invoice.create') && (
              <div className="break-card__row" style={{ gap: 6, marginBottom: 8 }}>
                <select
                  className="input input--sm"
                  disabled={generating || feeStructures.length === 0}
                  defaultValue=""
                  onChange={(e) => {
                    void generateFromStructure(e.target.value)
                    e.target.value = ''
                  }}
                >
                  <option value="" disabled>
                    {feeStructures.length === 0 ? t('billing.noFeeStructures') : t('billing.generateInvoice')}
                  </option>
                  {feeStructures.map((fs) => (
                    <option key={fs.id} value={fs.id}>
                      {fs.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {invoices.length === 0 ? (
              <p className="card__hint">{t('billing.none')}</p>
            ) : (
              <table className="table" style={{ minWidth: 420 }}>
                <thead>
                  <tr>
                    <th>{t('billing.col.number')}</th>
                    <th>{t('billing.col.date')}</th>
                    <th>{t('billing.col.total')}</th>
                    <th>{t('billing.col.status')}</th>
                    <th style={{ width: 30 }} />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td className="mono">{invoice.invoiceNumber}</td>
                      <td>{invoice.issueDate}</td>
                      <td>{formatMinorUnits(invoice.total)}</td>
                      <td>{t(`billing.status.${invoice.status}` as TranslationKey)}</td>
                      <td>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => setOpenInvoiceId(invoice.id)}
                          aria-label={`${t('billing.view')} ${invoice.invoiceNumber}`}
                        >
                          ⋯
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>

      {openInvoiceId && (
        <InvoiceDetailDialog
          invoiceId={openInvoiceId}
          getAccessToken={getAccessToken}
          onClose={() => setOpenInvoiceId(null)}
          onChanged={() => void loadBilling()}
        />
      )}
    </div>
  )
}
