import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { listLookups, lookupLabel, type LookupItem, type LookupKind } from './settingsApi'

/** A settings list (1.11), inactive codes included so history still labels
 * them; `active` is what new records may use. */
export function useLookup(kind: LookupKind) {
  const { getAccessToken } = useAuth()
  const { lang } = useI18n()
  const [items, setItems] = useState<LookupItem[]>([])
  useEffect(() => {
    let live = true
    void listLookups(getAccessToken, kind, true).then((res) => live && res.kind === 'ok' && setItems(res.data))
    return () => {
      live = false
    }
  }, [getAccessToken, kind])
  return {
    items,
    active: items.filter((i) => i.active),
    label: (code: string | null | undefined) => (code ? lookupLabel(items, code, lang) : '—'),
  }
}
