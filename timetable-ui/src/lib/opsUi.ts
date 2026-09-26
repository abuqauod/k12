import type { TranslationKey } from '../i18n/translations'

/** Shared by the operations pages (SAMS Phase 5). */

export const ASSET_TONE: Record<string, string> = { in_stock: 'chip--ok', assigned: 'chip--on', maintenance: 'chip--warn', disposed: '' }
export const MAINT_TONE: Record<string, string> = {
  open: 'chip--warn',
  in_progress: 'chip--on',
  resolved: 'chip--ok',
  closed: '',
  cancelled: '',
}
export const PRIORITY_TONE: Record<string, string> = { low: '', normal: '', high: 'chip--warn', urgent: 'chip--bad' }
export const EVENT_TONE: Record<string, string> = {
  draft: '',
  open: 'chip--ok',
  closed: 'chip--warn',
  completed: 'chip--on',
  cancelled: '',
}

/** Server error codes → messages. */
export function opsError(t: (key: TranslationKey) => string, code: string): string {
  const key = `ops.error.${code}` as TranslationKey
  const text = t(key)
  return text === key ? t('billing.error.generic') : text
}
