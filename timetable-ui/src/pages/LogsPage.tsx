import { useEffect, useState } from 'react'
import { exportAuditLog, listAuditLog } from '../lib/auditLog'
import type { AuditEntry } from '../lib/auditLog'
import { listNotifications } from '../lib/notificationsApi'
import type { NotificationLogEntry } from '../lib/notificationsApi'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type Tab = 'activity' | 'notifications'

export function LogsPage() {
  const { t } = useI18n()
  const { branches, activeBranchId } = useApp()
  const { getAccessToken } = useAuth()

  const [tab, setTab] = useState<Tab>('activity')
  const [activity, setActivity] = useState<AuditEntry[] | null>(null)
  const [notifications, setNotifications] = useState<NotificationLogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [entityFilter, setEntityFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      const token = await getAccessToken()
      if (!token) {
        if (!cancelled) setLoading(false)
        return
      }
      if (tab === 'activity') {
        const result = await listAuditLog(getAccessToken, {
          entity: entityFilter.trim() || undefined,
          action: actionFilter.trim() || undefined,
          branchId: branchFilter || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          limit: 150,
        })
        if (cancelled) return
        if (result.kind === 'ok') setActivity(result.data)
        else setError(result.error)
      } else {
        const result = await listNotifications(getAccessToken, {
          branchId: activeBranchId ?? undefined,
          limit: 200,
        })
        if (cancelled) return
        if (result.kind === 'ok') setNotifications(result.data)
        else setError(result.error)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [tab, activeBranchId, getAccessToken, entityFilter, actionFilter, branchFilter, dateFrom, dateTo])

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id

  const runExport = async () => {
    setExporting(true)
    setExportError(null)
    const result = await exportAuditLog(getAccessToken, {
      entity: entityFilter.trim() || undefined,
      action: actionFilter.trim() || undefined,
      branchId: branchFilter || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    })
    setExporting(false)
    if (result.kind === 'error') setExportError(result.error)
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.logs')}</h1>
          <p className="page__subtitle">{t('logs.subtitle')}</p>
        </div>
      </header>

      <div className="segmented" style={{ marginBlockEnd: 12 }}>
        <button type="button" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>
          {t('logs.tab.activity')}
        </button>
        <button
          type="button"
          aria-pressed={tab === 'notifications'}
          onClick={() => setTab('notifications')}
        >
          {t('logs.tab.notifications')}
        </button>
      </div>

      {tab === 'activity' && (
        <div className="panel">
          <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input
              className="input"
              style={{ minWidth: 160 }}
              placeholder={t('logs.filter.entity')}
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
            />
            <input
              className="input"
              style={{ minWidth: 160 }}
              placeholder={t('logs.filter.action')}
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
            />
            {branches.length > 1 && (
              <select className="input" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
                <option value="">{t('logs.filter.allBranches')}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <input
              className="input"
              type="date"
              aria-label={t('logs.filter.dateFrom')}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
            <input
              className="input"
              type="date"
              aria-label={t('logs.filter.dateTo')}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
            <button type="button" className="btn" onClick={() => void runExport()} disabled={exporting}>
              {exporting ? t('logs.exporting') : t('logs.export')}
            </button>
          </div>
          {exportError && <p className="card__hint" style={{ color: 'var(--bad)' }}>{exportError}</p>}
        </div>
      )}

      {error && <p className="card__hint" style={{ color: 'var(--bad)' }}>{error}</p>}

      <div className="card">
        {loading && <div className="empty-state">{t('logs.loading')}</div>}

        {!loading && tab === 'activity' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>{t('logs.col.when')}</th>
                  <th style={{ width: 220 }}>{t('logs.col.action')}</th>
                  {branches.length > 1 && <th style={{ width: 120 }}>{t('nav.branch')}</th>}
                  <th>{t('logs.col.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {(activity ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="mono">{entry.action}</td>
                    {branches.length > 1 && <td>{entry.branchId ? branchName(entry.branchId) : '—'}</td>}
                    <td className="mono" style={{ fontSize: 12 }}>
                      {[entry.entity, entry.entityId].filter(Boolean).join(' · ')}
                      {Object.keys(entry.meta).length > 0 && ` — ${JSON.stringify(entry.meta)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {activity?.length === 0 && <div className="empty-state">{t('logs.none')}</div>}
          </div>
        )}

        {!loading && tab === 'notifications' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>{t('logs.col.when')}</th>
                  {branches.length > 1 && <th style={{ width: 120 }}>{t('nav.branch')}</th>}
                  <th style={{ width: 90 }}>{t('logs.col.channel')}</th>
                  <th>{t('logs.col.to')}</th>
                  <th style={{ width: 110 }}>{t('logs.col.status')}</th>
                  <th style={{ width: 100 }}>{t('logs.col.action')}</th>
                </tr>
              </thead>
              <tbody>
                {(notifications ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    {branches.length > 1 && <td>{branchName(entry.branchId)}</td>}
                    <td>{entry.channel}</td>
                    <td>
                      {entry.to || '—'}
                      {entry.guardianName && (
                        <span className="card__hint"> · {entry.guardianName}</span>
                      )}
                      {entry.error && (
                        <span className="card__hint" style={{ color: 'var(--bad)' }}> · {entry.error}</span>
                      )}
                    </td>
                    <td>{t(`logs.status.${entry.status}` as TranslationKey)}</td>
                    <td>{t(`logs.trigger.${entry.trigger}` as TranslationKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {notifications?.length === 0 && <div className="empty-state">{t('logs.none')}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
