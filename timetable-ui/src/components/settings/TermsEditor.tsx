import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { setAcademicYearTerms, type AcademicYear } from '../../lib/academicYearsApi'

type Term = { id?: string; name: string; startDate: string; endDate: string }

/** SAMS 11.2: a year's terms — what attendance summaries and the
 * gradebook's assessment plans are split by. */
export function TermsEditor({ year, onSaved, onClose }: { year: AcademicYear; onSaved: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [terms, setTerms] = useState<Term[]>(
    year.terms?.length ? year.terms.map((x) => ({ ...x })) : [{ name: '', startDate: year.startDate, endDate: year.endDate }],
  )
  const [error, setError] = useState<string | null>(null)
  const set = (i: number, patch: Partial<Term>) => setTerms((ts) => ts.map((x, k) => (k === i ? { ...x, ...patch } : x)))

  const save = async () => {
    const r = await setAcademicYearTerms(
      getAccessToken,
      year.id,
      terms.filter((x) => x.name.trim()),
    )
    if (r.kind === 'ok') return onSaved()
    const key = `settings.terms.error.${r.error}` as TranslationKey
    setError(t(key) === key ? t('settings.years.saveError') : t(key))
  }

  return (
    <div className="terms-editor">
      <table className="table">
        <thead>
          <tr>
            <th>{t('settings.terms.name')}</th>
            <th>{t('settings.years.start')}</th>
            <th>{t('settings.years.end')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {terms.map((term, i) => (
            <tr key={term.id ?? `new-${i}`}>
              <td>
                <input
                  className="input input--sm"
                  value={term.name}
                  placeholder={t('settings.terms.placeholder', { n: i + 1 })}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input input--sm"
                  type="date"
                  value={term.startDate}
                  onChange={(e) => set(i, { startDate: e.target.value })}
                />
              </td>
              <td>
                <input className="input input--sm" type="date" value={term.endDate} onChange={(e) => set(i, { endDate: e.target.value })} />
              </td>
              <td>
                <button type="button" className="link-btn" onClick={() => setTerms((ts) => ts.filter((_, k) => k !== i))}>
                  {t('grades.remove')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="notice notice--warn">{error}</p>}
      <div className="page__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setTerms((ts) => [...ts, { name: '', startDate: year.startDate, endDate: year.endDate }])}
        >
          {t('settings.terms.add')}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          {t('settings.terms.cancel')}
        </button>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()}>
          {t('settings.terms.save')}
        </button>
      </div>
    </div>
  )
}
