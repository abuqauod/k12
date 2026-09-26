import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listInbox, markAllRead, markRead, type InboxItem } from '../lib/communicationApi'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'

/**
 * The in-app inbox (SAMS 6.1), for staff and portal parents alike: a count
 * of unread items and a panel listing the latest. Opening an item marks it
 * read and follows its link. Refreshes every minute and on focus.
 */
export function InboxBell() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState<InboxItem[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const res = await listInbox(getAccessToken)
    if (res.kind === 'ok') {
      setItems(res.data.items)
      setUnread(res.data.unread)
    }
  }, [getAccessToken])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openItem = async (item: InboxItem) => {
    if (!item.readAt) await markRead(getAccessToken, item.id)
    setOpen(false)
    await load()
    if (item.link) navigate(item.link)
  }

  return (
    <div className="inbox" ref={ref}>
      <button
        type="button"
        className="btn btn--sm inbox__bell"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread ? t('inbox.unreadLabel', { count: unread }) : t('inbox.title')}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="inbox__count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="inbox__panel" role="dialog" aria-label={t('inbox.title')}>
          <div className="inbox__head">
            <b>{t('inbox.title')}</b>
            {unread > 0 && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void markAllRead(getAccessToken).then(load)}>
                {t('inbox.markAll')}
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="empty-state">{t('inbox.empty')}</p>
          ) : (
            <ul className="inbox__list">
              {items.slice(0, 30).map((item) => (
                <li key={item.id}>
                  <button type="button" className={`inbox__item${item.readAt ? '' : ' is-unread'}`} onClick={() => void openItem(item)}>
                    <b>{item.title}</b>
                    <span className="inbox__body">{item.body}</span>
                    <small className="card__hint">{new Date(item.createdAt).toLocaleString()}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
