import { useCallback, useEffect, useState } from 'react'
import type { Student } from '../../domain/students'
import type { FeeStructure, Invoice, StudentBalance } from '../../domain/finance'
import { formatMinorUnits } from '../../domain/finance'
import { generateInvoice, getStudentBalance, listFeeStructures, listInvoices } from '../../lib/financeApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { InvoiceDetailDialog } from '../InvoiceDetailDialog'

/**
 * The student's live financial summary (SAMS 2.2), computed by Finance on
 * every read, never stored on the student, plus their invoices.
 */
export function FinanceTab({ student }: { student: Student }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [balance, setBalance] = useState<StudentBalance | null>(null)
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [feeStructures, setFeeStructures] = useState<FeeStructure[]>([])
  const [generating, setGenerating] = useState(false)
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    const [b, i] = await Promise.all([
      getStudentBalance(getAccessToken, student.id),
      listInvoices(getAccessToken, { studentId: student.id }),
    ])
    if (b.kind === 'ok') setBalance(b.data)
    if (i.kind === 'ok') setInvoices(i.data)
    setError(b.kind !== 'ok' || i.kind !== 'ok')
  }, [getAccessToken, student.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!student.branchId || !can('finance.invoice.create')) return
    void listFeeStructures(getAccessToken, { branchId: student.branchId }).then((res) => {
      if (res.kind === 'ok') setFeeStructures(res.data)
    })
  }, [getAccessToken, student.branchId, can])

  const generate = async (feeStructureId: string) => {
    if (!feeStructureId) return
    setGenerating(true)
    await generateInvoice(getAccessToken, { studentId: student.id, feeStructureId })
    setGenerating(false)
    await load()
  }

  const tile = (label: TranslationKey, amount: number | undefined, tone = 'neutral') => (
    <div className={`stat-tile stat-tile--${tone} stat-tile--plain`}>
      <span className="stat-tile__label">{t(label)}</span>
      <b className="stat-tile__value">{amount === undefined ? <span className="skeleton" /> : formatMinorUnits(amount)}</b>
    </div>
  )

  return (
    <div className="profile-grid">
      {error && <div className="empty-state profile-card--full">{t('profile.error.generic')}</div>}
      <div className="tile-grid profile-card--full">
        {tile('profile.finance.invoiced', balance?.invoicedTotal)}
        {tile('profile.finance.paid', balance?.paidTotal, 'ok')}
        {tile('profile.finance.outstanding', balance?.outstandingBalance, (balance?.outstandingBalance ?? 0) > 0 ? 'warn' : 'ok')}
      </div>

      <section className="card profile-card profile-card--full">
        <div className="card__head">
          <h2 className="card__title">{t('billing.title')}</h2>
          {can('finance.invoice.create') && (
            <select
              className="input input--sm"
              disabled={generating || feeStructures.length === 0}
              defaultValue=""
              aria-label={t('billing.generateInvoice')}
              onChange={(e) => {
                void generate(e.target.value)
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
          )}
        </div>
        {invoices === null ? (
          <div className="skeleton" style={{ height: 56 }} />
        ) : invoices.length === 0 ? (
          <div className="empty-state">{t('billing.none')}</div>
        ) : (
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 420 }}>
              <thead>
                <tr>
                  <th>{t('billing.col.number')}</th>
                  <th>{t('billing.col.date')}</th>
                  <th>{t('billing.col.total')}</th>
                  <th>{t('billing.col.status')}</th>
                  <th style={{ width: 44 }} />
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
          </div>
        )}
      </section>

      {openInvoiceId && (
        <InvoiceDetailDialog
          invoiceId={openInvoiceId}
          getAccessToken={getAccessToken}
          onClose={() => setOpenInvoiceId(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  )
}
