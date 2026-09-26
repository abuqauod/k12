import { useEffect, useState } from 'react'
import { listLookups, lookupLabel } from '../../lib/settingsApi'
import type { LookupItem } from '../../lib/settingsApi'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

/** Shared by the Phase 3 finance components. */

export const INSTALLMENT_TONE: Record<string, string> = {
  paid: 'chip--ok',
  partial: 'chip--warn',
  due: '',
  overdue: 'chip--bad',
}

export const RECORD_TONE: Record<string, string> = {
  pending: 'chip--warn',
  approved: 'chip--on',
  active: 'chip--ok',
  paid: 'chip--ok',
  rejected: 'chip--bad',
  cancelled: '',
  revoked: '',
}

/** Error codes from the Phase 3 routes with their own message. */
export function financeError(t: (key: TranslationKey) => string, code: string): string {
  const key = `fin.error.${code}` as TranslationKey
  const text = t(key)
  return text === key ? t('billing.error.generic') : text
}

/** The payment-method settings list (1.11), inactive codes included so history still labels them. */
export function usePaymentMethods() {
  const { getAccessToken } = useAuth()
  const { t, lang } = useI18n()
  const [methods, setMethods] = useState<LookupItem[]>([])
  useEffect(() => {
    void listLookups(getAccessToken, 'paymentMethod', true).then((res) => res.kind === 'ok' && setMethods(res.data))
  }, [getAccessToken])
  const label = (code: string) => lookupLabel(methods, code, lang, t(`billing.method.${code}` as TranslationKey))
  return { methods, active: methods.filter((m) => m.active), label }
}
