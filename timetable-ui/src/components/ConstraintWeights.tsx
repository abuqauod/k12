import type { ConstraintWeights as Weights, Problem } from '../domain/types'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

const WEIGHT_FIELDS: Array<{ key: keyof Weights; label: TranslationKey; hint: TranslationKey }> = [
  {
    key: 'teacherContinuity',
    label: 'tuning.teacherContinuity',
    hint: 'tuning.teacherContinuityHint',
  },
  {
    key: 'studentContinuity',
    label: 'tuning.studentContinuity',
    hint: 'tuning.studentContinuityHint',
  },
  {
    key: 'subjectDistribution',
    label: 'tuning.subjectDistribution',
    hint: 'tuning.subjectDistributionHint',
  },
  {
    key: 'teacherRoomStability',
    label: 'tuning.teacherRoomStability',
    hint: 'tuning.teacherRoomStabilityHint',
  },
  {
    key: 'studentRoomStability',
    label: 'tuning.studentRoomStability',
    hint: 'tuning.studentRoomStabilityHint',
  },
]

/**
 * Soft-constraint weights. Hard constraints are not negotiable, so only the
 * soft ones are exposed — these reorder the soft score, nothing else.
 */
export function ConstraintWeightsEditor({
  problem,
  onChange,
}: {
  problem: Problem
  onChange: (next: Problem) => void
}) {
  const { t } = useI18n()

  return (
    <div className="weights">
      {WEIGHT_FIELDS.map((field) => (
        <label className="weight" key={field.key}>
          <span>
            {t(field.label)}
            <small>{t(field.hint)}</small>
          </span>
          <input
            className="input cell-input--num"
            type="number"
            min={0}
            max={99}
            value={problem.weights[field.key]}
            onChange={(event) =>
              onChange({
                ...problem,
                weights: {
                  ...problem.weights,
                  [field.key]: Math.max(0, Number(event.target.value) || 0),
                },
              })
            }
          />
        </label>
      ))}
    </div>
  )
}
