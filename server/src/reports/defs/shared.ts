import type { Filter } from 'mongodb'
import type { StudentDoc, TenantContext } from '../../db.js'
import { inBranches, tx } from '../common.js'
import type { RunInput } from '../types.js'

/** The grade / class filters as class ids; null = no such filter. */
export async function classFilter(ctx: TenantContext, input: RunInput): Promise<string[] | null> {
  const { gradeLevel, classId } = input.filters
  if (!gradeLevel && !classId) return null
  const classes = await ctx.classes
    .find({
      ...inBranches(input.branchIds),
      ...(gradeLevel ? { gradeLevel } : {}),
      ...(classId ? { _id: classId } : {}),
    })
    .toArray()
  return classes.map((c) => c._id)
}

/** Students in the run's branches, year, grade and class (by their current
 * place). */
export async function studentsInScope(ctx: TenantContext, input: RunInput, extra: Filter<StudentDoc> = {}): Promise<StudentDoc[]> {
  const classIds = await classFilter(ctx, input)
  return ctx.students
    .find({
      ...inBranches(input.branchIds),
      ...(input.filters.academicYearId ? { academicYearId: input.filters.academicYearId } : {}),
      ...(classIds ? { classId: { $in: classIds } } : {}),
      ...extra,
    })
    .toArray()
}

/** The year asked for, else the current one. */
export async function yearOrCurrent(ctx: TenantContext, input: RunInput): Promise<string | null> {
  if (input.filters.academicYearId) return input.filters.academicYearId
  return (await ctx.academicYears.findOne({ current: true }))?._id ?? null
}

export const TOTAL = tx('Total', 'المجموع')
