import { useI18n } from '../i18n/I18nContext'
import { LANGUAGES } from '../i18n/translations'

export function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, t } = useI18n()

  return (
    <div className="segmented" role="group" aria-label={t('settings.language')}>
      {LANGUAGES.map((entry) => (
        <button
          key={entry.code}
          type="button"
          lang={entry.code}
          aria-pressed={lang === entry.code}
          onClick={() => setLang(entry.code)}
          title={entry.label}
        >
          {compact ? entry.code.toUpperCase() : entry.native}
        </button>
      ))}
    </div>
  )
}
