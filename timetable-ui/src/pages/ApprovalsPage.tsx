import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { ApprovalCard } from '../components/ApprovalCard'
import { listApprovals, listApprovalTypes } from '../lib/approvalsApi'
import type { Approval, ApprovalStatus } from '../lib/approvalsApi'

type View = 'toDecide' | 'mine'

/** The approvals queue (SAMS 1.10): requests the caller can decide, and the
 * caller's own requests. Every request type shares this one page. */
export function ApprovalsPage() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [view, setView] = useState<View>('toDecide')
  const [status, setStatus] = useState<ApprovalStatus | ''>('pending')
  const [approvals, setApprovals] = useState<Approval[] | null>(null)
  const [decidable, setDecidable] = useState<Set<string>>(new Set())
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    const [list, types] = await Promise.all([
      listApprovals(getAccessToken, { view, ...(status ? { status } : {}) }),
      listApprovalTypes(getAccessToken),
    ])
    setError(list.kind !== 'ok')
    setApprovals(list.kind === 'ok' ? list.data : [])
    if (types.kind === 'ok') setDecidable(new Set(types.data.filter((x) => x.canDecide).map((x) => x.type)))
  }, [getAccessToken, view, status])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('approvals.title')}</h1>
          <p className="page__subtitle">{t('approvals.subtitle')}</p>
        </div>
      </header>

      <div className="approvals__toolbar">
        <div className="segmented" role="group" aria-label={t('approvals.title')}>
          {(['toDecide', 'mine'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {t(`approvals.view.${v}`)}
            </button>
          ))}
        </div>
        <select
          className="select"
          value={status}
          onChange={(event) => setStatus(event.target.value as ApprovalStatus | '')}
          aria-label={t('approvals.filterStatus')}
        >
          <option value="">{t('approvals.status.any')}</option>
          {(['pending', 'approved', 'rejected', 'cancelled'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`approvals.status.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="card card__empty">{t('approvals.error.load')}</p>
      ) : approvals === null ? (
        <p className="card card__empty" aria-busy="true">
          {t('approvals.loading')}
        </p>
      ) : approvals.length === 0 ? (
        <p className="card card__empty">{t(view === 'toDecide' ? 'approvals.empty.toDecide' : 'approvals.empty.mine')}</p>
      ) : (
        <div className="approval-list">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              canDecide={decidable.has(approval.type)}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}
    </div>
  )
}
