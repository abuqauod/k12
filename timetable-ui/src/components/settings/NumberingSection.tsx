import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/apiClient'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

/**
 * Settings → Numbering (backlog): how each kind of record is numbered.
 * A change applies to the next record; numbers already given never change.
 */

interface NumberFormat {
  prefix: string
  separator: '-' | '/' | ''
  padding: number
  includeYear: boolean
}
interface KindRow {
  kind: string
  label: { en: string; ar: string }
  format: NumberFormat
  nextSeq: number
  example: string
}

const preview = (f: NumberFormat, seq: number) =>
  [f.prefix, ...(f.includeYear ? [String(new Date().getUTCFullYear())] : []), String(seq).padStart(f.padding, '0')]
    .filter((p) => p !== '')
    .join(f.separator)

export function NumberingSection() {
  const { t, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [rows, setRows] = useState<KindRow[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<NumberFormat & { next: string }>({
    prefix: '',
    separator: '-',
    padding: 6,
    includeYear: false,
    next: '',
  })
  const [error, setError] = useState<string | null>(null)
  const canManage = can('settings.manage')

  const load = useCallback(async () => {
    const res = await api<{ kinds: KindRow[] }>(getAccessToken, 'GET', '/settings/numbering')
    setRows(res.kind === 'ok' ? res.data.kinds : [])
  }, [getAccessToken])
  useEffect(() => {
    void load()
  }, [load])

  const edit = (r: KindRow) => {
    setEditing(r.kind)
    setError(null)
    setDraft({ ...r.format, next: '' })
  }
  const save = async (r: KindRow) => {
    const next = draft.next.trim() ? Number(draft.next) : undefined
    const res = await api(getAccessToken, 'PUT', `/settings/numbering/${r.kind}`, {
      prefix: draft.prefix.trim(),
      separator: draft.separator,
      padding: draft.padding,
      includeYear: draft.includeYear,
      ...(next !== undefined ? { nextNumber: next } : {}),
    })
    if (res.kind !== 'ok') {
      const key = `settings.numbering.error.${res.error}` as TranslationKey
      return setError(t(key) === key ? t('settings.numbering.error.generic') : t(key))
    }
    setEditing(null)
    await load()
  }

  return (
    <section className="card" aria-labelledby="numbering-title">
      <h2 id="numbering-title" className="card__title">
        {t('settings.section.numbering')}
      </h2>
      <p className="card__hint">{t('settings.numbering.hint')}</p>
      {rows === null ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('settings.numbering.record')}</th>
                <th>{t('settings.numbering.next')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) =>
                editing === r.kind ? (
                  <tr key={r.kind}>
                    <td colSpan={3}>
                      <b>{r.label[lang]}</b>
                      <div className="inline-form">
                        <label className="field field--inline">
                          <span>{t('settings.numbering.prefix')}</span>
                          <input
                            className="input input--sm"
                            style={{ width: 90 }}
                            dir="ltr"
                            maxLength={10}
                            value={draft.prefix}
                            onChange={(e) => setDraft({ ...draft, prefix: e.target.value.replace(/[^A-Za-z0-9]/g, '') })}
                          />
                        </label>
                        <label className="field field--inline">
                          <span>{t('settings.numbering.separator')}</span>
                          <select
                            className="select input--sm"
                            value={draft.separator}
                            onChange={(e) => setDraft({ ...draft, separator: e.target.value as NumberFormat['separator'] })}
                          >
                            <option value="-">-</option>
                            <option value="/">/</option>
                            <option value="">{t('settings.numbering.none')}</option>
                          </select>
                        </label>
                        <label className="field field--inline">
                          <span>{t('settings.numbering.digits')}</span>
                          <select
                            className="select input--sm"
                            value={draft.padding}
                            onChange={(e) => setDraft({ ...draft, padding: Number(e.target.value) })}
                          >
                            {[3, 4, 5, 6, 7, 8].map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="checkbox-inline">
                          <input
                            type="checkbox"
                            checked={draft.includeYear}
                            onChange={(e) => setDraft({ ...draft, includeYear: e.target.checked })}
                          />
                          {t('settings.numbering.year')}
                        </label>
                        <label className="field field--inline">
                          <span>{t('settings.numbering.startAt')}</span>
                          <input
                            className="input input--sm"
                            style={{ width: 100 }}
                            inputMode="numeric"
                            dir="ltr"
                            placeholder={draft.includeYear === r.format.includeYear ? String(r.nextSeq) : '1'}
                            value={draft.next}
                            onChange={(e) => setDraft({ ...draft, next: e.target.value.replace(/\D/g, '') })}
                          />
                        </label>
                      </div>
                      <p className="card__hint">
                        {t('settings.numbering.preview')}{' '}
                        <b className="mono" dir="ltr">
                          {preview(draft, Number(draft.next) || (draft.includeYear === r.format.includeYear ? r.nextSeq : 1))}
                        </b>
                      </p>
                      {error && <p className="login__error">{error}</p>}
                      <div className="inline-form">
                        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save(r)}>
                          {t('comm.save')}
                        </button>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(null)}>
                          {t('docs.cancel')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.kind}>
                    <td>{r.label[lang]}</td>
                    <td className="mono" dir="ltr">
                      {r.example}
                    </td>
                    <td className="num">
                      {canManage && (
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => edit(r)}>
                          {t('rep.sch.edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
