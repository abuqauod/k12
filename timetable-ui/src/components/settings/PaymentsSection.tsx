import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import { getPaymentSettings, savePaymentSettings, type PaymentSettings, type ProviderKey } from '../../lib/paymentsApi'

/**
 * Settings → Online payments (SAMS 11.1): the school's own card gateway
 * account. Keys are write-only: once saved, the form shows that one is
 * stored, never what it is; leaving the field blank keeps it.
 */

const CURRENCIES = ['JOD', 'SAR', 'AED', 'USD', 'KWD', 'QAR', 'BHD', 'OMR', 'EGP']
const SECRET_FIELDS = new Set(['serverKey', 'accessToken'])

export function PaymentsSection() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const [data, setData] = useState<PaymentSettings | null>(null)
  const [draft, setDraft] = useState({
    enabled: false,
    provider: null as ProviderKey | null,
    currency: 'JOD',
    settings: {} as Record<string, string>,
    secrets: {} as Record<string, string>,
  })
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const canManage = can('settings.manage')

  const load = useCallback(async () => {
    const res = await getPaymentSettings(getAccessToken)
    if (res.kind !== 'ok') return
    setData(res.data)
    setDraft({
      enabled: res.data.enabled,
      provider: res.data.provider,
      currency: res.data.currency,
      settings: { ...res.data.settings },
      secrets: {},
    })
  }, [getAccessToken])
  useEffect(() => {
    void load()
  }, [load])

  if (!data) return <div className="skeleton" style={{ height: 160 }} />
  const fields = draft.provider ? data.fields[draft.provider] : { settings: [], secrets: [] }

  const save = async () => {
    setSaving(true)
    setStatus(null)
    const res = await savePaymentSettings(getAccessToken, draft)
    setSaving(false)
    if (res.kind === 'ok') {
      setData(res.data)
      setDraft((d) => ({ ...d, secrets: {} }))
      setStatus({ tone: 'ok', text: t('payments.settings.saved') })
    } else {
      const key = `payments.error.${res.error}` as TranslationKey
      const text = t(key)
      setStatus({ tone: 'error', text: text === key ? t('payments.error.generic') : text })
    }
  }

  const input = (name: string) => {
    const secret = SECRET_FIELDS.has(name)
    const value = secret ? (draft.secrets[name] ?? '') : (draft.settings[name] ?? '')
    const set = (v: string) =>
      setDraft((d) => (secret ? { ...d, secrets: { ...d.secrets, [name]: v } } : { ...d, settings: { ...d.settings, [name]: v } }))
    const label = t(`payments.field.${name}` as TranslationKey)
    if (name === 'region') {
      return (
        <label className="field" key={name}>
          <span>{label}</span>
          <select className="select" value={value || 'jordan'} onChange={(e) => set(e.target.value)} disabled={!canManage}>
            {data.paytabsRegions.map((r) => (
              <option key={r} value={r}>
                {t(`payments.region.${r}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
      )
    }
    if (name === 'mode') {
      return (
        <label className="field" key={name}>
          <span>{label}</span>
          <select className="select" value={value || 'test'} onChange={(e) => set(e.target.value)} disabled={!canManage}>
            <option value="test">{t('payments.mode.test')}</option>
            <option value="live">{t('payments.mode.live')}</option>
          </select>
        </label>
      )
    }
    return (
      <label className="field" key={name}>
        <span>{label}</span>
        <input
          className="input mono"
          type={secret ? 'password' : 'text'}
          autoComplete="off"
          dir="ltr"
          value={value}
          placeholder={
            secret && data.secretsSet[name] && draft.provider === data.provider
              ? t('payments.secret.stored')
              : name === 'brands'
                ? 'VISA MASTER MADA'
                : ''
          }
          onChange={(e) => set(e.target.value)}
          disabled={!canManage}
        />
      </label>
    )
  }

  return (
    <section className="card">
      <h2 className="card__title">{t('settings.section.payments')}</h2>
      <p className="card__hint">{t('payments.settings.hint')}</p>
      <div className="field-grid">
        <label className="field">
          <span>{t('payments.field.provider')}</span>
          <select
            className="input"
            value={draft.provider ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, provider: (e.target.value || null) as ProviderKey | null, settings: {}, secrets: {} }))
            }
            disabled={!canManage}
          >
            <option value="">{t('payments.provider.none')}</option>
            {data.providers.map((p) => (
              <option key={p} value={p}>
                {t(`payments.provider.${p}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('payments.field.currency')}</span>
          <select
            className="select"
            value={draft.currency}
            onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
            disabled={!canManage}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {[...fields.settings, ...fields.secrets].map(input)}
      </div>
      {draft.provider === 'test' && <p className="card__hint">{t('payments.provider.testHint')}</p>}
      <label className="checkbox-inline" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          disabled={!canManage}
        />
        <span>{t('payments.field.enabled')}</span>
      </label>
      {status && (
        <p className={status.tone === 'ok' ? 'notice' : 'notice notice--warn'} role="status">
          {status.text}
        </p>
      )}
      {canManage && (
        <div className="page__actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            {t('payments.settings.save')}
          </button>
        </div>
      )}
    </section>
  )
}
