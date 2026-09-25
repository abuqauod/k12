import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { FeeStructure, Invoice, InvoiceStatus } from '../domain/finance'
import { formatMinorUnits } from '../domain/finance'
import { listFeeStructures, listInvoices } from '../lib/financeApi'
import { listAcademicYears } from '../lib/academicYearsApi'
import type { AcademicYear } from '../lib/academicYearsApi'
import { FeeStructureDialog } from '../components/FeeStructureDialog'
import { InvoiceDetailDialog } from '../components/InvoiceDetailDialog'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type StatusFilter = InvoiceStatus | 'ALL'

export function FinancePage() {
  const { t } = useI18n()
  const { branches, activeBranchId } = useApp()
  const { getAccessToken, can } = useAuth()
  const canManageFees = can('finance.feeStructure.manage')

  const [years, setYears] = useState<AcademicYear[]>([])
  const [branchId, setBranchId] = useState(activeBranchId ?? '')
  const [academicYearId, setAcademicYearId] = useState('')
  const [structures, setStructures] = useState<FeeStructure[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [loading, setLoading] = useState(true)

  const [editingStructure, setEditingStructure] = useState<FeeStructure | null | 'new'>(null)
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null)
  // ?invoice=<id> (from global search) opens that invoice once, then clears.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const linked = searchParams.get('invoice')
    if (!linked) return
    setOpenInvoiceId(linked)
    setSearchParams(
      (prev) => {
        prev.delete('invoice')
        return prev
      },
      { replace: true },
    )
  }, [searchParams, setSearchParams])

  useEffect(() => {
    void listAcademicYears(getAccessToken).then((res) => {
      if (res.kind !== 'ok') return
      setYears(res.data)
      setAcademicYearId((current) => current || res.data.find((y) => y.current)?.id || res.data[0]?.id || '')
    })
  }, [getAccessToken])

  useEffect(() => {
    if (!branchId) setBranchId(activeBranchId ?? '')
  }, [activeBranchId, branchId])

  const refresh = useCallback(async () => {
    if (!branchId) {
      setLoading(false)
      return
    }
    setLoading(true)
    const [structuresRes, invoicesRes] = await Promise.all([
      listFeeStructures(getAccessToken, { branchId, academicYearId: academicYearId || undefined }),
      listInvoices(getAccessToken, {
        branchId,
        academicYearId: academicYearId || undefined,
        status: status === 'ALL' ? undefined : status,
      }),
    ])
    setLoading(false)
    if (structuresRes.kind === 'ok') setStructures(structuresRes.data)
    if (invoicesRes.kind === 'ok') setInvoices(invoicesRes.data)
  }, [getAccessToken, branchId, academicYearId, status])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('billing.title')}</h1>
          <p className="page__subtitle">{t('billing.subtitle')}</p>
        </div>
      </header>

      <div className="panel">
        <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t('parents.filter.allBranches')}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select className="input" value={academicYearId} onChange={(e) => setAcademicYearId(e.target.value)}>
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card-row">
        <section className="card">
          <div className="page__actions" style={{ marginBottom: 8 }}>
            <h2 className="card__title" style={{ margin: 0, flex: 1 }}>{t('billing.feeStructures')}</h2>
            {canManageFees && branchId && (
              <button type="button" className="btn btn--sm" onClick={() => setEditingStructure('new')}>
                {t('billing.feeStructure.new')}
              </button>
            )}
          </div>
          {structures.length === 0 ? (
            <p className="card__empty">{t('billing.feeStructures.none')}</p>
          ) : (
            structures.map((fs) => (
              <button
                key={fs.id}
                type="button"
                className="stat-row"
                style={{ width: '100%', textAlign: 'start', cursor: 'pointer', background: 'none', border: 'none' }}
                onClick={() => setEditingStructure(fs)}
              >
                <span>
                  {fs.gradeLevel} — {fs.name}
                </span>
                <b>{formatMinorUnits(fs.lineItems.reduce((sum, l) => sum + l.amount, 0))}</b>
              </button>
            ))
          )}
        </section>

        <section className="card">
          <div className="page__actions" style={{ marginBottom: 8 }}>
            <h2 className="card__title" style={{ margin: 0, flex: 1 }}>{t('billing.invoices')}</h2>
            <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="ALL">{t('parents.filter.allStatuses')}</option>
              <option value="open">{t('billing.status.open')}</option>
              <option value="partially_paid">{t('billing.status.partially_paid')}</option>
              <option value="paid">{t('billing.status.paid')}</option>
              <option value="void">{t('billing.status.void')}</option>
            </select>
          </div>
          {loading && <p className="card__hint">{t('parents.loading')}</p>}
          {!loading && invoices.length === 0 && <p className="card__empty">{t('billing.none')}</p>}
          {!loading && invoices.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('billing.col.number')}</th>
                  <th>{t('billing.col.total')}</th>
                  <th>{t('billing.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <button type="button" className="btn btn--ghost btn--sm" style={{ padding: 0 }} onClick={() => setOpenInvoiceId(invoice.id)}>
                        {invoice.invoiceNumber}
                      </button>
                    </td>
                    <td className="mono">{formatMinorUnits(invoice.total)}</td>
                    <td>
                      <span className={`chip${invoice.status === 'paid' ? ' chip--on' : ''}`}>
                        {t(`billing.status.${invoice.status}` as TranslationKey)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {editingStructure && branchId && (
        <FeeStructureDialog
          structure={editingStructure === 'new' ? null : { ...editingStructure }}
          branchId={branchId}
          academicYearId={academicYearId}
          getAccessToken={getAccessToken}
          onClose={() => setEditingStructure(null)}
          onSaved={() => {
            setEditingStructure(null)
            void refresh()
          }}
        />
      )}

      {openInvoiceId && (
        <InvoiceDetailDialog
          invoiceId={openInvoiceId}
          getAccessToken={getAccessToken}
          onClose={() => setOpenInvoiceId(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  )
}
