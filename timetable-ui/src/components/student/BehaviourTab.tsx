import { useCallback, useEffect, useState } from 'react'
import type { Student } from '../../domain/students'
import { listIncidents, type Incident } from '../../lib/wellbeingApi'
import { IncidentForm, IncidentList } from '../wellbeing/Behaviour'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'

/** The student profile's Behaviour tab: incidents about this student (all of
 * them for a manager, the ones you logged otherwise) and a quick report. */
export function BehaviourTab({ student }: { student: Student }) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [data, setData] = useState<{ incidents: Incident[]; canManage: boolean } | null>(null)
  const load = useCallback(async () => {
    const res = await listIncidents(getAccessToken, { studentId: student.id })
    setData(res.kind === 'ok' ? res.data : { incidents: [], canManage: false })
  }, [getAccessToken, student.id])
  useEffect(() => {
    void load()
  }, [load])
  const name = `${student.givenName} ${student.familyName}`.trim()
  return (
    <div className="card-row card-row--wide-first">
      <section className="card profile-card">
        <h2 className="card__title">{t('wb.inc.history')}</h2>
        {data === null ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : (
          <IncidentList
            incidents={data.incidents}
            canManage={data.canManage}
            onChanged={(i) => setData((d) => (d ? { ...d, incidents: d.incidents.map((x) => (x.id === i.id ? i : x)) } : d))}
          />
        )}
      </section>
      <section className="card profile-card">
        <h2 className="card__title">{t('wb.inc.new')}</h2>
        <IncidentForm preset={{ type: 'student', id: student.id, label: name }} onSaved={() => void load()} />
      </section>
    </div>
  )
}
