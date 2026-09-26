import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { api } from '../lib/apiClient'

interface Step {
  key: string
  done: boolean
  link: string
  count?: number
}

const HIDE_KEY = 'timetable.gettingStarted.hidden'

/** SAMS 12: what a new school sets up first, worked out from its data. Shown
 * until every step is done, or someone hides it on this device. */
export function GettingStarted() {
  const { t, n } = useI18n()
  const { getAccessToken, can, tenant } = useAuth()
  const [data, setData] = useState<{ steps: Step[]; done: number; total: number; emailConfigured: boolean } | null>(null)
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(`${HIDE_KEY}.${tenant?.id}`) === '1'
    } catch {
      return false
    }
  })
  const allowed = can('settings.read') && can('settings.manage')
  useEffect(() => {
    if (!allowed || hidden) return
    void api<{ steps: Step[]; done: number; total: number; emailConfigured: boolean }>(getAccessToken, 'GET', '/onboarding').then(
      (r) => r.kind === 'ok' && setData(r.data),
    )
  }, [getAccessToken, allowed, hidden])

  if (!allowed || hidden || !data || data.done === data.total) return null
  const hide = () => {
    try {
      localStorage.setItem(`${HIDE_KEY}.${tenant?.id}`, '1')
    } catch {
      // Hidden for this visit only.
    }
    setHidden(true)
  }
  return (
    <section className="card getting-started" aria-labelledby="getting-started">
      <div className="card__head">
        <h2 id="getting-started" className="card__title">
          {t('start.title')} · {t('start.progress', { done: n(data.done), total: n(data.total) })}
        </h2>
        <button type="button" className="link-btn" onClick={hide}>
          {t('start.hide')}
        </button>
      </div>
      <p className="card__hint">{t('start.hint')}</p>
      {!data.emailConfigured && <p className="notice notice--warn">{t('start.noEmail')}</p>}
      <ol className="getting-started__steps">
        {data.steps.map((s) => (
          <li key={s.key} className={s.done ? 'is-done' : undefined}>
            <span className="getting-started__mark" aria-hidden="true">
              {s.done ? '✓' : ''}
            </span>
            <span>
              <b>{t(`start.step.${s.key}` as TranslationKey)}</b>
              {s.done && s.count !== undefined && <small className="card__hint"> · {n(s.count)}</small>}
              {!s.done && <small className="card__hint"> — {t(`start.why.${s.key}` as TranslationKey)}</small>}
            </span>
            {!s.done && (
              <Link to={s.link} className="btn btn--sm">
                {t('start.go')}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
