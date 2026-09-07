import { useMemo, useRef, useState, useEffect } from 'react'
import { useApp } from '../state/AppContext'
import type { Theme } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { LANGUAGES } from '../i18n/translations'
import type { TranslationKey } from '../i18n/translations'
import { download, toProblemPayload } from '../lib/api'
import { SchoolWeekFields } from '../components/SchoolWeekFields'
import { ConstraintWeightsEditor } from '../components/ConstraintWeights'
import { RoutingRulesEditor } from '../components/RoutingRules'
import { BreaksEditor } from '../components/BreaksEditor'
import { JsonDialog } from '../components/JsonDialog'

const THEMES: Theme[] = ['auto', 'light', 'dark']

type SettingsTab = 'account' | 'calendar' | 'transport' | 'tuning'

const TABS: Array<{ id: SettingsTab; key: TranslationKey }> = [
  { id: 'account', key: 'settings.tab.account' },
  { id: 'calendar', key: 'settings.tab.calendar' },
  { id: 'transport', key: 'fleet.rules' },
  { id: 'tuning', key: 'panel.tuning' },
]

export function SettingsPage() {
  const { t } = useI18n()
  const [tab, setTab] = useState<SettingsTab>('account')

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('settings.title')}</h1>
          <p className="page__subtitle">{t('settings.subtitle')}</p>
        </div>
      </header>

      <div className="page-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.key)}
          </button>
        ))}
      </div>

      {tab === 'account' && <AccountTab />}
      {tab === 'calendar' && <CalendarSettingsTab />}
      {tab === 'transport' && <TransportSettingsTab />}
      {tab === 'tuning' && <TuningSettingsTab />}
    </div>
  )
}

/* ----------------------------------------------------------------- account */

const DATASET_FILE = 'timetable-problem.json'

function AccountTab() {
  const { t, n, lang, setLang } = useI18n()
  const { user } = useAuth()
  const { theme, setTheme, problem, resetSample, importProblem } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)

  const problemJson = useMemo(
    () => JSON.stringify(toProblemPayload(problem), null, 2),
    [problem],
  )

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <>
      <div className="card-row">
        <section className="card">
          <h2 className="card__title">{t('settings.language')}</h2>
          <p className="card__hint">{t('settings.languageHint')}</p>
          <div className="option-list">
            {LANGUAGES.map((entry) => (
              <button
                key={entry.code}
                type="button"
                lang={entry.code}
                className={`option${lang === entry.code ? ' option--on' : ''}`}
                onClick={() => setLang(entry.code)}
              >
                <b>{entry.native}</b>
                <small>
                  {entry.label} · {entry.dir.toUpperCase()}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">{t('settings.theme')}</h2>
          <div className="option-list">
            {THEMES.map((entry) => (
              <button
                key={entry}
                type="button"
                className={`option${theme === entry ? ' option--on' : ''}`}
                onClick={() => setTheme(entry)}
              >
                <b>{t(`settings.theme.${entry}` as TranslationKey)}</b>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="card-row">
        <section className="card">
          <h2 className="card__title">{t('settings.account')}</h2>
          <div className="stat-row">
            <span>{user ? (lang === 'ar' ? user.displayNameAr ?? user.displayName : user.displayName) : ''}</span>
            <b className="mono">{user?.email}</b>
          </div>
          <div className="stat-row">
            <span>{t('settings.role')}</span>
            <b>{user ? t(`settings.role.${user.role}` as TranslationKey) : ''}</b>
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">{t('settings.dataTitle')}</h2>
          <p className="card__hint">{t('settings.dataHint')}</p>
          <div className="page__actions">
            <button type="button" className="btn" onClick={() => setDialog(true)}>
              {t('settings.viewJson')}
            </button>
            <button type="button" className="btn" onClick={() => download(DATASET_FILE, problemJson)}>
              {t('dialog.download')}
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              {t('header.import')}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                resetSample()
                setToast(t('toast.reset'))
              }}
            >
              {t('header.reset')}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                importProblem(file, (result) => {
                  if (result.startsWith('OK:')) {
                    setToast(t('toast.imported', { count: n(Number(result.slice(3))) }))
                  } else if (result === 'NEEDS_ARRAYS') {
                    setToast(t('toast.needArrays'))
                  } else {
                    setToast(t('toast.importFailed'))
                  }
                })
              }
              event.target.value = ''
            }}
          />
        </section>
      </div>

      <div className="card-row">
        <SyncCard />
      </div>

      {dialog && (
        <JsonDialog
          title={t('dialog.problemTitle')}
          subtitle={t('dialog.problemSubtitle', {
            lessons: n(problem.lessons.length),
            slots: n(problem.timeslots.length),
            rooms: n(problem.rooms.length),
          })}
          json={problemJson}
          filename={DATASET_FILE}
          onClose={() => setDialog(false)}
          onDownload={download}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

/* -------------------------------------------------------------------- sync */

function SyncCard() {
  const { t } = useI18n()
  const { syncSettings, setSyncSettings } = useApp()

  return (
    <section className="card">
      <h2 className="card__title">{t('sync.title')}</h2>
      <p className="card__hint">{t('sync.hint')}</p>
      <div className="field-grid">
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>{t('sync.baseUrl')}</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://api.example.school"
            value={syncSettings.baseUrl}
            onChange={(event) =>
              setSyncSettings({ ...syncSettings, baseUrl: event.target.value })
            }
          />
        </label>
        <label className="field">
          <span>{t('sync.schoolId')}</span>
          <input
            className="input"
            value={syncSettings.schoolId}
            onChange={(event) =>
              setSyncSettings({ ...syncSettings, schoolId: event.target.value })
            }
          />
        </label>
      </div>
      <p className="card__hint" style={{ margin: '10px 0 0' }}>
        {t('sync.usingSession')}
      </p>
    </section>
  )
}

/* --------------------------------------------------------------- transport */

function TransportSettingsTab() {
  const { t } = useI18n()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('fleet.rules')}</h2>
        <p className="card__hint">{t('fleet.rulesHint')}</p>
        <RoutingRulesEditor />
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ tuning */

function TuningSettingsTab() {
  const { t } = useI18n()
  const { problem, setProblem } = useApp()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('tuning.title')}</h2>
        <p className="card__hint">{t('tuning.hint')}</p>
        <ConstraintWeightsEditor problem={problem} onChange={setProblem} />
      </section>
    </div>
  )
}

/* ---------------------------------------------------------------- calendar */

function CalendarSettingsTab() {
  const { t } = useI18n()
  const { problem, setProblem } = useApp()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('calendar.weekTitle')}</h2>
        <SchoolWeekFields problem={problem} onChange={setProblem} />
      </section>

      <section className="card">
        <h2 className="card__title">{t('calendar.breaks')}</h2>
        <BreaksEditor />
      </section>
    </div>
  )
}
