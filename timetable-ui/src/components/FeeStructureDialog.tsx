import { listClasses } from '../lib/classesApi'
import { useEffect, useState } from 'react'
import type { FeeStructureLineItem } from '../domain/finance'
import { emptyFeeStructureLine, formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { createFeeStructure, deactivateFeeStructure, updateFeeStructure } from '../lib/financeApi'
import type { NewFeeStructure } from '../lib/financeApi'
import type { TokenGetter } from '../lib/http'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'

/** Create or edit a fee structure — a branch/year/grade price list. */
export function FeeStructureDialog({
  structure,
  branchId,
  academicYearId,
  getAccessToken,
  onClose,
  onSaved,
}: {
  /** null = create mode. */
  structure: (NewFeeStructure & { id: string }) | null
  branchId: string
  academicYearId: string
  getAccessToken: TokenGetter
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const { branches } = useApp()

  const [gradeLevel, setGradeLevel] = useState(structure?.gradeLevel ?? '')
  // SAMS 12 (pilot): the grade must match the classes' grade exactly, or
  // "Bill grade" finds nobody — offer the grades that exist.
  const [grades, setGrades] = useState<string[]>([])
  useEffect(() => {
    void listClasses(getAccessToken, { branchId }).then(
      (r) => r.kind === 'ok' && setGrades([...new Set(r.data.filter((c) => c.active && c.academicYearId === academicYearId).map((c) => c.gradeLevel))].sort()),
    )
  }, [getAccessToken, branchId, academicYearId])
  const [name, setName] = useState(structure?.name ?? '')
  const [lines, setLines] = useState<FeeStructureLineItem[]>(structure?.lineItems ?? [emptyFeeStructureLine()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const branchName = branches.find((b) => b.id === branchId)?.name ?? branchId
  const total = lines.reduce((sum, line) => sum + (line.amount || 0), 0)

  const patchLine = (index: number, changes: Partial<FeeStructureLineItem>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...changes } : line)))

  const save = async () => {
    if (!gradeLevel.trim() || !name.trim()) return
    setSaving(true)
    setError(null)
    const cleanLines = lines.filter((line) => line.label.trim() && line.amount > 0)
    const result = structure
      ? await updateFeeStructure(getAccessToken, structure.id, { name: name.trim(), lineItems: cleanLines })
      : await createFeeStructure(getAccessToken, {
          branchId,
          academicYearId,
          gradeLevel: gradeLevel.trim(),
          name: name.trim(),
          lineItems: cleanLines,
        })
    setSaving(false)
    if (result.kind === 'ok') {
      onSaved()
    } else {
      setError(t('billing.error.generic'))
    }
  }

  const deactivate = async () => {
    if (!structure) return
    const result = await deactivateFeeStructure(getAccessToken, structure.id)
    if (result.kind === 'ok') onSaved()
  }

  return (
    <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog__panel" style={{ maxWidth: 520 }}>
        <div className="dialog__head">
          <strong>{structure ? structure.name : t('billing.feeStructure.new')}</strong>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {t('parents.close')}
          </button>
        </div>
        <div className="dialog__body" style={{ display: 'grid', gap: 12 }}>
          <p className="card__hint" style={{ margin: 0 }}>{branchName}</p>
          <div className="break-card__row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="field" style={{ minWidth: 160 }}>
              <span>{t('billing.feeStructure.gradeLevel')}</span>
              <input
                className="input"
                list="fee-grade-options"
                value={gradeLevel}
                disabled={Boolean(structure)}
                onChange={(e) => setGradeLevel(e.target.value)}
              />
              <datalist id="fee-grade-options">
                {grades.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
              {!structure && gradeLevel.trim() && grades.length > 0 && !grades.includes(gradeLevel.trim()) && (
                <small className="text-bad">{t('billing.feeStructure.noSuchGrade')}</small>
              )}
            </label>
            <label className="field" style={{ minWidth: 200 }}>
              <span>{t('billing.feeStructure.name')}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>

          <div>
            <h3 className="card__subtitle" style={{ marginTop: 0 }}>{t('billing.lineItems')}</h3>
            {lines.map((line, index) => (
              <div key={line.id ?? index} className="break-card__row" style={{ gap: 6, marginBottom: 6 }}>
                <input
                  className="input input--sm"
                  style={{ flex: 1 }}
                  placeholder={t('billing.col.label')}
                  value={line.label}
                  onChange={(e) => patchLine(index, { label: e.target.value })}
                />
                <input
                  className="input input--sm"
                  style={{ maxWidth: 100 }}
                  placeholder={t('billing.col.amount')}
                  value={line.amount ? formatMinorUnits(line.amount) : ''}
                  onChange={(e) => patchLine(index, { amount: parseMinorUnits(e.target.value) ?? 0 })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                  aria-label={t('billing.removeLine')}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="btn btn--sm" onClick={() => setLines((current) => [...current, emptyFeeStructureLine()])}>
              {t('billing.addLine')}
            </button>
          </div>

          <div className="stat-row" style={{ borderTop: '1px solid var(--line)' }}>
            <span>{t('billing.col.total')}</span>
            <b>{formatMinorUnits(total)}</b>
          </div>

          {error && <p className="login__error">{error}</p>}
          <div className="page__actions">
            {structure && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void deactivate()}>
                {t('billing.feeStructure.deactivate')}
              </button>
            )}
            <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void save()}>
              {saving ? t('parents.saving') : t('parents.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
