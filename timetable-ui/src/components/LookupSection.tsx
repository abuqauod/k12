import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { createLookup, listLookups, updateLookup } from '../lib/settingsApi'
import type { LookupItem, LookupKind } from '../lib/settingsApi'

const ERRORS: Record<string, TranslationKey> = {
  LOOKUP_CODE_TAKEN: 'lookups.error.taken',
  LAST_ACTIVE_LOOKUP: 'lookups.error.lastActive',
  INVALID_BODY: 'lookups.error.invalid',
}

/**
 * One settings list (SAMS 1.11): payment methods, document categories, and
 * every kind later phases add. Entries are never deleted — deactivating
 * hides a code from new records while existing records keep showing it.
 */
export function LookupSection({ kind, title, hint }: { kind: LookupKind; title: string; hint: string }) {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const canManage = can('settings.manage')
  const [items, setItems] = useState<LookupItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [labelAr, setLabelAr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const result = await listLookups(getAccessToken, kind, true)
    if (result.kind === 'ok') setItems(result.data)
    else setError(t('lookups.error.load'))
  }, [getAccessToken, kind, t])

  useEffect(() => {
    void load()
  }, [load])

  const show = (code: string) => setError(t(ERRORS[code] ?? 'lookups.error.generic'))

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!code.trim() || !label.trim()) return
    setBusy(true)
    setError(null)
    const result = await createLookup(getAccessToken, kind, {
      code: code.trim().toLowerCase(),
      label: label.trim(),
      labelAr: labelAr.trim() || null,
    })
    setBusy(false)
    if (result.kind !== 'ok') return show(result.error)
    setCode('')
    setLabel('')
    setLabelAr('')
    void load()
  }

  const toggle = async (item: LookupItem) => {
    setError(null)
    const result = await updateLookup(getAccessToken, kind, item.code, { active: !item.active })
    if (result.kind !== 'ok') return show(result.error)
    void load()
  }

  return (
    <section className="card" aria-labelledby={`lookup-${kind}`}>
      <h2 id={`lookup-${kind}`} className="card__title">
        {title}
      </h2>
      <p className="card__hint">{hint}</p>

      {items === null && !error ? (
        <p className="card__hint" aria-busy="true">
          <span className="skeleton" />
        </p>
      ) : (
        items && (
          <table className="table">
            <thead>
              <tr>
                <th>{t('lookups.col.name')}</th>
                <th>{t('lookups.col.code')}</th>
                <th>{t('lookups.col.status')}</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.code} className={item.active ? undefined : 'is-muted'}>
                  <td>
                    {(lang === 'ar' && item.labelAr) || item.label}
                    {!item.builtIn && <span className="chip lookup__custom">{t('lookups.custom')}</span>}
                  </td>
                  <td className="mono">{item.code}</td>
                  <td>
                    <span className={`chip ${item.active ? 'chip--ok' : ''}`}>
                      {t(item.active ? 'lookups.active' : 'lookups.inactive')}
                    </span>
                  </td>
                  {canManage && (
                    <td className="row-actions">
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void toggle(item)}>
                        {t(item.active ? 'lookups.deactivate' : 'lookups.activate')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {canManage && (
        <form className="lookup__add" onSubmit={add}>
          <input
            className="input input--sm"
            placeholder={t('lookups.col.code')}
            aria-label={t('lookups.col.code')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            pattern="[a-z][a-z0-9_]{1,39}"
            title={t('lookups.codeHint')}
          />
          <input
            className="input input--sm"
            placeholder={t('lookups.col.name')}
            aria-label={t('lookups.col.name')}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <input
            className="input input--sm"
            dir="rtl"
            placeholder={t('lookups.col.nameAr')}
            aria-label={t('lookups.col.nameAr')}
            value={labelAr}
            onChange={(event) => setLabelAr(event.target.value)}
          />
          <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !code.trim() || !label.trim()}>
            {t('lookups.add')}
          </button>
        </form>
      )}
      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
