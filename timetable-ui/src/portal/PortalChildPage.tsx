import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  portalChild,
  portalDocuments,
  portalFileUrl,
  portalFinance,
  type PortalChildDetail,
  type PortalDocument,
  type PortalInvoice,
  type PortalReceipt,
} from '../lib/portalApi'
import { formatMinorUnits } from '../domain/finance'
import { PaymentResult, PayOnline } from './PayOnline'
import { PortalWallet } from './PortalWallet'
import { portalReportCardPath, portalReportCards } from '../lib/gradesApi'
import { openApiPage } from '../lib/printPage'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/** One child in the portal: overview and attendance, fees (for a parent
 * responsible for them) and the documents the school shares. */

type Tab = 'overview' | 'finance' | 'reports' | 'wallet' | 'documents'

const INSTALLMENT_TONE: Record<string, string> = {
  paid: 'chip--ok',
  partial: 'chip--on',
  due: '',
  overdue: 'chip--bad',
}

export function PortalChildPage() {
  const { t, lang, n } = useI18n()
  const { id = '' } = useParams()
  const { getAccessToken } = useAuth()
  const [params, setParams] = useSearchParams()
  const [child, setChild] = useState<PortalChildDetail | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    void portalChild(getAccessToken, id).then((r) => {
      if (r.kind === 'ok') setChild(r.data)
      else setMissing(true)
    })
  }, [getAccessToken, id])

  if (missing) {
    return (
      <div className="empty-state">
        {t('portal.childMissing')} <Link to="/portal">{t('portal.back')}</Link>
      </div>
    )
  }
  if (!child) return <div className="skeleton" style={{ height: 160 }} />

  const tabs: Tab[] = child.finance ? ['overview', 'finance', 'reports', 'wallet', 'documents'] : ['overview', 'reports', 'wallet', 'documents']
  const tab = (tabs.includes(params.get('tab') as Tab) ? params.get('tab') : 'overview') as Tab
  const absences = (child.attendance.counts.absent ?? 0) + (child.attendance.counts.excused ?? 0)

  return (
    <>
      <p>
        <Link to="/portal">
          {lang === 'ar' ? '›' : '‹'} {t('portal.back')}
        </Link>
      </p>
      <header className="portal-child__head">
        <h1 className="page__title">{(lang === 'ar' && child.nameAr) || child.name}</h1>
        <p className="card__hint">
          {[child.className, child.branchName, child.academicYear?.name].filter(Boolean).join(' · ')} ·{' '}
          <span className="mono">{child.studentNumber}</span>
        </p>
      </header>
      <div className="tabs" role="tablist" aria-label={child.name}>
        {tabs.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className="tabs__tab"
            onClick={() => setParams({ tab: x }, { replace: true })}
          >
            {t(`portal.child.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'overview' && (
          <section className="card">
            <h3 className="card__title">{t('portal.attendance')}</h3>
            <p className="card__hint">{t('portal.attendanceSince', { date: child.attendance.since })}</p>
            <div className="portal-stats">
              {(['present', 'late', 'absent', 'excused'] as const).map((s) => (
                <div key={s} className="portal-stat">
                  <b className="mono">{n(child.attendance.counts[s] ?? 0)}</b>
                  <small>{t(`portal.att.${s}` as TranslationKey)}</small>
                </div>
              ))}
            </div>
            {absences + (child.attendance.counts.late ?? 0) > 0 && (
              <>
                <h4 className="card__title">{t('portal.recentAbsences')}</h4>
                <ul className="portal-list">
                  {child.attendance.recent.map((r) => (
                    <li key={r.date}>
                      <span className="mono">{r.date}</span> — {t(`portal.att.${r.status}` as TranslationKey)}
                      {r.note && <small className="card__hint"> · {r.note}</small>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
        {tab === 'finance' && <Finance id={id} />}
        {tab === 'reports' && <ReportCards id={id} />}
        {tab === 'wallet' && <PortalWallet id={id} />}
        {tab === 'documents' && <Documents id={id} />}
      </div>
    </>
  )
}

function Finance({ id }: { id: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [data, setData] = useState<{
    balance: number
    onlinePayment: { currency: string } | null
    invoices: PortalInvoice[]
    receipts: PortalReceipt[]
  } | null>(null)
  const [error, setError] = useState(false)
  const load = useCallback(() => {
    void portalFinance(getAccessToken, id).then((r) => (r.kind === 'ok' ? setData(r.data) : setError(true)))
  }, [getAccessToken, id])
  useEffect(() => {
    load()
  }, [load])
  if (error) return <div className="empty-state">{t('portal.financeHidden')}</div>
  if (!data) return <div className="skeleton" style={{ height: 120 }} />
  return (
    <>
      <PaymentResult onSettled={load} />
      <section className="card portal-balance">
        <small>{t('portal.balance')}</small>
        <b className="mono">{formatMinorUnits(data.balance)}</b>
      </section>
      {data.onlinePayment && data.balance > 0 && <PayOnline studentId={id} balance={data.balance} currency={data.onlinePayment.currency} />}
      <section className="card">
        <h3 className="card__title">{t('portal.invoices')}</h3>
        {data.invoices.length === 0 ? (
          <div className="empty-state">{t('portal.noInvoices')}</div>
        ) : (
          <ul className="portal-list">
            {data.invoices.map((inv) => (
              <li key={inv.id} className="portal-invoice">
                <div className="portal-invoice__head">
                  <span>
                    <b className="mono">{inv.invoiceNumber}</b>
                    <small className="card__hint"> · {inv.issueDate}</small>
                  </span>
                  <span className="mono">
                    {formatMinorUnits(inv.balance)} / {formatMinorUnits(inv.total)}
                  </span>
                </div>
                <ul className="portal-lines">
                  {inv.lines.map((l, i) => (
                    <li key={i}>
                      <span>{(lang === 'ar' && l.labelAr) || l.label}</span>
                      <span className="mono">{formatMinorUnits(l.amount)}</span>
                    </li>
                  ))}
                  {inv.adjustments.map((a, i) => (
                    <li key={`a${i}`}>
                      <span>{a.label}</span>
                      <span className="mono">-{formatMinorUnits(a.amount)}</span>
                    </li>
                  ))}
                </ul>
                {inv.installments.length > 0 ? (
                  <ul className="portal-lines">
                    {inv.installments.map((p, i) => (
                      <li key={i}>
                        <span>
                          {p.dueDate}{' '}
                          <span className={`chip ${INSTALLMENT_TONE[p.status]}`}>{t(`portal.inst.${p.status}` as TranslationKey)}</span>
                        </span>
                        <span className="mono">{formatMinorUnits(p.amount - p.paid)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  inv.dueDate && <small className="card__hint">{t('portal.dueOn', { date: inv.dueDate })}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h3 className="card__title">{t('portal.receipts')}</h3>
        {data.receipts.length === 0 ? (
          <div className="empty-state">{t('portal.noReceipts')}</div>
        ) : (
          <ul className="portal-list">
            {data.receipts.map((r) => (
              <li key={r.id} className="portal-lines__row">
                <span>
                  <b className="mono">{r.receiptNumber}</b>
                  <small className="card__hint">
                    {' '}
                    · {r.issueDate} · {r.allocations.map((a) => a.invoiceNumber).join(', ')}
                  </small>
                </span>
                <span className="mono">{formatMinorUnits(r.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function Documents({ id }: { id: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [docs, setDocs] = useState<PortalDocument[] | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    void portalDocuments(getAccessToken, id).then((r) => setDocs(r.kind === 'ok' ? r.data.documents : []))
  }, [getAccessToken, id])
  const open = async (docId: string, download: boolean) => {
    const res = await portalFileUrl(getAccessToken, docId, download)
    if (res.kind !== 'ok') return setError(true)
    window.open(res.data, '_blank', 'noopener')
  }
  if (docs === null) return <div className="skeleton" style={{ height: 120 }} />
  if (docs.length === 0) return <div className="empty-state">{t('portal.noDocuments')}</div>
  return (
    <section className="card">
      {error && <p className="login__error">{t('portal.loadError')}</p>}
      <ul className="portal-list">
        {docs.map((d) => (
          <li key={d.id} className="portal-lines__row">
            <span>
              <b>{(lang === 'ar' && d.categoryLabelAr) || d.categoryLabel}</b>
              <small className="card__hint">
                {' '}
                · {d.fileName}
                {d.expiresAt && ` · ${t('portal.expires', { date: d.expiresAt })}`}
              </small>
            </span>
            <span className="inline-form">
              <button type="button" className="btn btn--sm" onClick={() => void open(d.id, false)}>
                {t('portal.view')}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void open(d.id, true)}>
                {t('portal.download')}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** SAMS 11.2: the report cards the school has released for this child. */
function ReportCards({ id }: { id: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [cards, setCards] = useState<{ termId: string; term: string; releasedAt: string }[] | null>(null)
  useEffect(() => {
    void portalReportCards(getAccessToken, id, lang).then((r) => setCards(r.kind === 'ok' ? r.data.cards : []))
  }, [getAccessToken, id, lang])
  if (!cards) return <div className="skeleton" style={{ height: 80 }} />
  return (
    <section className="card">
      <h3 className="card__title">{t('portal.reportCards')}</h3>
      {cards.length === 0 ? (
        <div className="empty-state">{t('portal.noReportCards')}</div>
      ) : (
        <ul className="portal-list">
          {cards.map((c) => (
            <li key={c.termId} className="portal-lines__row">
              <span>
                <b>{c.term}</b> <small className="card__hint">· {c.releasedAt.slice(0, 10)}</small>
              </span>
              <button type="button" className="btn btn--sm" onClick={() => void openApiPage(getAccessToken, portalReportCardPath(id, c.termId, lang))}>
                {t('portal.openReportCard')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
