import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  addContract,
  adjustLeave,
  cancelLeave,
  employeeAttendance,
  employeeContracts,
  employeeHistory,
  employeeLeave,
  endContract,
  getEmployee,
  linkUser,
  rehireEmployee,
  renewContract,
  requestLeave,
  terminateEmployee,
  updateEmployee,
  type Contract,
  type Employee,
  type EmploymentEvent,
  type LeaveOverview,
} from '../lib/hrApi'
import { listMembers, type Member } from '../lib/memberships'
import { useLookup } from '../lib/useLookup'
import { CONTRACT_TONE, LEAVE_TONE, hrError } from '../lib/hrUi'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { DocumentsPanel } from '../components/DocumentsPanel'
import { ReasonDialog } from '../components/ReasonDialog'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { printIdCards } from '../lib/idCards'

/**
 * One employee (SAMS Phase 4): details, employment (contracts and
 * history), leave, attendance and documents. The section is in the URL.
 */

type Section = 'details' | 'employment' | 'leave' | 'attendance' | 'documents'
const SECTIONS: Section[] = ['details', 'employment', 'leave', 'attendance', 'documents']
const today = () => new Date().toISOString().slice(0, 10)

export function EmployeePage() {
  const { id = '' } = useParams()
  const { t, lang } = useI18n()
  const { getAccessToken, can, hasModule } = useAuth()
  const { branches } = useApp()
  const departments = useLookup('department')
  const positions = useLookup('position')
  const [params, setParams] = useSearchParams()
  const section = (SECTIONS.includes(params.get('section') as Section) ? params.get('section') : 'details') as Section
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<'terminate' | null>(null)
  const [termDate, setTermDate] = useState(today())
  const canEdit = can('hr.employee.update')

  const load = useCallback(async () => {
    const res = await getEmployee(getAccessToken, id)
    if (res.kind === 'ok') setEmployee(res.data)
    else setError(hrError(t, res.error))
  }, [getAccessToken, id, t])
  useEffect(() => {
    void load()
  }, [load])

  if (error && !employee)
    return (
      <div className="page">
        <div className="empty-state">{error}</div>
      </div>
    )
  if (!employee)
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    )

  const initials = `${employee.givenName[0] ?? ''}${employee.familyName[0] ?? ''}`
  return (
    <div className="page student-page hr-page">
      <Link to="/hr" className="card__link student-page__back">
        ← {t('hr.back')}
      </Link>
      <header className="student-head">
        <div className="student-head__photo" aria-hidden="true">
          {initials}
        </div>
        <div className="student-head__main">
          <h1 className="page__title">{employee.fullName}</h1>
          <div className="docs__chips">
            <span className="chip mono">{employee.employeeNumber}</span>
            <span className="chip">{positions.label(employee.positionCode)}</span>
            <span className="chip">{departments.label(employee.departmentCode)}</span>
            <span className="chip">{branches.find((b) => b.id === employee.branchId)?.name ?? '—'}</span>
            <span className={`chip ${employee.status === 'active' ? 'chip--ok' : 'chip--bad'}`}>
              {t(`hr.status.${employee.status}` as TranslationKey)}
            </span>
          </div>
        </div>
        {hasModule('idCards') && (
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginInlineStart: 'auto' }}
            onClick={() => void printIdCards(getAccessToken, 'employees', { ids: [employee.id], layout: 'card', lang })}
          >
            {t('idcards.one')}
          </button>
        )}
        {canEdit && (
          <div className="page__actions">
            {employee.status === 'active' ? (
              <>
                <input
                  type="date"
                  className="input input--sm"
                  value={termDate}
                  onChange={(e) => setTermDate(e.target.value)}
                  aria-label={t('hr.terminate.date')}
                />
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAsking('terminate')}>
                  {t('hr.terminate')}
                </button>
              </>
            ) : (
              <>
                <input
                  type="date"
                  className="input input--sm"
                  value={termDate}
                  onChange={(e) => setTermDate(e.target.value)}
                  aria-label={t('hr.rehire')}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() =>
                    void rehireEmployee(getAccessToken, id, termDate).then((r) =>
                      r.kind === 'ok' ? setEmployee(r.data) : setError(hrError(t, r.error)),
                    )
                  }
                >
                  {t('hr.rehire')}
                </button>
              </>
            )}
          </div>
        )}
      </header>
      {employee.status === 'terminated' && (
        <p className="card__hint">
          {t('hr.terminatedOn', { date: employee.terminationDate ?? '', reason: employee.terminationReason ?? '' })}
        </p>
      )}
      {error && <p className="login__error">{error}</p>}

      <div className="tabs" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            className="tabs__tab"
            onClick={() =>
              setParams(
                (p) => {
                  p.set('section', s)
                  return p
                },
                { replace: true },
              )
            }
          >
            {t(`hr.section.${s}` as TranslationKey)}
          </button>
        ))}
      </div>

      {section === 'details' && <DetailsSection employee={employee} canEdit={canEdit} onSaved={setEmployee} />}
      {section === 'employment' && <EmploymentSection employee={employee} canEdit={canEdit} />}
      {section === 'leave' && <LeaveSection employee={employee} canEdit={canEdit} />}
      {section === 'attendance' && <AttendanceSection employee={employee} />}
      {section === 'documents' && <DocumentsPanel ownerType="employee" ownerId={employee.id} />}

      {asking === 'terminate' && (
        <ReasonDialog
          title={t('hr.terminate')}
          confirmLabel={t('hr.terminate')}
          onClose={() => setAsking(null)}
          onConfirm={async (reason) => {
            const res = await terminateEmployee(getAccessToken, id, termDate, reason)
            if (res.kind !== 'ok') return hrError(t, res.error)
            setEmployee(res.data)
            setAsking(null)
            return null
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- details --

const TEXT_FIELDS = [
  'givenName',
  'familyName',
  'fullNameAr',
  'phone',
  'email',
  'nationality',
  'nationalId',
  'address',
  'emergencyContactName',
  'emergencyContactPhone',
  'notes',
] as const

function DetailsSection({ employee, canEdit, onSaved }: { employee: Employee; canEdit: boolean; onSaved: (e: Employee) => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { branches } = useApp()
  const departments = useLookup('department')
  const positions = useLookup('position')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [effective, setEffective] = useState(today())
  const [msg, setMsg] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])

  useEffect(() => {
    if (!canEdit) return
    void listMembers(getAccessToken).then((r) => r.kind === 'ok' && setMembers(r.data))
  }, [getAccessToken, canEdit])

  const value = (k: string) => (k in draft ? draft[k] : ((employee as unknown as Record<string, string | null>)[k] ?? ''))
  const set = (k: string) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const dirty = Object.keys(draft).length > 0
  const movesJob = ['branchId', 'departmentCode', 'positionCode'].some((k) => k in draft)

  const save = async () => {
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(draft))
      patch[k] = v.trim() === '' && !['givenName', 'familyName', 'branchId'].includes(k) ? null : v.trim()
    if (movesJob) patch.effectiveDate = effective
    const res = await updateEmployee(getAccessToken, employee.id, patch)
    if (res.kind !== 'ok') return setMsg(hrError(t, res.error))
    setDraft({})
    setMsg(t('hr.saved'))
    onSaved(res.data)
  }

  const input = (k: string, type = 'text') => (
    <label className="field" key={k}>
      <span>{t(`hr.field.${k}` as TranslationKey)}</span>
      <input
        className="input"
        type={type}
        disabled={!canEdit}
        dir={k === 'fullNameAr' ? 'rtl' : undefined}
        value={value(k)}
        onChange={set(k)}
      />
    </label>
  )

  return (
    <div className="profile-grid">
      <section className="card profile-card">
        <h2 className="card__title">{t('hr.section.details')}</h2>
        <div className="field-grid">
          {TEXT_FIELDS.slice(0, 5).map((k) => input(k, k === 'email' ? 'email' : 'text'))}
          <label className="field">
            <span>{t('hr.field.gender')}</span>
            <select className="input" disabled={!canEdit} value={value('gender')} onChange={set('gender')}>
              <option value="">—</option>
              <option value="male">{t('hr.gender.male')}</option>
              <option value="female">{t('hr.gender.female')}</option>
            </select>
          </label>
          {input('dob', 'date')}
          {TEXT_FIELDS.slice(5).map((k) => input(k))}
        </div>
      </section>
      <section className="card profile-card">
        <h2 className="card__title">{t('hr.section.job')}</h2>
        <div className="field-grid">
          <label className="field">
            <span>{t('nav.branch')}</span>
            <select className="input" disabled={!canEdit} value={value('branchId')} onChange={set('branchId')}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('hr.col.department')}</span>
            <select className="input" disabled={!canEdit} value={value('departmentCode')} onChange={set('departmentCode')}>
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
            <select className="input" disabled={!canEdit} value={value('positionCode')} onChange={set('positionCode')}>
              <option value="">—</option>
              {positions.active.map((d) => (
                <option key={d.code} value={d.code}>
                  {positions.label(d.code)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('hr.field.hireDate')}</span>
            <input className="input" disabled value={employee.hireDate} />
          </label>
          {movesJob && (
            <label className="field">
              <span>{t('hr.field.effectiveDate')}</span>
              <input className="input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
            </label>
          )}
        </div>
        <h3 className="card__subtitle">{t('hr.login')}</h3>
        <p className="card__hint">
          {employee.linkedUser ? t('hr.login.linked', { email: employee.linkedUser.email }) : t('hr.login.none')}
        </p>
        {canEdit && (
          <select
            className="input input--sm"
            value={employee.userId ?? ''}
            aria-label={t('hr.login')}
            onChange={(e) =>
              void linkUser(getAccessToken, employee.id, e.target.value || null).then(async (r) => {
                if (r.kind !== 'ok') return setMsg(hrError(t, r.error))
                const fresh = await getEmployee(getAccessToken, employee.id)
                if (fresh.kind === 'ok') onSaved(fresh.data)
              })
            }
          >
            <option value="">{t('hr.login.unlinked')}</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName || m.email}
              </option>
            ))}
          </select>
        )}
      </section>
      {canEdit && (
        <div className={`profile-save${dirty ? ' profile-save--dirty' : ''} profile-card--full`}>
          {msg && <span className="card__hint">{msg}</span>}
          {dirty && (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => setDraft({})}>
                {t('docs.cancel')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void save()}>
                {t('hr.save')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------- employment --

function EmploymentSection({ employee, canEdit }: { employee: Employee; canEdit: boolean }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const contractTypes = useLookup('contractType')
  const departments = useLookup('department')
  const positions = useLookup('position')
  const { branches } = useApp()
  const [contracts, setContracts] = useState<Contract[] | null>(null)
  const [events, setEvents] = useState<EmploymentEvent[]>([])
  const [form, setForm] = useState<{ mode: 'new' | 'renew'; contract?: Contract } | null>(null)
  const [f, setF] = useState({ typeCode: '', startDate: today(), endDate: '', salary: '' })
  const [msg, setMsg] = useState<string | null>(null)
  const salaryOk = can('hr.salary.read')

  const load = useCallback(async () => {
    const [c, h] = await Promise.all([employeeContracts(getAccessToken, employee.id), employeeHistory(getAccessToken, employee.id)])
    if (c.kind === 'ok') setContracts(c.data)
    if (h.kind === 'ok') setEvents(h.data)
  }, [getAccessToken, employee.id])
  useEffect(() => {
    void load()
  }, [load, employee.status])

  const submit = async () => {
    const salary = f.salary.trim() ? parseMinorUnits(f.salary) : null
    const res =
      form?.mode === 'renew' && form.contract
        ? await renewContract(getAccessToken, form.contract.id, {
            endDate: f.endDate || null,
            ...(f.typeCode ? { typeCode: f.typeCode } : {}),
            ...(salaryOk && f.salary.trim() ? { salary } : {}),
          })
        : await addContract(getAccessToken, employee.id, {
            typeCode: f.typeCode || contractTypes.active[0]?.code || '',
            startDate: f.startDate,
            endDate: f.endDate || null,
            salary: salaryOk ? salary : null,
          })
    if (res.kind !== 'ok') return setMsg(hrError(t, res.error))
    setForm(null)
    setMsg(null)
    await load()
  }

  const eventLabel = (e: EmploymentEvent) => {
    const code = (v: string | null) =>
      e.type === 'department_change'
        ? departments.label(v)
        : e.type === 'position_change' || e.type === 'hire'
          ? positions.label(v)
          : e.type === 'branch_change'
            ? (branches.find((b) => b.id === v)?.name ?? v ?? '—')
            : e.type.startsWith('contract')
              ? contractTypes.label(v)
              : (v ?? '')
    return [e.from ? code(e.from) : null, e.to ? code(e.to) : null].filter(Boolean).join(' → ')
  }

  return (
    <div className="profile-grid">
      <section className="card profile-card profile-card--full">
        <div className="card__head">
          <h2 className="card__title">{t('hr.contracts')}</h2>
          {canEdit && employee.status === 'active' && !form && (
            <button type="button" className="btn btn--sm" onClick={() => setForm({ mode: 'new' })}>
              {t('hr.contract.new')}
            </button>
          )}
        </div>
        {contracts === null ? (
          <div className="skeleton" style={{ height: 60 }} />
        ) : contracts.length === 0 ? (
          <div className="empty-state">{t('hr.contract.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>{t('hr.field.contractType')}</th>
                  <th>{t('hr.contract.period')}</th>
                  <th>{t('hr.field.salary')}</th>
                  <th>{t('hr.col.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td>{contractTypes.label(c.typeCode)}</td>
                    <td className="mono">
                      {c.startDate} → {c.endDate ?? t('hr.contract.openEnded')}
                    </td>
                    <td className="mono">{c.salary !== null ? formatMinorUnits(c.salary) : c.salaryHidden ? '•••' : '—'}</td>
                    <td>
                      <span className={`chip ${CONTRACT_TONE[c.status]}`}>{t(`hr.contract.status.${c.status}` as TranslationKey)}</span>
                    </td>
                    <td>
                      {canEdit && !['renewed', 'terminated', 'ended'].includes(c.status) && (
                        <div className="row-actions">
                          {c.endDate && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => (
                                setForm({ mode: 'renew', contract: c }),
                                setF({ typeCode: '', startDate: '', endDate: '', salary: '' })
                              )}
                            >
                              {t('hr.contract.renew')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost"
                            onClick={() =>
                              void endContract(getAccessToken, c.id, today()).then((r) =>
                                r.kind === 'ok' ? load() : setMsg(hrError(t, r.error)),
                              )
                            }
                          >
                            {t('hr.contract.endToday')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {form && (
          <div className="inline-form">
            {form.mode === 'renew' && <strong>{t('hr.contract.renewFrom', { date: form.contract?.endDate ?? '' })}</strong>}
            <select
              className="input input--sm"
              value={f.typeCode}
              onChange={(e) => setF({ ...f, typeCode: e.target.value })}
              aria-label={t('hr.field.contractType')}
            >
              {form.mode === 'renew' && <option value="">{t('hr.contract.sameType')}</option>}
              {contractTypes.active.map((c) => (
                <option key={c.code} value={c.code}>
                  {contractTypes.label(c.code)}
                </option>
              ))}
            </select>
            {form.mode === 'new' && (
              <label className="field field--inline">
                <span>{t('hr.contract.start')}</span>
                <input
                  type="date"
                  className="input input--sm"
                  value={f.startDate}
                  onChange={(e) => setF({ ...f, startDate: e.target.value })}
                />
              </label>
            )}
            <label className="field field--inline">
              <span>{t('hr.field.contractEnd')}</span>
              <input type="date" className="input input--sm" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            </label>
            {salaryOk && (
              <input
                className="input input--sm"
                style={{ maxWidth: 120 }}
                inputMode="decimal"
                placeholder={t('hr.field.salary')}
                aria-label={t('hr.field.salary')}
                value={f.salary}
                onChange={(e) => setF({ ...f, salary: e.target.value })}
              />
            )}
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
              {t('hr.save')}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setForm(null)}>
              {t('docs.cancel')}
            </button>
          </div>
        )}
        {msg && <p className="login__error">{msg}</p>}
      </section>

      <section className="card profile-card profile-card--full">
        <h2 className="card__title">{t('hr.history')}</h2>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id} className="timeline__item">
              <span className="mono timeline__date">{e.date}</span>
              <b>{t(`hr.event.${e.type}` as TranslationKey)}</b>
              <span className="card__hint"> {eventLabel(e)}</span>
              {e.note && <div className="card__hint">{e.note}</div>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

// ------------------------------------------------------------------ leave --

function LeaveSection({ employee, canEdit }: { employee: Employee; canEdit: boolean }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [year, setYear] = useState(new Date().getUTCFullYear())
  const [data, setData] = useState<LeaveOverview | null>(null)
  const [f, setF] = useState({ typeCode: '', startDate: today(), endDate: today(), reason: '' })
  const [adj, setAdj] = useState({ typeCode: '', days: '', reason: '' })
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await employeeLeave(getAccessToken, employee.id, year)
    if (res.kind === 'ok') setData(res.data)
  }, [getAccessToken, employee.id, year])
  useEffect(() => {
    void load()
  }, [load])

  const name = (code: string) => {
    const b = data?.balances.find((x) => x.typeCode === code)
    return b ? (lang === 'ar' && b.nameAr) || b.name : code
  }
  const submit = async () => {
    const res = await requestLeave(getAccessToken, {
      employeeId: employee.id,
      typeCode: f.typeCode || data?.balances[0]?.typeCode || '',
      startDate: f.startDate,
      endDate: f.endDate,
      reason: f.reason.trim() || null,
    })
    if (res.kind !== 'ok') {
      const available = res.details?.available
      return setMsg(
        res.error === 'INSUFFICIENT_BALANCE' && available !== undefined
          ? t('hr.error.INSUFFICIENT_BALANCE_N', { n: String(available) })
          : hrError(t, res.error),
      )
    }
    setMsg(t('hr.leave.requested', { n: res.data.days }))
    setF({ ...f, reason: '' })
    await load()
  }
  const adjust = async () => {
    const days = Number(adj.days)
    if (!days || adj.reason.trim().length < 3) return setMsg(t('hr.error.adjustment'))
    const res = await adjustLeave(getAccessToken, employee.id, {
      typeCode: adj.typeCode || data?.balances[0]?.typeCode || '',
      year,
      days,
      reason: adj.reason.trim(),
    })
    if (res.kind !== 'ok') return setMsg(hrError(t, res.error))
    setAdj({ typeCode: '', days: '', reason: '' })
    await load()
  }

  return (
    <div className="profile-grid">
      <section className="card profile-card profile-card--full">
        <div className="card__head">
          <h2 className="card__title">{t('hr.leave.balances')}</h2>
          <select
            className="input input--sm"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label={t('hr.leave.year')}
          >
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        {data === null ? (
          <div className="skeleton" style={{ height: 60 }} />
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th>{t('hr.leave.type')}</th>
                  <th>{t('hr.leave.entitlement')}</th>
                  <th>{t('hr.leave.adjustments')}</th>
                  <th>{t('hr.leave.taken')}</th>
                  <th>{t('hr.leave.pending')}</th>
                  <th>{t('hr.leave.available')}</th>
                </tr>
              </thead>
              <tbody>
                {data.balances.map((b) => (
                  <tr key={b.typeCode}>
                    <td>{(lang === 'ar' && b.nameAr) || b.name}</td>
                    <td className="mono">{b.entitlement ?? '∞'}</td>
                    <td className="mono">{b.adjustments || '—'}</td>
                    <td className="mono">{b.taken}</td>
                    <td className="mono">{b.pending}</td>
                    <td className="mono">
                      <b>{b.available ?? '∞'}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canEdit && employee.status === 'active' && data && (
          <>
            <h3 className="card__subtitle">{t('hr.leave.new')}</h3>
            <div className="inline-form">
              <select
                className="input input--sm"
                value={f.typeCode}
                onChange={(e) => setF({ ...f, typeCode: e.target.value })}
                aria-label={t('hr.leave.type')}
              >
                {data.balances.map((b) => (
                  <option key={b.typeCode} value={b.typeCode}>
                    {name(b.typeCode)}
                  </option>
                ))}
              </select>
              <input
                type="date"
                className="input input--sm"
                value={f.startDate}
                onChange={(e) => setF({ ...f, startDate: e.target.value })}
                aria-label={t('hr.contract.start')}
              />
              <input
                type="date"
                className="input input--sm"
                value={f.endDate}
                onChange={(e) => setF({ ...f, endDate: e.target.value })}
                aria-label={t('hr.field.contractEnd')}
              />
              <input
                className="input input--sm"
                style={{ flex: 1, minWidth: 160 }}
                placeholder={t('billing.requestReason')}
                aria-label={t('billing.requestReason')}
                value={f.reason}
                onChange={(e) => setF({ ...f, reason: e.target.value })}
              />
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
                {t('billing.requestSend')}
              </button>
            </div>
            <h3 className="card__subtitle">{t('hr.leave.adjust')}</h3>
            <div className="inline-form">
              <select
                className="input input--sm"
                value={adj.typeCode}
                onChange={(e) => setAdj({ ...adj, typeCode: e.target.value })}
                aria-label={t('hr.leave.type')}
              >
                {data.balances.map((b) => (
                  <option key={b.typeCode} value={b.typeCode}>
                    {name(b.typeCode)}
                  </option>
                ))}
              </select>
              <input
                className="input input--sm"
                style={{ maxWidth: 80 }}
                inputMode="numeric"
                placeholder="±"
                aria-label={t('hr.leave.days')}
                value={adj.days}
                onChange={(e) => setAdj({ ...adj, days: e.target.value })}
              />
              <input
                className="input input--sm"
                style={{ flex: 1, minWidth: 160 }}
                placeholder={t('billing.requestReason')}
                aria-label={t('billing.requestReason')}
                value={adj.reason}
                onChange={(e) => setAdj({ ...adj, reason: e.target.value })}
              />
              <button type="button" className="btn btn--sm" onClick={() => void adjust()}>
                {t('fin.add')}
              </button>
            </div>
          </>
        )}
        {msg && <p className="card__hint">{msg}</p>}
      </section>
      <section className="card profile-card profile-card--full">
        <h2 className="card__title">{t('hr.leave.requests')}</h2>
        {data && data.requests.length === 0 && <div className="empty-state">{t('hr.leave.none')}</div>}
        {data?.requests.map((r) => (
          <div key={r.id} className="stat-row">
            <span>
              {name(r.typeCode)} ·{' '}
              <span className="mono">
                {r.startDate} → {r.endDate}
              </span>{' '}
              · {t('hr.leaveTypes.days', { n: r.days })}
              {r.reason && <span className="card__hint"> — {r.reason}</span>}
            </span>
            <span>
              <span className={`chip ${LEAVE_TONE[r.status]}`}>{t(`hr.leave.status.${r.status}` as TranslationKey)}</span>
              {canEdit && (r.status === 'pending' || (r.status === 'approved' && r.startDate > today())) && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void cancelLeave(getAccessToken, r.id).then(load)}>
                  {t('fin.withdraw')}
                </button>
              )}
            </span>
          </div>
        ))}
        {data?.requests.some((r) => r.status === 'pending') && <p className="card__hint">{t('hr.leave.pendingHint')}</p>}
      </section>
    </div>
  )
}

// ------------------------------------------------------------- attendance --

function AttendanceSection({ employee }: { employee: Employee }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [data, setData] = useState<Awaited<ReturnType<typeof employeeAttendance>> | null>(null)
  const to = today()
  const from = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
  useEffect(() => {
    void employeeAttendance(getAccessToken, employee.id, from, to).then(setData)
  }, [getAccessToken, employee.id, from, to])
  if (!data) return <div className="skeleton" style={{ height: 80 }} />
  if (data.kind !== 'ok') return <div className="empty-state">{t('profile.error.generic')}</div>
  return (
    <section className="card">
      <h2 className="card__title">{t('hr.attendance.last60')}</h2>
      <div className="docs__chips">
        {Object.entries(data.data.counts).map(([k, v]) => (
          <span key={k} className="chip">
            {t(`hr.mark.${k}` as TranslationKey)} · {v}
          </span>
        ))}
      </div>
      {data.data.records.length === 0 ? (
        <div className="empty-state">{t('hr.attendance.none')}</div>
      ) : (
        <table className="table">
          <tbody>
            {data.data.records.map((r) => (
              <tr key={r.date}>
                <td className="mono">{r.date}</td>
                <td>{t(`hr.mark.${r.status}` as TranslationKey)}</td>
                <td className="mono">{[r.checkIn, r.checkOut].filter(Boolean).join(' – ')}</td>
                <td className="card__hint">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
