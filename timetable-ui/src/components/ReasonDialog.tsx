import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nContext'

/**
 * Asks why before a sensitive action (void, deactivate, …). The reason is
 * required by the server and kept in the audit log (SAMS 1.12).
 */
export function ReasonDialog({
  title,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string
  confirmLabel: string
  /** Resolves to an error message to show, or null when done. */
  onConfirm: (reason: string) => Promise<string | null>
  onClose: () => void
}) {
  const { t } = useI18n()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const valid = reason.trim().length >= 3

  useEffect(() => {
    ref.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    const failure = await onConfirm(reason.trim())
    setBusy(false)
    if (failure) setError(failure)
  }

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reason-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form className="dialog__panel" style={{ maxWidth: 440 }} onSubmit={submit}>
        <div className="dialog__head">
          <strong id="reason-title">{title}</strong>
        </div>
        <div className="dialog__body" style={{ display: 'grid', gap: 10 }}>
          <label className="field">
            <span>{t('reason.label')}</span>
            <textarea
              ref={ref}
              className="input"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby="reason-hint"
            />
          </label>
          <p id="reason-hint" className="card__hint" style={{ margin: 0 }}>
            {t('reason.hint')}
          </p>
          {error && (
            <p className="login__error" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </div>
        <div className="dialog__foot">
          <span />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn--sm" onClick={onClose} disabled={busy}>
              {t('reason.cancel')}
            </button>
            <button type="submit" className="btn btn--sm btn--danger" disabled={busy || !valid} aria-busy={busy}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
