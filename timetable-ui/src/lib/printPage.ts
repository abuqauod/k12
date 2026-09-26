import { authorizedFetch, type TokenGetter } from './http'
import { loadSyncSettings } from './sync'

/**
 * Opens a page the API renders (report cards, SAMS 11.2) in a new tab. The
 * tab is opened before the request, while the click still counts as the
 * user's, so a pop-up blocker lets it through.
 */
export async function openApiPage(getToken: TokenGetter, path: string): Promise<boolean> {
  const win = window.open('', '_blank')
  const base = loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
  try {
    const res = await authorizedFetch(`${base}${path}`, { method: 'GET' }, getToken, 120_000)
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
