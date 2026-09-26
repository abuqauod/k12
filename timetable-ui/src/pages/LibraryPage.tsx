import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  addCopy,
  createBook,
  lend,
  librarySettings,
  listBooks,
  listLoans,
  loanAction,
  saveLibrarySettings,
  type Book,
  type LibrarySettings,
  type Loan,
} from '../lib/opsApi'
import { opsError } from '../lib/opsUi'
import { useLookup } from '../lib/useLookup'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { PersonPicker, type PickedPerson } from '../components/ops/PersonPicker'
import { ReasonDialog } from '../components/ReasonDialog'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/** The library (SAMS 5.5): the lending desk, catalogue, loans and rules. */

type Tab = 'desk' | 'catalogue' | 'loans' | 'settings'
const TABS: Tab[] = ['desk', 'catalogue', 'loans', 'settings']

export function LibraryPage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'desk') as Tab
  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.library')}</h1>
          <p className="page__subtitle">{t('lib.subtitle')}</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={t('nav.library')}>
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className="tabs__tab"
            onClick={() =>
              setParams(
                (p) => {
                  p.set('tab', x)
                  return p
                },
                { replace: true },
              )
            }
          >
            {t(`lib.tab.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="finance-panel">
        {tab === 'desk' && <DeskTab />}
        {tab === 'catalogue' && <CatalogueTab />}
        {tab === 'loans' && <LoansTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}

function DeskTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [borrower, setBorrower] = useState<PickedPerson | null>(null)
  const [barcode, setBarcode] = useState('')
  const [loans, setLoans] = useState<Loan[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const canLend = can('ops.library.manage')

  const loadBorrower = useCallback(async () => {
    if (!borrower) return setLoans([])
    const res = await listLoans(getAccessToken, { borrowerId: borrower.id, view: 'all' })
    if (res.kind === 'ok') setLoans(res.data.filter((l) => (!l.returnedAt && !l.lostAt) || l.fineStatus === 'due'))
  }, [getAccessToken, borrower])
  useEffect(() => {
    void loadBorrower()
  }, [loadBorrower])

  const doLend = async () => {
    if (!borrower || !barcode.trim()) return
    const res = await lend(getAccessToken, { barcode: barcode.trim(), borrowerType: borrower.type, borrowerId: borrower.id })
    if (res.kind !== 'ok') return setMsg({ ok: false, text: opsError(t, res.error) })
    setMsg({ ok: true, text: t('lib.lent', { due: res.data.dueDate }) })
    setBarcode('')
    await loadBorrower()
  }
  const act = async (id: string, action: 'return' | 'renew' | 'lost' | 'pay') => {
    const res = await loanAction(getAccessToken, id, action)
    if (res.kind !== 'ok') return setMsg({ ok: false, text: opsError(t, res.error) })
    setMsg({
      ok: true,
      text:
        action === 'return' && res.data.fine > 0
          ? t('lib.returnedFine', { fine: formatMinorUnits(res.data.fine) })
          : t(`lib.done.${action}` as TranslationKey),
    })
    await loadBorrower()
  }

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('lib.desk.borrower')}</h2>
        {borrower ? (
          <div className="stat-row">
            <b>{borrower.label}</b>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setBorrower(null)}>
              {t('lib.desk.change')}
            </button>
          </div>
        ) : (
          <PersonPicker types={['student', 'employee']} branchId={activeBranchId ?? undefined} onPick={setBorrower} />
        )}
        {borrower && canLend && (
          <div className="inline-form">
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={t('lib.desk.scan')}
              aria-label={t('lib.desk.scan')}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doLend()}
            />
            <button type="button" className="btn btn--primary" onClick={() => void doLend()}>
              {t('lib.desk.lend')}
            </button>
          </div>
        )}
        {msg && <p className={msg.ok ? 'card__hint' : 'login__error'}>{msg.text}</p>}
      </section>
      {borrower && (
        <section className="card">
          <h2 className="card__title">{t('lib.desk.onLoan')}</h2>
          {loans.length === 0 && <p className="card__empty">{t('lib.desk.nothing')}</p>}
          {loans.map((l) => (
            <div key={l.id} className="stat-row">
              <span>
                <b>{l.title}</b> <span className="mono card__hint">{l.barcode}</span>
                <div className={l.overdue ? 'login__error' : 'card__hint'}>
                  {l.returnedAt || l.lostAt ? t('lib.fineDue', { fine: formatMinorUnits(l.fine) }) : t('lib.due', { date: l.dueDate })}
                  {l.overdue && ` · ${t('lib.overdueFine', { fine: formatMinorUnits(l.fine) })}`}
                </div>
              </span>
              {canLend && (
                <span className="row-actions">
                  {!l.returnedAt && !l.lostAt ? (
                    <>
                      <button type="button" className="btn btn--sm" onClick={() => void act(l.id, 'return')}>
                        {t('lib.return')}
                      </button>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void act(l.id, 'renew')}>
                        {t('lib.renew')}
                      </button>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void act(l.id, 'lost')}>
                        {t('lib.lost')}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={() => void act(l.id, 'pay')}>
                      {t('lib.pay')}
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function CatalogueTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const categories = useLookup('bookCategory')
  const [q, setQ] = useState('')
  const [books, setBooks] = useState<Book[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ title: '', author: '', isbn: '', categoryCode: '' })
  const [copy, setCopy] = useState<Record<string, { barcode: string; shelf: string }>>({})
  const [error, setError] = useState<string | null>(null)
  const canManage = can('ops.library.manage')

  const load = useCallback(async () => {
    const res = await listBooks(getAccessToken, { q: q.trim() || undefined, branchId: activeBranchId ?? undefined })
    setBooks(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, q, activeBranchId])
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250)
    return () => clearTimeout(timer)
  }, [load])

  const add = async () => {
    if (!f.title.trim()) return
    const res = await createBook(getAccessToken, {
      title: f.title.trim(),
      author: f.author.trim() || null,
      isbn: f.isbn.trim() || null,
      categoryCode: f.categoryCode || null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setAdding(false)
    setF({ title: '', author: '', isbn: '', categoryCode: '' })
    await load()
  }
  const addCopyTo = async (bookId: string) => {
    const c = copy[bookId]
    if (!activeBranchId || !c?.barcode.trim()) return
    const res = await addCopy(getAccessToken, bookId, {
      branchId: activeBranchId,
      barcode: c.barcode.trim(),
      shelf: c.shelf.trim() || null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setCopy({ ...copy, [bookId]: { barcode: '', shelf: '' } })
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={t('lib.search')}
          aria-label={t('lib.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {canManage && !adding && (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setAdding(true)}>
            + {t('lib.book.new')}
          </button>
        )}
      </div>
      {adding && (
        <div className="inline-form">
          <input
            className="input input--sm"
            style={{ flex: 1, minWidth: 180 }}
            placeholder={t('lib.book.title')}
            aria-label={t('lib.book.title')}
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
          <input
            className="input input--sm"
            placeholder={t('lib.book.author')}
            aria-label={t('lib.book.author')}
            value={f.author}
            onChange={(e) => setF({ ...f, author: e.target.value })}
          />
          <input
            className="input input--sm"
            style={{ maxWidth: 140 }}
            placeholder="ISBN"
            aria-label="ISBN"
            value={f.isbn}
            onChange={(e) => setF({ ...f, isbn: e.target.value })}
          />
          <select
            className="input input--sm"
            value={f.categoryCode}
            onChange={(e) => setF({ ...f, categoryCode: e.target.value })}
            aria-label={t('ops.col.category')}
          >
            <option value="">—</option>
            {categories.active.map((c) => (
              <option key={c.code} value={c.code}>
                {categories.label(c.code)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
            {t('fin.add')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
            {t('approvals.cancel')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
      {books === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : books.length === 0 ? (
        <div className="empty-state">{t('lib.none')}</div>
      ) : (
        <ul className="record-list">
          {books.map((b) => (
            <li key={b.id} className="record-list__item">
              <div className="record-list__row">
                <span className="record-list__main" style={{ cursor: 'default' }}>
                  <b>{b.title}</b>
                  <span className="card__hint">
                    {' '}
                    — {[b.author, b.categoryCode && categories.label(b.categoryCode), b.isbn].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={`chip ${b.available > 0 ? 'chip--ok' : 'chip--warn'}`}>
                  {t('lib.available', { n: b.available, total: b.copies.length })}
                </span>
              </div>
              <div className="docs__chips">
                {b.copies.map((c) => (
                  <span key={c.id} className="chip mono" title={c.shelf ?? ''}>
                    {c.barcode} · {t(`lib.copy.${c.status}` as TranslationKey)}
                  </span>
                ))}
              </div>
              {canManage && activeBranchId && (
                <div className="inline-form">
                  <input
                    className="input input--sm"
                    style={{ maxWidth: 140 }}
                    placeholder={t('lib.barcode')}
                    aria-label={t('lib.barcode')}
                    value={copy[b.id]?.barcode ?? ''}
                    onChange={(e) => setCopy({ ...copy, [b.id]: { shelf: copy[b.id]?.shelf ?? '', barcode: e.target.value } })}
                  />
                  <input
                    className="input input--sm"
                    style={{ maxWidth: 100 }}
                    placeholder={t('lib.shelf')}
                    aria-label={t('lib.shelf')}
                    value={copy[b.id]?.shelf ?? ''}
                    onChange={(e) => setCopy({ ...copy, [b.id]: { barcode: copy[b.id]?.barcode ?? '', shelf: e.target.value } })}
                  />
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => void addCopyTo(b.id)}>
                    {t('lib.addCopy')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LoansTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [view, setView] = useState<'open' | 'overdue' | 'fines' | 'all'>('overdue')
  const [rows, setRows] = useState<Loan[] | null>(null)
  const [waiving, setWaiving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listLoans(getAccessToken, { branchId: activeBranchId ?? undefined, view })
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, activeBranchId, view])
  useEffect(() => {
    void load()
  }, [load])
  const act = async (id: string, action: 'return' | 'pay') => {
    const res = await loanAction(getAccessToken, id, action)
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <div className="segmented" role="group" aria-label={t('lib.tab.loans')}>
          {(['overdue', 'open', 'fines', 'all'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
              {t(`lib.view.${v}` as TranslationKey)}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="login__error">{error}</p>}
      {rows === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('lib.loans.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 620 }}>
            <thead>
              <tr>
                <th>{t('lib.book.title')}</th>
                <th>{t('lib.borrower')}</th>
                <th>{t('lib.dueCol')}</th>
                <th>{t('lib.fine')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.title} <span className="mono card__hint">{l.barcode}</span>
                  </td>
                  <td>{l.borrowerName}</td>
                  <td className={l.overdue ? 'mono login__error' : 'mono'}>
                    {l.returnedAt ? t('lib.returnedOn', { date: l.returnedAt }) : l.lostAt ? t('lib.copy.lost') : l.dueDate}
                  </td>
                  <td className="mono">
                    {l.fine > 0 ? formatMinorUnits(l.fine) : '—'}
                    {l.fineStatus !== 'none' && l.fineStatus !== 'due' && (
                      <span className="card__hint"> · {t(`lib.fineStatus.${l.fineStatus}` as TranslationKey)}</span>
                    )}
                  </td>
                  <td>
                    {can('ops.library.manage') && (
                      <span className="row-actions">
                        {!l.returnedAt && !l.lostAt && (
                          <button type="button" className="btn btn--sm" onClick={() => void act(l.id, 'return')}>
                            {t('lib.return')}
                          </button>
                        )}
                        {l.fineStatus === 'due' && (
                          <>
                            <button type="button" className="btn btn--sm" onClick={() => void act(l.id, 'pay')}>
                              {t('lib.pay')}
                            </button>
                            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setWaiving(l.id)}>
                              {t('lib.waive')}
                            </button>
                          </>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {waiving && (
        <ReasonDialog
          title={t('lib.waive')}
          confirmLabel={t('lib.waive')}
          onClose={() => setWaiving(null)}
          onConfirm={async (reason) => {
            const res = await loanAction(getAccessToken, waiving, 'waive', { reason })
            if (res.kind !== 'ok') return opsError(t, res.error)
            setWaiving(null)
            await load()
            return null
          }}
        />
      )}
    </section>
  )
}

function SettingsTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [s, setS] = useState<LibrarySettings | null>(null)
  const [fine, setFine] = useState('')
  const [lostFee, setLostFee] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    void librarySettings(getAccessToken).then((res) => {
      if (res.kind !== 'ok') return
      setS(res.data)
      setFine(formatMinorUnits(res.data.finePerDay))
      setLostFee(formatMinorUnits(res.data.lostFee))
    })
  }, [getAccessToken])
  if (!s) return <div className="skeleton" style={{ height: 100 }} />
  const canEdit = can('ops.library.manage')
  const save = async () => {
    const res = await saveLibrarySettings(getAccessToken, {
      ...s,
      finePerDay: parseMinorUnits(fine) ?? 0,
      lostFee: parseMinorUnits(lostFee) ?? 0,
    })
    setMsg(res.kind === 'ok' ? t('hr.saved') : opsError(t, res.error))
  }
  const num = (k: 'loanDays' | 'maxLoans' | 'maxRenewals') => (
    <label className="field">
      <span>{t(`lib.settings.${k}` as TranslationKey)}</span>
      <input
        className="input"
        inputMode="numeric"
        disabled={!canEdit}
        value={s[k]}
        onChange={(e) => setS({ ...s, [k]: Number(e.target.value) || 0 })}
      />
    </label>
  )
  return (
    <section className="card">
      <h2 className="card__title">{t('lib.tab.settings')}</h2>
      <div className="field-grid">
        {num('loanDays')}
        {num('maxLoans')}
        {num('maxRenewals')}
        <label className="field">
          <span>{t('lib.settings.finePerDay')}</span>
          <input className="input" inputMode="decimal" disabled={!canEdit} value={fine} onChange={(e) => setFine(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('lib.settings.lostFee')}</span>
          <input className="input" inputMode="decimal" disabled={!canEdit} value={lostFee} onChange={(e) => setLostFee(e.target.value)} />
        </label>
      </div>
      {canEdit && (
        <div className="page__actions">
          {msg && <span className="card__hint">{msg}</span>}
          <button type="button" className="btn btn--primary" onClick={() => void save()}>
            {t('hr.save')}
          </button>
        </div>
      )}
    </section>
  )
}
