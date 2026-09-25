import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { decideApproval } from '../lib/approvalsApi'
import type { Approval } from '../lib/approvalsApi'

const STATUS_TONE: Record<Approval['status'], string> = {
  pending: 'chip--warn',
  approved: 'chip--ok',
  rejected: 'chip--bad',
  cancelled: '',
}

/** Server error codes worth a specific message; anything else is generic. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  STALE_REQUEST: 'approvals.error.stale',
  DISCOUNT_BELOW_PAID: 'approvals.error.belowPaid',
  ALREADY_DECIDED: 'approvals.error.decided',
  COMMENT_REQUIRED: 'approvals.error.commentRequired',
}

/**
 * One approval request with its comment trail and the actions the caller may
 * take: approve / reject (a decider who isn't the requester) or cancel (the
 * requester). The server enforces all of it; this only hides what it would
 * refuse.
 */
export function ApprovalCard({
  approval,
  canDecide,
  onChanged,
}: {
  approval: Approval
  canDecide: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const { user, getAccessToken, can } = useAuth()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pending = approval.status === 'pending'
  const mine = approval.requestedBy === user?.id
  const mayDecide = pending && canDecide && !mine
  const mayCancel = pending && (mine || can('approvals.decide'))

  const act = async (action: 'approve' | 'reject' | 'cancel') => {
    setBusy(true)
    setError(null)
    const result = await decideApproval(getAccessToken, approval.id, action, comment.trim() || null)
    setBusy(false)
    if (result.kind === 'ok') {
      setComment('')
      onChanged()
      return
    }
    setError(t(ERROR_KEYS[result.error] ?? 'approvals.error.generic'))
  }

  return (
    <article className="approval">
      <header className="approval__head">
        <b className="approval__summary">{approval.summary}</b>
        <span className={`chip ${STATUS_TONE[approval.status]}`}>{t(`approvals.status.${approval.status}`)}</span>
      </header>
      <p className="approval__meta">
        {t('approvals.requestedAt', { when: new Date(approval.createdAt).toLocaleString() })}
        {mine && ` · ${t('approvals.byYou')}`}
      </p>
      {approval.comments.length > 0 && (
        <ul className="approval__comments">
          {approval.comments.map((c) => (
            <li key={c.id}>
              <span className="chip">{t(`approvals.kind.${c.kind}`)}</span> {c.body}
            </li>
          ))}
        </ul>
      )}
      {(mayDecide || mayCancel) && (
        <div className="approval__actions">
          <input
            className="input input--sm"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={t('approvals.commentPlaceholder')}
            aria-label={t('approvals.commentPlaceholder')}
          />
          {mayDecide && (
            <>
              <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => void act('approve')}>
                {t('approvals.approve')}
              </button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void act('reject')}>
                {t('approvals.reject')}
              </button>
            </>
          )}
          {mayCancel && (
            <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void act('cancel')}>
              {t('approvals.cancel')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}
