import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  attendanceSheet,
  createEmployee,
  createLeaveType,
  expiringContracts,
  hrSummary,
  listEmployees,
  listLeaveRequests,
  listLeaveTypes,
  saveAttendance,
  updateLeaveType,
  type AttendanceRow,
  type Contract,
  type Employee,
  type HrSummary,
  type LeaveRequest,
  type LeaveType,
  type StaffMark,
} from '../lib/hrApi'
import { useLookup } from '../lib/useLookup'
import { CONTRACT_TONE, LEAVE_TONE, hrError } from '../lib/hrUi'
import { parseMinorUnits } from '../domain/finance'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { printIdCards } from '../lib/idCards'

/**
 * HR & staff (SAMS Phase 4): staff list, leave, staff attendance and the
 * HR summary, for the active branch. The tab is in the URL (?tab=).
 */

type Tab = 'staff' | 'leave' | 'attendance' | 'reports'
const TABS: { id: Tab; label: TranslationKey; scope?: string }[] = [
  { id: 'staff', label: 'hr.tab.staff' },
  { id: 'leave', label: 'hr.tab.leave' },
  { id: 'attendance', label: 'hr.tab.attendance' },
  { id: 'reports', label: 'hr.tab.reports', scope: 'reports.hr' },
]

const today = () => new Date().toISOString().slice(0, 10)

export function HrPage() {
  const { t, lang } = useI18n()
  const { can, getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [params, setParams] = useSearchParams()
  const tabs = TABS.filter((x) => !x.scope || can(x.scope))
  const requested = params.get('tab') as Tab | null
  const tab: Tab = tabs.some((x) => x.id === requested) ? requested! : 'staff'

  return (
    <div className="page hr-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.hr')}</h1>
          <p className="page__subtitle">{t('hr.subtitle')}</p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn"
            onClick={() => void printIdCards(getAccessToken, 'employees', { branchId: activeBranchId, layout: 'sheet', lang })}
          >
            {t('idcards.printStaff')}
          </button>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={t('nav.hr')}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            className="tabs__tab"
            onClick={() =>
              setParams(
                (prev) => {
                  prev.set('tab', x.id)
                  return prev
                },
                { replace: true },
              )
            }
          >
            {t(x.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="finance-panel">
        {tab === 'staff' && <StaffTab />}
        {tab === 'leave' && <LeaveTab />}
        {tab === 'attendance' && <AttendanceTab />}
        {tab === 'reports' && <HrReportsTab />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ staff --

function StaffTab() {
  const { t, n } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const navigate = useNavigate()
  const departments = useLookup('department')
  const positions = useLookup('position')
  const contractTypes = useLookup('contractType')
  const [rows, setRows] = useState<Employee[] | null>(null)
  const [expiring, setExpiring] = useState<Contract[]>([])
  const [status, setStatus] = useState<'active' | 'terminated'>('active')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let live = true
    setRows(null)
    void listEmployees(getAccessToken, { branchId: activeBranchId ?? undefined, status }).then(
      (res) => live && setRows(res.kind === 'ok' ? res.data : []),
    )
    void expiringContracts(getAccessToken, activeBranchId ?? undefined).then((res) => live && res.kind === 'ok' && setExpiring(res.data))
    return () => {
      live = false
    }
  }, [getAccessToken, activeBranchId, status])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (rows ?? []).filter(
      (e) => !needle || [e.employeeNumber, e.fullName, e.fullNameAr ?? '', e.phone ?? ''].join(' ').toLowerCase().includes(needle),
    )
  }, [rows, search])

  return (
    <>
      {expiring.length > 0 && (
        <div className="card card--warn">
          <h2 className="card__title">{t('hr.expiring.title', { n: n(expiring.length) })}</h2>
          <ul className="plain-list">
            {expiring.slice(0, 8).map((c) => (
              <li key={c.id}>
                <Link to={`/hr/employees/${c.employeeId}`}>{c.employeeName}</Link> · {contractTypes.label(c.typeCode)} ·{' '}
                {t('hr.contract.ends', { date: c.endDate ?? '' })}{' '}
                <span className={`chip ${CONTRACT_TONE[c.status]}`}>{t(`hr.contract.status.${c.status}` as TranslationKey)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && activeBranchId && (
        <NewEmployeeCard branchId={activeBranchId} onCancel={() => setAdding(false)} onCreated={(e) => navigate(`/hr/employees/${e.id}`)} />
      )}

      <section className="card">
        <div className="card__head">
          <div className="segmented" role="group" aria-label={t('hr.col.status')}>
            {(['active', 'terminated'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                {t(`hr.status.${s}` as TranslationKey)}
              </button>
            ))}
          </div>
          <input
            className="input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder={t('hr.search')}
            aria-label={t('hr.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {can('hr.employee.update') && !adding && (
            <button type="button" className="btn btn--primary btn--sm" disabled={!activeBranchId} onClick={() => setAdding(true)}>
              + {t('hr.new')}
            </button>
          )}
        </div>
        {rows === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : shown.length === 0 ? (
          <div className="empty-state">{t('hr.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 700 }}>
              <thead>
                <tr>
                  <th>{t('hr.col.number')}</th>
                  <th>{t('hr.col.name')}</th>
                  <th>{t('hr.col.department')}</th>
                  <th>{t('hr.col.position')}</th>
                  <th>{t('hr.col.contract')}</th>
                  <th>{t('hr.col.phone')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">
                      <Link to={`/hr/employees/${e.id}`}>{e.employeeNumber}</Link>
                    </td>
                    <td>
                      <Link to={`/hr/employees/${e.id}`}>{e.fullName}</Link>
                      {e.fullNameAr && <div className="docs__meta">{e.fullNameAr}</div>}
                    </td>
                    <td>{departments.label(e.departmentCode)}</td>
                    <td>{positions.label(e.positionCode)}</td>
                    <td>
                      {e.contract ? (
                        <span className={`chip ${CONTRACT_TONE[e.contract.status]}`}>
                          {contractTypes.label(e.contract.typeCode)}
                          {e.contract.endDate && ` · ${e.contract.endDate}`}
                        </span>
                      ) : e.status === 'active' ? (
                        <span className="chip chip--bad">{t('hr.contract.none')}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="mono">{e.phone ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

function NewEmployeeCard({ branchId, onCancel, onCreated }: { branchId: string; onCancel: () => void; onCreated: (e: Employee) => void }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const departments = useLookup('department')
  const positions = useLookup('position')
  const contractTypes = useLookup('contractType')
  const [f, setF] = useState({
    givenName: '',
    familyName: '',
    fullNameAr: '',
    phone: '',
    email: '',
    hireDate: today(),
    departmentCode: '',
    positionCode: '',
    contractType: '',
    contractEnd: '',
    salary: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))

  const submit = async () => {
    if (!f.givenName.trim() || !f.familyName.trim()) return setError(t('hr.error.name'))
    const salary = f.salary.trim() ? parseMinorUnits(f.salary) : null
    if (f.salary.trim() && salary === null) return setError(t('hr.error.salary'))
    setBusy(true)
    setError(null)
    const res = await createEmployee(getAccessToken, {
      branchId,
      givenName: f.givenName.trim(),
      familyName: f.familyName.trim(),
      fullNameAr: f.fullNameAr.trim() || null,
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      hireDate: f.hireDate,
      departmentCode: f.departmentCode || null,
      positionCode: f.positionCode || null,
      ...(f.contractType ? { contract: { typeCode: f.contractType, startDate: f.hireDate, endDate: f.contractEnd || null, salary } } : {}),
    })
    setBusy(false)
    if (res.kind !== 'ok') return setError(hrError(t, res.error))
    onCreated(res.data)
  }

  return (
    <section className="card">
      <h2 className="card__title">{t('hr.new')}</h2>
      <div className="field-grid">
        <label className="field">
          <span>{t('hr.field.givenName')}</span>
          <input className="input" value={f.givenName} onChange={set('givenName')} />
        </label>
        <label className="field">
          <span>{t('hr.field.familyName')}</span>
          <input className="input" value={f.familyName} onChange={set('familyName')} />
        </label>
        <label className="field">
          <span>{t('hr.field.fullNameAr')}</span>
          <input className="input" dir="rtl" value={f.fullNameAr} onChange={set('fullNameAr')} />
        </label>
        <label className="field">
          <span>{t('hr.col.phone')}</span>
          <input className="input" value={f.phone} onChange={set('phone')} />
        </label>
        <label className="field">
          <span>{t('hr.field.email')}</span>
          <input className="input" type="email" value={f.email} onChange={set('email')} />
        </label>
        <label className="field">
          <span>{t('hr.field.hireDate')}</span>
          <input className="input" type="date" value={f.hireDate} onChange={set('hireDate')} />
        </label>
        <label className="field">
          <span>{t('hr.col.department')}</span>
          <select className="input" value={f.departmentCode} onChange={set('departmentCode')}>
            <option value="">—</option>
            {departments.active.map((d) => (
              <option key={d.code} value={d.code}>
                {departments.label(d.code)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('hr.col.position')}</span>
          <select className="input" value={f.positionCode} onChange={set('positionCode')}>
            <option value="">—</option>
            {positions.active.map((d) => (
              <option key={d.code} value={d.code}>
                {positions.label(d.code)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('hr.field.contractType')}</span>
          <select className="input" value={f.contractType} onChange={set('contractType')}>
            <option value="">{t('hr.field.noContract')}</option>
            {contractTypes.active.map((d) => (
              <option key={d.code} value={d.code}>
                {contractTypes.label(d.code)}
              </option>
            ))}
          </select>
        </label>
        {f.contractType && (
          <>
            <label className="field">
              <span>{t('hr.field.contractEnd')}</span>
              <input className="input" type="date" value={f.contractEnd} onChange={set('contractEnd')} />
            </label>
            {can('hr.salary.read') && (
              <label className="field">
                <span>{t('hr.field.salary')}</span>
                <input className="input" inputMode="decimal" value={f.salary} onChange={set('salary')} />
              </label>
            )}
          </>
        )}
      </div>
      {error && <p className="login__error">{error}</p>}
      <div className="page__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          {t('docs.cancel')}
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
          {t('hr.create')}
        </button>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ leave --

function LeaveTab() {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [status, setStatus] = useState<string>('pending')
  const [rows, setRows] = useState<LeaveRequest[] | null>(null)
  const [types, setTypes] = useState<LeaveType[]>([])

  const loadTypes = useCallback(async () => {
    const res = await listLeaveTypes(getAccessToken)
    if (res.kind === 'ok') setTypes(res.data)
  }, [getAccessToken])
  useEffect(() => {
    void loadTypes()
  }, [loadTypes])
  useEffect(() => {
    let live = true
    setRows(null)
    void listLeaveRequests(getAccessToken, { branchId: activeBranchId ?? undefined, status: status || undefined }).then(
      (res) => live && setRows(res.kind === 'ok' ? res.data : []),
    )
    return () => {
      live = false
    }
  }, [getAccessToken, activeBranchId, status])

  const typeName = (code: string) => {
    const x = types.find((y) => y.code === code)
    return x ? (lang === 'ar' && x.nameAr) || x.name : code
  }

  return (
    <div className="card-row card-row--wide-first">
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">{t('hr.leave.requests')}</h2>
          <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('hr.col.status')}>
            <option value="">{t('parents.filter.allStatuses')}</option>
            {(['pending', 'approved', 'rejected', 'cancelled'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`hr.leave.status.${s}` as TranslationKey)}
              </option>
            ))}
          </select>
        </div>
        <p className="card__hint">{t('hr.leave.hint')}</p>
        {rows === null ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : rows.length === 0 ? (
          <div className="empty-state">{t('hr.leave.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>{t('hr.col.name')}</th>
                  <th>{t('hr.leave.type')}</th>
                  <th>{t('hr.leave.dates')}</th>
                  <th>{t('hr.leave.days')}</th>
                  <th>{t('hr.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/hr/employees/${r.employeeId}?section=leave`}>{r.employeeName ?? '—'}</Link>
                      {r.reason && <div className="docs__meta">{r.reason}</div>}
                    </td>
                    <td>{typeName(r.typeCode)}</td>
                    <td className="mono">
                      {r.startDate} → {r.endDate}
                    </td>
                    <td className="mono">{r.days}</td>
                    <td>
                      <span className={`chip ${LEAVE_TONE[r.status]}`}>{t(`hr.leave.status.${r.status}` as TranslationKey)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <LeaveTypesCard types={types} canEdit={can('hr.employee.update')} onChanged={() => void loadTypes()} />
    </div>
  )
}

function LeaveTypesCard({ types, canEdit, onChanged }: { types: LeaveType[]; canEdit: boolean; onChanged: () => void }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ code: '', name: '', nameAr: '', days: '', paid: true })
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    const days = f.days.trim() === '' ? null : Number(f.days)
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(f.code) || !f.name.trim() || (days !== null && !(days >= 0)))
      return setError(t('hr.error.leaveType'))
    const res = await createLeaveType(getAccessToken, {
      code: f.code,
      name: f.name.trim(),
      nameAr: f.nameAr.trim() || null,
      daysPerYear: days,
      paid: f.paid,
    })
    if (res.kind !== 'ok') return setError(hrError(t, res.error))
    setAdding(false)
    setError(null)
    setF({ code: '', name: '', nameAr: '', days: '', paid: true })
    onChanged()
  }

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('hr.leaveTypes')}</h2>
        {canEdit && !adding && (
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            {t('hr.leaveTypes.new')}
          </button>
        )}
      </div>
      {types.map((x) => (
        <div key={x.code} className="stat-row" style={x.active ? undefined : { opacity: 0.55 }}>
          <span>
            {(lang === 'ar' && x.nameAr) || x.name}
            {!x.paid && <span className="card__hint"> · {t('hr.leaveTypes.unpaid')}</span>}
          </span>
          <span>
            <b className="mono">{x.daysPerYear === null ? '∞' : t('hr.leaveTypes.days', { n: x.daysPerYear })}</b>
            {canEdit && (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void updateLeaveType(getAccessToken, x.code, { active: !x.active }).then(onChanged)}
              >
                {x.active ? t('billing.feeStructure.deactivate') : t('fin.reactivate')}
              </button>
            )}
          </span>
        </div>
      ))}
      {adding && (
        <div className="stack-form">
          <input
            className="input input--sm"
            placeholder={t('hr.leaveTypes.code')}
            aria-label={t('hr.leaveTypes.code')}
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value })}
          />
          <input
            className="input input--sm"
            placeholder={t('fin.scholarship.name')}
            aria-label={t('fin.scholarship.name')}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <input
            className="input input--sm"
            dir="rtl"
            placeholder={t('fin.nameAr')}
            aria-label={t('fin.nameAr')}
            value={f.nameAr}
            onChange={(e) => setF({ ...f, nameAr: e.target.value })}
          />
          <input
            className="input input--sm"
            inputMode="numeric"
            placeholder={t('hr.leaveTypes.perYear')}
            aria-label={t('hr.leaveTypes.perYear')}
            value={f.days}
            onChange={(e) => setF({ ...f, days: e.target.value })}
          />
          <label className="checkbox-inline">
            <input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} />
            {t('hr.leaveTypes.paid')}
          </label>
          <div className="page__actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              {t('docs.cancel')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
              {t('fin.add')}
            </button>
          </div>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
    </section>
  )
}

// ------------------------------------------------------------- attendance --

const MARKS: StaffMark[] = ['present', 'late', 'absent', 'excused', 'leave']
const MARK_TONE: Record<StaffMark, string> = {
  present: 'chip--ok',
  late: 'chip--warn',
  absent: 'chip--bad',
  excused: '',
  leave: 'chip--on',
}

function AttendanceTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const positions = useLookup('position')
  const [date, setDate] = useState(today())
  const [sheet, setSheet] = useState<{ sessionDay: boolean; rows: AttendanceRow[] } | null>(null)
  const [draft, setDraft] = useState<Record<string, Partial<AttendanceRow>>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const canWrite = can('hr.attendance.write')

  const load = useCallback(async () => {
    if (!activeBranchId) return
    setSheet(null)
    setDraft({})
    const res = await attendanceSheet(getAccessToken, activeBranchId, date)
    if (res.kind === 'ok') setSheet(res.data)
  }, [getAccessToken, activeBranchId, date])
  useEffect(() => {
    void load()
  }, [load])

  const row = (r: AttendanceRow) => ({ ...r, ...draft[r.employeeId] })
  const edit = (id: string, patch: Partial<AttendanceRow>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  const markAll = () =>
    sheet &&
    setDraft(
      Object.fromEntries(
        sheet.rows.filter((r) => !row(r).status).map((r) => [r.employeeId, { ...draft[r.employeeId], status: 'present' as StaffMark }]),
      ),
    )

  const save = async () => {
    if (!sheet || !activeBranchId) return
    const records = sheet.rows
      .map(row)
      .filter((r) => draft[r.employeeId] && r.status)
      .map((r) => ({
        employeeId: r.employeeId,
        status: r.status!,
        checkIn: r.checkIn || null,
        checkOut: r.checkOut || null,
        note: r.note || null,
      }))
    if (records.length === 0) return
    const res = await saveAttendance(getAccessToken, { branchId: activeBranchId, date, records })
    setMsg(res.kind === 'ok' ? t('hr.attendance.saved', { n: res.data.saved }) : hrError(t, res.error))
    if (res.kind === 'ok') await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <input
          type="date"
          className="input input--sm"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t('billing.col.date')}
        />
        {sheet && !sheet.sessionDay && <span className="chip chip--warn">{t('hr.attendance.noSession')}</span>}
        <span style={{ flex: 1 }} />
        {canWrite && sheet && sheet.rows.length > 0 && (
          <>
            <button type="button" className="btn btn--sm btn--ghost" onClick={markAll}>
              {t('hr.attendance.allPresent')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={Object.keys(draft).length === 0}
              onClick={() => void save()}
            >
              {t('hr.attendance.save')}
            </button>
          </>
        )}
      </div>
      {msg && <p className="card__hint">{msg}</p>}
      {sheet === null ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : sheet.rows.length === 0 ? (
        <div className="empty-state">{t('hr.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>{t('hr.col.name')}</th>
                <th>{t('hr.col.status')}</th>
                <th>{t('hr.attendance.in')}</th>
                <th>{t('hr.attendance.out')}</th>
                <th>{t('hr.attendance.note')}</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((raw) => {
                const r = row(raw)
                return (
                  <tr key={r.employeeId}>
                    <td>
                      <Link to={`/hr/employees/${r.employeeId}`}>{r.name}</Link>
                      <div className="docs__meta">{positions.label(r.positionCode)}</div>
                    </td>
                    <td>
                      {canWrite ? (
                        <div className="mark-group" role="group" aria-label={r.name}>
                          {MARKS.map((m) => (
                            <button
                              key={m}
                              type="button"
                              className={`chip ${r.status === m ? MARK_TONE[m] + ' chip--selected' : ''}`}
                              aria-pressed={r.status === m}
                              onClick={() => edit(r.employeeId, { status: m })}
                            >
                              {t(`hr.mark.${m}` as TranslationKey)}
                            </button>
                          ))}
                        </div>
                      ) : r.status ? (
                        <span className={`chip ${MARK_TONE[r.status]}`}>{t(`hr.mark.${r.status}` as TranslationKey)}</span>
                      ) : (
                        '—'
                      )}
                      {!r.recorded && r.leaveTypeCode && <div className="docs__meta">{t('hr.attendance.onLeave')}</div>}
                    </td>
                    <td>
                      <input
                        className="input input--sm"
                        type="time"
                        disabled={!canWrite}
                        value={r.checkIn ?? ''}
                        onChange={(e) => edit(r.employeeId, { checkIn: e.target.value })}
                        aria-label={t('hr.attendance.in')}
                      />
                    </td>
                    <td>
                      <input
                        className="input input--sm"
                        type="time"
                        disabled={!canWrite}
                        value={r.checkOut ?? ''}
                        onChange={(e) => edit(r.employeeId, { checkOut: e.target.value })}
                        aria-label={t('hr.attendance.out')}
                      />
                    </td>
                    <td>
                      <input
                        className="input input--sm"
                        disabled={!canWrite}
                        value={r.note ?? ''}
                        onChange={(e) => edit(r.employeeId, { note: e.target.value })}
                        aria-label={t('hr.attendance.note')}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- reports --

function HrReportsTab() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId, branches } = useApp()
  const departments = useLookup('department')
  const positions = useLookup('position')
  const contractTypes = useLookup('contractType')
  const docCategories = useLookup('documentCategory')
  const year = new Date().getUTCFullYear()
  const [from, setFrom] = useState(`${year}-01-01`)
  const [to, setTo] = useState(today())
  const [data, setData] = useState<HrSummary | null>(null)

  useEffect(() => {
    if (from > to) return
    let live = true
    setData(null)
    void hrSummary(getAccessToken, { branchId: activeBranchId ?? undefined, from, to }).then(
      (res) => live && res.kind === 'ok' && setData(res.data),
    )
    return () => {
      live = false
    }
  }, [getAccessToken, activeBranchId, from, to])

  const tile = (label: TranslationKey, value: number | undefined, tone = 'neutral') => (
    <div className={`stat-tile stat-tile--${tone} stat-tile--plain`}>
      <span className="stat-tile__label">{t(label)}</span>
      <b className="stat-tile__value">{value === undefined ? <span className="skeleton" /> : value}</b>
    </div>
  )
  const list = (title: TranslationKey, rows: { key: string; count: number }[], label: (k: string) => string) => (
    <section className="card">
      <h2 className="card__title">{t(title)}</h2>
      {rows.length === 0 && <p className="card__empty">—</p>}
      {rows.map((r) => (
        <div key={r.key} className="stat-row">
          <span>{r.key === 'none' ? '—' : label(r.key)}</span>
          <b className="mono">{r.count}</b>
        </div>
      ))}
    </section>
  )

  return (
    <div className="report">
      <div className="panel">
        <div className="inline-form">
          <label className="field field--inline">
            <span>{t('fin.report.from')}</span>
            <input type="date" className="input input--sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field field--inline">
            <span>{t('fin.report.to')}</span>
            <input type="date" className="input input--sm" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="tile-grid">
        {tile('hr.report.active', data?.headcount.active, 'ok')}
        {tile('hr.report.hires', data?.movement.hires)}
        {tile('hr.report.terminations', data?.movement.terminations)}
        {tile('hr.report.expiring', data?.contracts.expiring.length, (data?.contracts.expiring.length ?? 0) > 0 ? 'warn' : 'ok')}
        {tile(
          'hr.report.noContract',
          data?.contracts.withoutContract.length,
          (data?.contracts.withoutContract.length ?? 0) > 0 ? 'bad' : 'ok',
        )}
        {tile('hr.report.pendingLeave', data?.leave.pendingRequests)}
      </div>
      {data && (
        <>
          <div className="card-row">
            {list('hr.col.department', data.headcount.byDepartment, departments.label)}
            {list('hr.col.position', data.headcount.byPosition, positions.label)}
            {list('hr.report.byBranch', data.headcount.byBranch, (id) => branches.find((b) => b.id === id)?.name ?? id)}
          </div>
          <div className="card-row">
            <section className="card">
              <h2 className="card__title">{t('hr.report.contracts')}</h2>
              {data.contracts.expiring.length === 0 && data.contracts.withoutContract.length === 0 && <p className="card__empty">—</p>}
              {data.contracts.expiring.map((c) => (
                <div key={c.employeeId + c.endDate} className="stat-row">
                  <Link to={`/hr/employees/${c.employeeId}`}>{c.name}</Link>
                  <span>
                    {contractTypes.label(c.typeCode)} · <span className="mono">{c.endDate}</span>
                  </span>
                </div>
              ))}
              {data.contracts.withoutContract.map((c) => (
                <div key={c.employeeId} className="stat-row">
                  <Link to={`/hr/employees/${c.employeeId}`}>{c.name}</Link>
                  <span className="chip chip--bad">{t('hr.contract.none')}</span>
                </div>
              ))}
            </section>
            <section className="card">
              <h2 className="card__title">{t('hr.report.documents')}</h2>
              {data.documents.length === 0 && <p className="card__empty">—</p>}
              {data.documents.map((d) => (
                <div key={d.documentId} className="stat-row">
                  <Link to={`/hr/employees/${d.employeeId}?section=documents`}>{d.name}</Link>
                  <span>
                    {docCategories.label(d.categoryCode)} ·{' '}
                    <span className={`chip ${d.expired ? 'chip--bad' : 'chip--warn'}`}>{d.expiresAt}</span>
                  </span>
                </div>
              ))}
            </section>
            <section className="card">
              <h2 className="card__title">{t('hr.report.leaveAndAttendance')}</h2>
              {data.leave.byType.map((l) => (
                <div key={l.typeCode} className="stat-row">
                  <span>{l.typeCode}</span>
                  <b className="mono">{t('hr.leaveTypes.days', { n: l.days })}</b>
                </div>
              ))}
              {data.attendance.byStatus.map((a) => (
                <div key={a.key} className="stat-row">
                  <span>{t(`hr.mark.${a.key}` as TranslationKey)}</span>
                  <b className="mono">{a.count}</b>
                </div>
              ))}
              {data.attendance.mostAbsent.length > 0 && <h3 className="card__subtitle">{t('hr.report.mostAbsent')}</h3>}
              {data.attendance.mostAbsent.map((a) => (
                <div key={a.employeeId} className="stat-row">
                  <Link to={`/hr/employees/${a.employeeId}`}>{a.name}</Link>
                  <b className="mono">{a.days}</b>
                </div>
              ))}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
