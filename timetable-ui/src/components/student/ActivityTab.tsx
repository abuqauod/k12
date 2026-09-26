import { actionLabel } from '../../lib/auditLabels'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listAuditLog, type AuditEntry } from '../../lib/auditLog'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'

/** Which fields an update touched, from the audit row's before/after. */
function changedFields(entry: AuditEntry): string[] {
  if (!entry.action.endsWith('.update')) return []
  const after = entry.meta.after
  if (!after || typeof after !== 'object' || Array.isArray(after)) return []
  return Object.keys(after).filter((k) => k !== 'documentId')
}

/**
 * Everything recorded against this student in the audit log: profile
 * edits, guardians, documents (uploads, verification, views), deletion
 * attempts. Needs `audit.read`, like the Activity log page.
 */
export function ActivityTab({ studentId }: { studentId: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    void listAuditLog(getAccessToken, { entity: 'student', entityId: studentId, limit: 100 }).then((res) => {
      if (res.kind === 'ok') setEntries(res.data)
      else setError(true)
    })
  }, [getAccessToken, studentId])

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <section className="card profile-card profile-card--full">
      <div className="card__head">
        <h2 className="card__title">{t('profile.activity')}</h2>
        <Link className="card__link" to="/logs">
          {t('dash.activity.viewAll')}
        </Link>
      </div>
      {error ? (
        <div className="empty-state">{t('profile.error.generic')}</div>
      ) : entries === null ? (
        <div className="skeleton" style={{ height: 80 }} />
      ) : entries.length === 0 ? (
        <div className="empty-state">{t('profile.activity.none')}</div>
      ) : (
        <ol className="timeline">
          {entries.map((entry) => {
            const fields = changedFields(entry)
            return (
              <li key={entry.id} className="timeline__item">
                <span className="timeline__dot" aria-hidden="true" />
                <span className="timeline__head">
                  <span title={entry.action}>{actionLabel(entry.action, lang)}</span>
                  <time className="docs__meta" dateTime={entry.createdAt}>
                    {when(entry.createdAt)}
                  </time>
                </span>
                {fields.length > 0 && (
                  <span className="docs__meta">{t('profile.activity.fields', { fields: fields.join(', ') })}</span>
                )}
                {entry.reason && <span className="docs__meta">{t('profile.activity.reason', { reason: entry.reason })}</span>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
