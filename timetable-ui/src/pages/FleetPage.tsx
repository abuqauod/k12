import { useCallback, useEffect, useState } from 'react'
import {
  billTransport,
  compliance,
  createDriver,
  listDrivers,
  listFleet,
  saveBusDetails,
  setTransportFees,
  transportFees,
  updateDriver,
  type ComplianceItem,
  type Driver,
  type FleetBus,
} from '../lib/opsApi'
import { opsError } from '../lib/opsUi'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { DocumentsPanel } from '../components/DocumentsPanel'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/**
 * Transport administration (SAMS 5.4) for the active branch: what needs
 * renewing, each bus's paperwork, drivers, and transport fees. Routes and
 * stops stay on the Bus routes page.
 */
export function FleetPage() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [buses, setBuses] = useState<FleetBus[] | null>(null)
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [items, setItems] = useState<ComplianceItem[]>([])
  const [missing, setMissing] = useState<{ busId: string; name: string }[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const canManage = can('transport.manage')

  const load = useCallback(async () => {
    const branchId = activeBranchId ?? undefined
    const [b, d, c] = await Promise.all([
      listFleet(getAccessToken, branchId),
      listDrivers(getAccessToken, branchId),
      compliance(getAccessToken, branchId),
    ])
    setBuses(b.kind === 'ok' ? b.data : [])
    if (d.kind === 'ok') setDrivers(d.data)
    if (c.kind === 'ok') {
      setItems(c.data.items)
      setMissing(c.data.busesWithoutDetails)
    }
  }, [getAccessToken, activeBranchId])
  useEffect(() => {
    void load()
  }, [load])

  const kindLabel = (kind: string) => (kind.startsWith('document:') ? t('veh.kind.document') : t(`veh.kind.${kind}` as TranslationKey))

  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.fleet')}</h1>
          <p className="page__subtitle">{t('veh.subtitle')}</p>
        </div>
      </header>
      {msg && <p className={msg.ok ? 'card__hint' : 'login__error'}>{msg.text}</p>}

      <section className={`card${items.some((i) => i.expired) ? ' card--warn' : ''}`}>
        <h2 className="card__title">{t('veh.compliance')}</h2>
        {items.length === 0 && missing.length === 0 && <p className="card__empty">{t('veh.allGood')}</p>}
        {items.map((i, n) => (
          <div key={n} className="stat-row">
            <span>
              <b>{i.name}</b> · {kindLabel(i.kind)}
            </span>
            <span className={`chip ${i.expired ? 'chip--bad' : 'chip--warn'}`}>
              {t(i.expired ? 'veh.expired' : 'veh.expires', { date: i.expiresAt })}
            </span>
          </div>
        ))}
        {missing.map((m) => (
          <div key={m.busId} className="stat-row">
            <b>{m.name}</b>
            <span className="chip">{t('veh.noDetails')}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="card__title">{t('veh.buses')}</h2>
        {buses === null ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : buses.length === 0 ? (
          <div className="empty-state">{t('veh.noBuses')}</div>
        ) : (
          <ul className="record-list">
            {buses.map((b) => (
              <li key={b.id} className="record-list__item">
                <div className="record-list__row">
                  <button
                    type="button"
                    className="record-list__main"
                    onClick={() => setOpenId(openId === b.id ? null : b.id)}
                    aria-expanded={openId === b.id}
                  >
                    <b>{b.name}</b>
                    <span className="card__hint">
                      {' '}
                      —{' '}
                      {[b.plateNumber, t('veh.seats', { n: b.seats }), b.drivers.map((d) => d.name).join(', ')].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </div>
                {openId === b.id && (
                  <BusDetails
                    bus={b}
                    canManage={canManage}
                    onSaved={() => void load().then(() => setMsg({ ok: true, text: t('hr.saved') }))}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DriversCard drivers={drivers} buses={buses ?? []} canManage={canManage} onChanged={() => void load()} />
      <FeesCard canManage={canManage} />
    </div>
  )
}

function BusDetails({ bus, canManage, onSaved }: { bus: FleetBus; canManage: boolean; onSaved: () => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [f, setF] = useState({
    plateNumber: bus.plateNumber ?? '',
    registrationExpiry: bus.registrationExpiry ?? '',
    insuranceExpiry: bus.insuranceExpiry ?? '',
    inspectionExpiry: bus.inspectionExpiry ?? '',
    attendantName: bus.attendantName ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]))
    const res = await saveBusDetails(getAccessToken, bus.id, body)
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    onSaved()
  }
  const field = (k: keyof typeof f, type = 'text') => (
    <label className="field">
      <span>{t(`veh.field.${k}` as TranslationKey)}</span>
      <input className="input" type={type} disabled={!canManage} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  )
  return (
    <div className="record-detail">
      <div className="field-grid">
        {field('plateNumber')}
        {field('registrationExpiry', 'date')}
        {field('insuranceExpiry', 'date')}
        {field('inspectionExpiry', 'date')}
        {field('attendantName')}
      </div>
      {canManage && (
        <div className="page__actions">
          {error && <span className="login__error">{error}</span>}
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()}>
            {t('hr.save')}
          </button>
        </div>
      )}
      <DocumentsPanel ownerType="bus" ownerId={bus.id} />
    </div>
  )
}

function DriversCard({
  drivers,
  buses,
  canManage,
  onChanged,
}: {
  drivers: Driver[]
  buses: FleetBus[]
  canManage: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [f, setF] = useState({ name: '', phone: '', licenseNumber: '', licenseExpiry: '', busId: '' })
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    if (!activeBranchId || !f.name.trim()) return
    const res = await createDriver(getAccessToken, {
      branchId: activeBranchId,
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      licenseNumber: f.licenseNumber.trim() || null,
      licenseExpiry: f.licenseExpiry || null,
      busId: f.busId || null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setError(null)
    setF({ name: '', phone: '', licenseNumber: '', licenseExpiry: '', busId: '' })
    onChanged()
  }
  return (
    <section className="card">
      <h2 className="card__title">{t('veh.drivers')}</h2>
      {drivers.length === 0 && <p className="card__empty">{t('veh.noDrivers')}</p>}
      <ul className="record-list">
        {drivers.map((d) => (
          <li key={d.id} className="record-list__item" style={d.active ? undefined : { opacity: 0.55 }}>
            <div className="record-list__row">
              <button
                type="button"
                className="record-list__main"
                onClick={() => setOpenId(openId === d.id ? null : d.id)}
                aria-expanded={openId === d.id}
              >
                <b>{d.name}</b>
                <span className="card__hint">
                  {' '}
                  —{' '}
                  {[d.phone, d.licenseNumber, d.licenseExpiry && t('veh.licenceUntil', { date: d.licenseExpiry })]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
              {canManage ? (
                <select
                  className="input input--sm"
                  value={d.busId ?? ''}
                  aria-label={t('veh.bus')}
                  onChange={(e) => void updateDriver(getAccessToken, d.id, { busId: e.target.value || null }).then(onChanged)}
                >
                  <option value="">{t('veh.noBus')}</option>
                  {buses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="chip">{buses.find((b) => b.id === d.busId)?.name ?? t('veh.noBus')}</span>
              )}
            </div>
            {openId === d.id && <DocumentsPanel ownerType="driver" ownerId={d.id} />}
          </li>
        ))}
      </ul>
      {canManage && activeBranchId && (
        <div className="inline-form">
          <input
            className="input input--sm"
            placeholder={t('ops.col.name')}
            aria-label={t('ops.col.name')}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <input
            className="input input--sm"
            style={{ maxWidth: 130 }}
            placeholder={t('hr.col.phone')}
            aria-label={t('hr.col.phone')}
            value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })}
          />
          <input
            className="input input--sm"
            style={{ maxWidth: 130 }}
            placeholder={t('veh.licence')}
            aria-label={t('veh.licence')}
            value={f.licenseNumber}
            onChange={(e) => setF({ ...f, licenseNumber: e.target.value })}
          />
          <label className="field field--inline">
            <span>{t('veh.licenceExpiry')}</span>
            <input
              className="input input--sm"
              type="date"
              value={f.licenseExpiry}
              onChange={(e) => setF({ ...f, licenseExpiry: e.target.value })}
            />
          </label>
          <select
            className="input input--sm"
            value={f.busId}
            onChange={(e) => setF({ ...f, busId: e.target.value })}
            aria-label={t('veh.bus')}
          >
            <option value="">{t('veh.noBus')}</option>
            {buses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
            {t('veh.addDriver')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}

function FeesCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [years, setYears] = useState<AcademicYear[]>([])
  const [yearId, setYearId] = useState('')
  const [twoWay, setTwoWay] = useState('')
  const [oneWay, setOneWay] = useState('')
  const [riders, setRiders] = useState<{ twoWay: number; oneWay: number } | null>(null)
  const [hasFee, setHasFee] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((r) => {
      if (r.kind !== 'ok') return
      setYears(r.data)
      setYearId((cur) => cur || r.data.find((y) => y.current)?.id || r.data[0]?.id || '')
    })
  }, [getAccessToken])
  const load = useCallback(async () => {
    if (!activeBranchId || !yearId) return
    const res = await transportFees(getAccessToken, activeBranchId, yearId)
    if (res.kind !== 'ok') return
    setRiders(res.data.riders)
    setHasFee(!!res.data.fee)
    setTwoWay(res.data.fee ? formatMinorUnits(res.data.fee.twoWay) : '')
    setOneWay(res.data.fee ? formatMinorUnits(res.data.fee.oneWay) : '')
  }, [getAccessToken, activeBranchId, yearId])
  useEffect(() => {
    void load()
  }, [load])

  if (!activeBranchId) return null
  const save = async () => {
    const res = await setTransportFees(getAccessToken, {
      branchId: activeBranchId,
      academicYearId: yearId,
      twoWay: parseMinorUnits(twoWay) ?? 0,
      oneWay: parseMinorUnits(oneWay) ?? 0,
    })
    setMsg(res.kind === 'ok' ? { ok: true, text: t('hr.saved') } : { ok: false, text: opsError(t, res.error) })
    await load()
  }
  const bill = async () => {
    const res = await billTransport(getAccessToken, { branchId: activeBranchId, academicYearId: yearId })
    setMsg(
      res.kind === 'ok'
        ? { ok: true, text: t('veh.billed', { n: res.data.charged, already: res.data.alreadyCharged, missing: res.data.noInvoice.length }) }
        : { ok: false, text: opsError(t, res.error) },
    )
  }
  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('veh.fees')}</h2>
        <select className="input input--sm" value={yearId} onChange={(e) => setYearId(e.target.value)} aria-label={t('hr.leave.year')}>
          {years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
            </option>
          ))}
        </select>
      </div>
      {riders && <p className="card__hint">{t('veh.riders', { two: riders.twoWay, one: riders.oneWay })}</p>}
      <div className="inline-form">
        <label className="field field--inline">
          <span>{t('veh.twoWay')}</span>
          <input
            className="input input--sm"
            style={{ maxWidth: 110 }}
            inputMode="decimal"
            disabled={!canManage}
            value={twoWay}
            onChange={(e) => setTwoWay(e.target.value)}
          />
        </label>
        <label className="field field--inline">
          <span>{t('veh.oneWay')}</span>
          <input
            className="input input--sm"
            style={{ maxWidth: 110 }}
            inputMode="decimal"
            disabled={!canManage}
            value={oneWay}
            onChange={(e) => setOneWay(e.target.value)}
          />
        </label>
        {canManage && (
          <button type="button" className="btn btn--sm" onClick={() => void save()}>
            {t('hr.save')}
          </button>
        )}
        {canManage && hasFee && can('finance.invoice.lineItems') && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void bill()}>
            {t('veh.bill')}
          </button>
        )}
      </div>
      <p className="card__hint">{t('veh.billHint')}</p>
      {msg && <p className={msg.ok ? 'card__hint' : 'login__error'}>{msg.text}</p>}
    </section>
  )
}
