import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { DayOfWeek } from '../domain/types'
import type { Lang, TranslationKey } from './translations'
import { TRANSLATIONS } from './translations'

type Values = Record<string, string | number>

interface I18nValue {
  lang: Lang
  dir: 'ltr' | 'rtl'
  setLang: (lang: Lang) => void
  t: (key: TranslationKey, values?: Values) => string
  /** Latin digits in both languages — timetables read better that way. */
  n: (value: number) => string
  day: (day: DayOfWeek) => string
  dayShort: (day: DayOfWeek) => string
}

const I18nContext = createContext<I18nValue | null>(null)
const STORAGE_KEY = 'timetable.lang'

function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'ar' || stored === 'en') return stored
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
  }
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('ar') ? 'ar' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang)
  const dir: 'ltr' | 'rtl' = lang === 'ar' ? 'rtl' : 'ltr'

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Preference simply will not persist.
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.lang = lang
    root.dir = dir
  }, [lang, dir])

  const value = useMemo<I18nValue>(() => {
    const table = TRANSLATIONS[lang]
    const t = (key: TranslationKey, values?: Values) => {
      const template = table[key] ?? TRANSLATIONS.en[key] ?? key
      if (!values) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      )
    }
    const locale = lang === 'ar' ? 'ar-u-nu-latn' : 'en'
    return {
      lang,
      dir,
      setLang,
      t,
      n: (input: number) => input.toLocaleString(locale),
      day: (input: DayOfWeek) => t(`day.${input}` as TranslationKey),
      dayShort: (input: DayOfWeek) => t(`dayShort.${input}` as TranslationKey),
    }
  }, [lang, dir, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside an I18nProvider')
  return value
}
