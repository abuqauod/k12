import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { deleteStudent } from '../lib/studentsApi'

const ERRORS: Record<string, TranslationKey> = {
  INVALID_PASSWORD: 'students.delete.error.password',
  TOO_MANY_ATTEMPTS: 'students.delete.error.locked',
  HAS_FINANCIAL_HISTORY: 'students.delete.error.finance',
  BRANCH_FORBIDDEN: 'students.delete.error.forbidden',
  FORBIDDEN: 'students.delete.error.forbidden',
}

/**
 * "Are you sure?" for permanently deleting a student. The admin re-enters
 * their own password — the server verifies it, and refuses a student with
 * financial history (they should be withdrawn instead).
 */
export function DeleteStudentDialog({
  studentId,
  studentName,
  onClose,
  onDeleted,
}: {
  studentId: string
  studentName: string
  onClose: () => void
  onDeleted: () => void
}) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password) return
    setBusy(true)
    setError(null)
    const result = await deleteStudent(getAccessToken, studentId, password)
    setBusy(false)
    if (result.kind === 'ok') {
      onDeleted()
      return
    }
    setPassword('')
    setError(t(ERRORS[result.error] ?? 'students.delete.error.generic'))
    inputRef.current?.focus()
  }

  return (
    <div
      className="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-student-title"
      aria-describedby="delete-student-body"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form className="dialog__panel" style={{ maxWidth: 440 }} onSubmit={confirm}>
        <div className="dialog__head">
          <strong id="delete-student-title">{t('students.delete.title')}</strong>
        </div>
        <div className="dialog__body" style={{ display: 'grid', gap: 12 }}>
          <p id="delete-student-body" style={{ margin: 0 }}>
            {t('students.delete.confirm', { name: studentName })}
          </p>
          <p className="card__hint" style={{ margin: 0 }}>
            {t('students.delete.hint')}
          </p>
          <label className="field">
            <span>{t('students.delete.password')}</span>
            <input
              ref={inputRef}
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(error)}
            />
          </label>
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
              {t('students.delete.cancel')}
            </button>
            <button type="submit" className="btn btn--sm btn--danger" disabled={busy || !password} aria-busy={busy}>
              {t('students.delete.submit')}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
