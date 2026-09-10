import { useCallback, useEffect, useMemo, useState } from 'react'
import { byGrade } from '../domain/classes'
import type { SchoolClass } from '../domain/classes'
import {
  createClass,
  createSections,
  deleteClass,
  listClasses,
  updateClass,
} from '../lib/classesApi'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'

export function ClassesPage() {
  const { t, n } = useI18n()
  const { branches, activeBranchId } = useApp()
  const { getAccessToken } = useAuth()

  const [classes, setClasses] = useState<SchoolClass[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newGrade, setNewGrade] = useState('')
  const [newSections, setNewSections] = useState('')
  const [newCapacity, setNewCapacity] = useState(30)
  const [busy, setBusy] = useState(false)

  const branchName = branches.find((b) => b.id === activeBranchId)?.name ?? ''

  const refresh = useCallback(async () => {
    if (!activeBranchId) {
      setClasses([])
      setLoading(false)
      return
    }
    setLoading(true)
    const token = await getAccessToken()
    if (!token) {
      setLoading(false)
      return
    }
    const result = await listClasses(token, { branchId: activeBranchId, includeInactive: true })
    setLoading(false)
    if (result.kind === 'ok') setClasses(result.data)
    else setError(t('classes.saveError'))
  }, [activeBranchId, getAccessToken, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const grouped = useMemo(
    () => byGrade(classes.filter((c) => showArchived || c.active)),
    [classes, showArchived],
  )

  const addSections = async () => {
    if (!activeBranchId || !newGrade.trim()) return
    const sections = newSections
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (sections.length === 0) return
    setBusy(true)
    setError(null)
    const token = await getAccessToken()
    if (!token) {
      setBusy(false)
      return
    }
    const result = await createSections(token, {
      branchId: activeBranchId,
      gradeLevel: newGrade.trim(),
      capacity: newCapacity,
      sections,
    })
    setBusy(false)
    if (result.kind === 'ok') {
      setNewGrade('')
      setNewSections('')
      void refresh()
    } else {
      setError(t('classes.saveError'))
    }
  }

  const addOne = async (gradeLevel: string) => {
    if (!activeBranchId) return
    const token = await getAccessToken()
    if (!token) return
    const result = await createClass(token, {
      branchId: activeBranchId,
      gradeLevel,
      name: nextSectionName(classes, gradeLevel),
      capacity: 30,
    })
    if (result.kind === 'ok') void refresh()
    else setError(t('classes.saveError'))
  }

  const patch = async (id: string, changes: Parameters<typeof updateClass>[2]) => {
    setClasses((current) =>
      current.map((c) => (c.id === id ? { ...c, ...changes } : c)),
    )
    const token = await getAccessToken()
    if (!token) return
    const result = await updateClass(token, id, changes)
    if (result.kind === 'ok') {
      setClasses((current) => current.map((c) => (c.id === id ? result.data : c)))
    } else {
      setError(t('classes.saveError'))
      void refresh()
    }
  }

  const remove = async (klass: SchoolClass) => {
    if (klass.enrolled > 0) {
      setError(t('classes.deleteHasStudents'))
      return
    }
    const token = await getAccessToken()
    if (!token) return
    const result = await deleteClass(token, klass.id)
    if (result.kind === 'ok') setClasses((current) => current.filter((c) => c.id !== klass.id))
    else setError(t('classes.saveError'))
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            {t('nav.classes')}
            {branchName && ` · ${branchName}`}
          </h1>
          <p className="page__subtitle">{t('classes.subtitle')}</p>
        </div>
        <label className="inline-field">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          {t('classes.showArchived')}
        </label>
      </header>

      {branches.length === 0 && <div className="empty-state">{t('classes.noBranch')}</div>}
      {error && <p className="card__hint" style={{ color: 'var(--bad)' }}>{error}</p>}

      {activeBranchId && (
        <div className="card">
          <h3 className="card__subtitle" style={{ marginTop: 0 }}>{t('classes.addSections')}</h3>
          <div className="page__actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input
              className="input"
              style={{ minWidth: 160 }}
              placeholder={t('classes.gradePlaceholder')}
              value={newGrade}
              onChange={(event) => setNewGrade(event.target.value)}
            />
            <input
              className="input"
              style={{ minWidth: 160 }}
              placeholder={t('classes.sectionsPlaceholder')}
              value={newSections}
              onChange={(event) => setNewSections(event.target.value)}
            />
            <input
              className="input input--sm"
              type="number"
              min={1}
              max={200}
              value={newCapacity}
              onChange={(event) => setNewCapacity(Number(event.target.value) || 1)}
              aria-label={t('classes.capacity')}
            />
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void addSections()}>
              {t('classes.add')}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="empty-state">{t('classes.loading')}</div>}
      {!loading && activeBranchId && grouped.length === 0 && (
        <div className="empty-state">{t('classes.none')}</div>
      )}

      {grouped.map((group) => (
        <div className="card" key={group.gradeLevel}>
          <div className="page__actions" style={{ marginBlockEnd: 8 }}>
            <h3 className="card__subtitle" style={{ margin: 0, flex: 1 }}>{group.gradeLevel}</h3>
            <button type="button" className="btn btn--sm" onClick={() => void addOne(group.gradeLevel)}>
              {t('classes.add')}
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>{t('classes.section')}</th>
                  <th style={{ width: 120 }}>{t('classes.enrolled')}</th>
                  <th style={{ width: 120 }}>{t('classes.capacity')}</th>
                  <th />
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {group.sections.map((klass) => (
                  <tr key={klass.id} style={{ opacity: klass.active ? 1 : 0.55 }}>
                    <td>
                      <input
                        className="cell-input"
                        value={klass.name}
                        onChange={(event) =>
                          setClasses((current) =>
                            current.map((c) => (c.id === klass.id ? { ...c, name: event.target.value } : c)),
                          )
                        }
                        onBlur={(event) => void patch(klass.id, { name: event.target.value.trim() || klass.name })}
                      />
                    </td>
                    <td>
                      <span style={{ color: klass.enrolled > klass.capacity ? 'var(--bad)' : undefined }}>
                        {n(klass.enrolled)}
                        {klass.enrolled > klass.capacity && ` · ${t('classes.over')}`}
                      </span>
                    </td>
                    <td>
                      <input
                        className="cell-input"
                        type="number"
                        min={1}
                        max={200}
                        value={klass.capacity}
                        onChange={(event) =>
                          setClasses((current) =>
                            current.map((c) =>
                              c.id === klass.id ? { ...c, capacity: Number(event.target.value) || 1 } : c,
                            ),
                          )
                        }
                        onBlur={(event) =>
                          void patch(klass.id, { capacity: Math.max(1, Number(event.target.value) || 1) })
                        }
                      />
                    </td>
                    <td>
                      <label className="inline-field">
                        <input
                          type="checkbox"
                          checked={klass.active}
                          onChange={(event) => void patch(klass.id, { active: event.target.checked })}
                        />
                        {klass.active ? '' : t('classes.inactive')}
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => void remove(klass)}
                        aria-label={`${t('classes.delete')} ${group.gradeLevel} ${klass.name}`}
                        title={klass.enrolled > 0 ? t('classes.deleteHasStudents') : t('classes.delete')}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

/** "A" after "A"/"B" -> "C"; falls back to a number when sections aren't letters. */
function nextSectionName(classes: SchoolClass[], gradeLevel: string): string {
  const taken = new Set(
    classes.filter((c) => c.gradeLevel === gradeLevel).map((c) => c.name.toUpperCase()),
  )
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    if (!taken.has(letter)) return letter
  }
  return String(taken.size + 1)
}
