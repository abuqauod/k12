import { authorizedFetch, type TokenGetter } from './http'
import { loadSyncSettings } from './sync'
import { qs } from './apiClient'

/**
 * Opens printable ID cards (backlog) in a new tab and starts printing.
 * The tab is opened before the request, while the click still counts as
 * the user's, so a pop-up blocker lets it through.
 */
export async function printIdCards(
  getToken: TokenGetter,
  kind: 'students' | 'employees',
  params: { branchId?: string | null; classId?: string; ids?: string[]; layout: 'sheet' | 'card'; lang: 'en' | 'ar' },
): Promise<boolean> {
  const win = window.open('', '_blank')
  const base = loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
  const query = qs({ branchId: params.branchId, classId: params.classId, ids: params.ids?.join(','), layout: params.layout, lang: params.lang, autoprint: '1' })
  try {
    const res = await authorizedFetch(`${base}/id-cards/${kind}${query}`, { method: 'GET' }, getToken, 120_000)
    if (!res.ok) throw new Error(String(res.status))
    const url = URL.createObjectURL(await res.blob())
    if (win) win.location.href = url
    else window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  } catch {
    win?.close()
    return false
  }
}
