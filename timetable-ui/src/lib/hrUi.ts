import type { TranslationKey } from '../i18n/translations'

/** Shared by the HR pages. */

export const CONTRACT_TONE: Record<string, string> = {
  upcoming: '',
  active: 'chip--ok',
  expiring: 'chip--warn',
  expired: 'chip--bad',
  renewed: '',
  terminated: '',
  ended: '',
}
export const LEAVE_TONE: Record<string, string> = { pending: 'chip--warn', approved: 'chip--ok', rejected: 'chip--bad', cancelled: '' }

/** Server error codes → messages. */
export function hrError(t: (key: TranslationKey) => string, code: string): string {
  const key = `hr.error.${code}` as TranslationKey
  const text = t(key)
  return text === key ? t('billing.error.generic') : text
}
