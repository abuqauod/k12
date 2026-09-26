import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { portalAnnouncements, type PortalAnnouncement } from '../lib/portalApi'
import { listInbox, markRead, type InboxItem } from '../lib/communicationApi'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { usePortal } from './PortalShell'

/** The portal's front page: the parent's children, the school's
 * announcements to them, and their messages. */

type Tab = 'children' | 'announcements' | 'messages'
const TABS: Tab[] = ['children', 'announcements', 'messages']

export function PortalHome() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'children') as Tab
  return (
    <>
      <div className="tabs" role="tablist" aria-label={t('portal.title')}>
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className="tabs__tab"
            onClick={() => setParams({ tab: x }, { replace: true })}
          >
            {t(`portal.tab.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'children' && <Children />}
        {tab === 'announcements' && <Announcements />}
        {tab === 'messages' && <Messages />}
      </div>
    </>
  )
}

function Children() {
  const { t, lang } = useI18n()
  const { me } = usePortal()
  if (!me) return <div className="skeleton" style={{ height: 120 }} />
  if (me.children.length === 0) return <div className="empty-state">{t('portal.noChildren')}</div>
  return (
    <ul className="portal-cards">
      {me.children.map((c) => (
        <li key={c.id}>
          <Link to={`/portal/children/${c.id}`} className="portal-card">
            <span className="avatar" aria-hidden="true">
              {c.name
                .split(' ')
                .map((p) => p[0])
                .slice(0, 2)
                .join('')}
            </span>
            <span className="portal-card__text">
              <b>{(lang === 'ar' && c.nameAr) || c.name}</b>
              <small>
                {[c.className, c.branchName].filter(Boolean).join(' · ')}
                {c.status !== 'enrolled' && ` · ${t(`portal.status.${c.status}` as TranslationKey)}`}
              </small>
            </span>
            <span aria-hidden="true" className="portal-card__go">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Announcements() {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [rows, setRows] = useState<PortalAnnouncement[] | null>(null)
  useEffect(() => {
    void portalAnnouncements(getAccessToken).then((r) => setRows(r.kind === 'ok' ? r.data.announcements : []))
  }, [getAccessToken])
  if (rows === null) return <div className="skeleton" style={{ height: 120 }} />
  if (rows.length === 0) return <div className="empty-state">{t('portal.noAnnouncements')}</div>
  return (
    <ul className="portal-feed">
      {rows.map((a) => {
        const ar = lang === 'ar'
        return (
          <li key={a.id} className="card">
            <h3 className="card__title">{(ar && a.titleAr) || a.title}</h3>
            {a.publishedAt && <small className="card__hint">{new Date(a.publishedAt).toLocaleDateString()}</small>}
            <p className="comm-body">{(ar && a.bodyAr) || a.body}</p>
          </li>
        )
      })}
    </ul>
  )
}

function Messages() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [rows, setRows] = useState<InboxItem[] | null>(null)
  const load = () => void listInbox(getAccessToken).then((r) => setRows(r.kind === 'ok' ? r.data.items : []))
  useEffect(load, [getAccessToken])
  if (rows === null) return <div className="skeleton" style={{ height: 120 }} />
  if (rows.length === 0) return <div className="empty-state">{t('inbox.empty')}</div>
  return (
    <ul className="portal-feed">
      {rows.map((m) => (
        <li key={m.id} className={`card${m.readAt ? '' : ' is-unread'}`}>
          <h3 className="card__title">{m.title}</h3>
          <small className="card__hint">{new Date(m.createdAt).toLocaleString()}</small>
          <p className="comm-body">{m.body}</p>
          <div className="inline-form">
            {m.link && (
              <Link to={m.link} className="btn btn--sm" onClick={() => !m.readAt && void markRead(getAccessToken, m.id)}>
                {t('portal.open')}
              </Link>
            )}
            {!m.readAt && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void markRead(getAccessToken, m.id).then(load)}>
                {t('portal.markRead')}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
