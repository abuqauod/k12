import { useCallback, useEffect, useState } from 'react'
import { listIncidents, type Incident, type IncidentStatus } from '../lib/wellbeingApi'
import { IncidentForm, IncidentList } from '../components/wellbeing/Behaviour'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/** Behaviour incidents (backlog). A teacher logs one and follows their own;
 * with `discipline.manage` every incident in the branch shows, with the
 * actions, the family notice and closing. */
export function BehaviourPage() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [status, setStatus] = useState<IncidentStatus | ''>('open')
  const [data, setData] = useState<{ incidents: Incident[]; canManage: boolean } | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const res = await listIncidents(getAccessToken, { branchId: activeBranchId ?? undefined, status: status || undefined })
    setData(res.kind === 'ok' ? res.data : { incidents: [], canManage: false })
  }, [getAccessToken, activeBranchId, status])
  useEffect(() => {
    void load()
  }, [load])

  const changed = (i: Incident) => setData((d) => (d ? { ...d, incidents: d.incidents.map((x) => (x.id === i.id ? i : x)) } : d))

  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.behaviour')}</h1>
          <p className="page__subtitle">{data?.canManage ? t('wb.inc.subtitleManage') : t('wb.inc.subtitleOwn')}</p>
        </div>
        {!adding && (
          <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
            + {t('wb.inc.new')}
          </button>
        )}
      </header>
      {adding && (
        <section className="card">
          <div className="card__head">
            <h2 className="card__title">{t('wb.inc.new')}</h2>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              {t('docs.cancel')}
            </button>
          </div>
          <IncidentForm
            branchId={activeBranchId ?? undefined}
            onSaved={() => {
              setAdding(false)
              void load()
            }}
          />
        </section>
      )}
      <section className="card">
        <div className="card__head">
          <div className="segmented" role="group" aria-label={t('rep.f.status')}>
            {(['open', 'resolved', 'dismissed', ''] as const).map((s) => (
              <button key={s || 'all'} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s ? t(`wb.incStatus.${s}` as TranslationKey) : t('rep.f.all')}
              </button>
            ))}
          </div>
        </div>
        {data === null ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : (
          <IncidentList incidents={data.incidents} canManage={data.canManage} onChanged={changed} />
        )}
      </section>
    </div>
  )
}
