import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/**
 * Pushes the working dataset to the configured server. Reports what actually
 * happened — including "not configured" and "the server moved on" — rather than
 * showing a success tick regardless.
 */
export function SyncButton() {
  const { t, lang } = useI18n()
  const { syncStatus, syncNow, pullFromServer, syncConfigured, savedAt } = useApp()
  const [open, setOpen] = useState(false)

  const state = syncStatus.state
  const busy = state === 'syncing'

  const formatTime = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-u-nu-latn' : 'en', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null

  const detail = () => {
    if (!syncConfigured) return t('sync.notConfigured')
    if (state === 'conflict') return t('sync.serverAhead')
    if (syncStatus.message === 'SERVER_EMPTY') return t('sync.serverEmpty')
    if (state === 'error') return `${t('sync.error')} · ${syncStatus.message ?? ''}`
    const time = formatTime(syncStatus.lastSyncedAt)
    return time ? t('sync.lastSynced', { time }) : t('sync.never')
  }

  return (
    <div className="sync">
      <button
        type="button"
        className={`btn sync__btn sync__btn--${state}`}
        onClick={() => {
          if (syncConfigured) void syncNow()
          setOpen((current) => !current)
        }}
        disabled={busy}
        title={detail()}
      >
        <span className={`sync__dot sync__dot--${state}`} aria-hidden="true" />
        {t(`sync.${state}` as TranslationKey)}
      </button>

      {open && (
        <div className="sync__pop" role="status">
          <p className="sync__detail">{detail()}</p>
          <p className="sync__saved">
            {savedAt
              ? t('sync.savedLocally', { time: formatTime(savedAt) ?? '' })
              : t('sync.notSaved')}
          </p>
          <div className="sync__actions">
            {syncConfigured ? (
              <>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => void syncNow()}
                >
                  {t('sync.push')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => void pullFromServer()}
                >
                  {t('sync.pull')}
                </button>
              </>
            ) : (
              <Link className="btn btn--sm" to="/settings" onClick={() => setOpen(false)}>
                {t('nav.settings')}
              </Link>
            )}
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>
              {t('dialog.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
