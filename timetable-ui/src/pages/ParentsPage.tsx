import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Parent, ParentStatus } from '../domain/parents'
import { archiveParent, listParents, reactivateParent } from '../lib/parentsApi'
import { ReasonDialog } from '../components/ReasonDialog'
import { listClasses } from '../lib/classesApi'
import type { SchoolClass } from '../domain/classes'
import { ParentDetailDialog } from '../components/ParentDetailDialog'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

type StatusFilter = ParentStatus | 'ALL'

export function ParentsPage() {
  const { t, n } = useI18n()
  const { branches } = useApp()
  const { getAccessToken } = useAuth()

  const [parents, setParents] = useState<Parent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [studentName, setStudentName] = useState('')
  const [branchId, setBranchId] = useState('')
  const [gradeLevel, setGradeLevel] = useState('')
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [classes, setClasses] = useState<SchoolClass[]>([])

  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()

  // Deep-link from GlobalSearch: ?parent=<id> opens that parent's detail
  // dialog, then the param is dropped so it doesn't reopen on a later visit.
  useEffect(() => {
    const id = searchParams.get('parent')
    if (!id) return
    setOpenId(id)
    setSearchParams(
      (prev) => {
        prev.delete('parent')
        return prev
      },
      { replace: true },
    )
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (!branchId) {
      setClasses([])
      return
    }
    let cancelled = false
    void (async () => {
      const result = await listClasses(getAccessToken, { branchId })
      if (!cancelled && result.kind === 'ok') setClasses(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [branchId, getAccessToken])

  const gradeLevels = useMemo(
    () => [...new Set(classes.map((c) => c.gradeLevel))].sort(),
    [classes],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await listParents(getAccessToken, {
      search: search.trim() || undefined,
      studentName: studentName.trim() || undefined,
      branchId: branchId || undefined,
      gradeLevel: gradeLevel || undefined,
      status: status === 'ALL' ? undefined : status,
    })
    setLoading(false)
    if (result.kind === 'ok') setParents(result.data)
    else setError(t('parents.loadError'))
  }, [getAccessToken, search, studentName, branchId, gradeLevel, status, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Archiving asks why (SAMS 1.12); reactivating is routine.
  const [archiving, setArchiving] = useState<Parent | null>(null)
  const toggleArchive = async (parent: Parent) => {
    if (parent.status !== 'archived') return setArchiving(parent)
    const result = await reactivateParent(getAccessToken, parent.id)
    if (result.kind === 'ok') void refresh()
  }
  const confirmArchive = async (reason: string): Promise<string | null> => {
    if (!archiving) return null
    const result = await archiveParent(getAccessToken, archiving.id, reason)
    if (result.kind !== 'ok') return t('parents.error.generic')
    setArchiving(null)
    void refresh()
    return null
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('parents.title')}</h1>
          <p className="page__subtitle">{t('parents.subtitle')}</p>
        </div>
        <div className="page__actions">
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            {t('parents.add')}
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="break-card__row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input
            className="input"
            style={{ minWidth: 220, flex: 1 }}
            placeholder={t('parents.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <input
            className="input"
            style={{ minWidth: 180 }}
            placeholder={t('parents.searchStudent')}
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
          />
          <select className="input" value={branchId} onChange={(e) => { setBranchId(e.target.value); setGradeLevel('') }}>
            <option value="">{t('parents.filter.allBranches')}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select className="input" value={gradeLevel} onChange={(e) => setGradeLevel(e.target.value)} disabled={!branchId}>
            <option value="">{t('parents.filter.allGrades')}</option>
            {gradeLevels.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="ALL">{t('parents.filter.allStatuses')}</option>
            <option value="active">{t('parents.status.active')}</option>
            <option value="inactive">{t('parents.status.inactive')}</option>
            <option value="archived">{t('parents.status.archived')}</option>
          </select>
        </div>
      </div>

      {loading && <p className="card__hint">{t('parents.loading')}</p>}
      {error && <p className="login__error">{error}</p>}

      {!loading && parents.length === 0 && <div className="panel">{t('parents.none')}</div>}

      {!loading && parents.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('parents.col.name')}</th>
              <th>{t('parents.col.phone')}</th>
              <th>{t('parents.col.email')}</th>
              <th>{t('parents.col.students')}</th>
              <th>{t('parents.col.status')}</th>
              <th style={{ width: 100 }} />
            </tr>
          </thead>
          <tbody>
            {parents.map((parent) => (
              <tr key={parent.id}>
                <td>
                  <button type="button" className="btn btn--ghost btn--sm" style={{ padding: 0, fontWeight: 600 }} onClick={() => setOpenId(parent.id)}>
                    {parent.fullName}
                  </button>
                </td>
                <td className="mono">{parent.primaryPhone}</td>
                <td>{parent.email ?? '—'}</td>
                <td>{n(parent.linkedStudentCount)}</td>
                <td>
                  <span className={`chip${parent.status === 'active' ? ' chip--on' : ''}`}>
                    {t(`parents.status.${parent.status}` as TranslationKey)}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="icon-btn" onClick={() => void toggleArchive(parent)} aria-label={t(parent.status === 'archived' ? 'parents.reactivate' : 'parents.archive')} title={t(parent.status === 'archived' ? 'parents.reactivate' : 'parents.archive')}>
                      {parent.status === 'archived' ? '↺' : '🗄'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(creating || openId) && (
        <ParentDetailDialog
          parentId={openId}
          onClose={() => {
            setCreating(false)
            setOpenId(null)
          }}
          onSaved={() => {
            void refresh()
          }}
        />
      )}
      {archiving && (
        <ReasonDialog
          title={`${t('parents.archive')} · ${archiving.fullName}`}
          confirmLabel={t('parents.archive')}
          onConfirm={confirmArchive}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  )
}
