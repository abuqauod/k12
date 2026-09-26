import { branchNames, classNames, inBranches, studentLabel, tx } from '../common.js'
import { sumRows, type Cell, type ReportDefinition, type RunInput } from '../types.js'
import type { TenantContext } from '../../db.js'
import { classFilter, TOTAL } from './shared.js'

/** Attendance and admissions reports (SAMS 7.2). */

const COUNTED = ['present', 'late', 'absent', 'excused', 'early_departure'] as const

function recordFilter(input: RunInput, classIds: string[] | null) {
  return {
    ...inBranches(input.branchIds),
    ...(input.filters.academicYearId ? { academicYearId: input.filters.academicYearId } : {}),
    ...(classIds ? { classId: { $in: classIds } } : {}),
    date: { $gte: input.from!, $lte: input.to! },
  }
}

/** One row per group with a count per status, counted by the database: a
 * large school has hundreds of thousands of marks in a term (SAMS 10.3). */
interface Tallied {
  _id: string
  present: number
  late: number
  absent: number
  excused: number
  early_departure: number
  days: number
  branchId: string
  lastClassId: string
  schoolDays?: string[]
}

async function tallies(ctx: TenantContext, input: RunInput, by: 'studentId' | 'classId'): Promise<Tallied[]> {
  const classIds = await classFilter(ctx, input)
  const count = (status: string) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } })
  return ctx.attendance
    .aggregate<Tallied>(recordFilter(input, classIds), [
      {
        $group: {
          _id: `$${by}`,
          ...Object.fromEntries(COUNTED.map((s) => [s, count(s)])),
          days: { $sum: 1 },
          branchId: { $first: '$branchId' },
          lastClassId: { $top: { sortBy: { date: -1 }, output: '$classId' } },
          ...(by === 'classId' ? { schoolDays: { $addToSet: '$date' } } : {}),
        },
      },
    ])
    .toArray()
}

const tallyOf = (t: Tallied) => ({
  present: t.present,
  late: t.late,
  absent: t.absent,
  excused: t.excused,
  early_departure: t.early_departure,
  days: t.days,
})

/** Present, late and early departure count as attending. */
const rate = (row: Record<string, Cell>) => {
  const days = row.days as number
  return days > 0 ? ((row.present as number) + (row.late as number) + (row.early_departure as number)) / days : null
}

const STATUS_COLUMNS = [
  { key: 'present', label: tx('Present', 'حاضر'), type: 'number' as const },
  { key: 'late', label: tx('Late', 'متأخر'), type: 'number' as const },
  { key: 'absent', label: tx('Absent', 'غائب'), type: 'number' as const },
  { key: 'excused', label: tx('Excused', 'غياب بعذر'), type: 'number' as const },
  { key: 'early_departure', label: tx('Left early', 'مغادرة مبكرة'), type: 'number' as const },
  { key: 'days', label: tx('Days marked', 'أيام مسجلة'), type: 'number' as const },
  { key: 'rate', label: tx('Attendance', 'نسبة الحضور'), type: 'percent' as const },
]
const SUMMED = [...COUNTED, 'days']

const APPLICATION_STATUS = ['submitted', 'under_review', 'waitlisted', 'accepted', 'rejected', 'converted', 'withdrawn'] as const
const APPLICATION_LABEL = {
  submitted: tx('Submitted', 'مقدم'),
  under_review: tx('Under review', 'قيد المراجعة'),
  waitlisted: tx('Waitlisted', 'قائمة الانتظار'),
  accepted: tx('Accepted', 'مقبول'),
  rejected: tx('Rejected', 'مرفوض'),
  converted: tx('Enrolled', 'تم التسجيل'),
  withdrawn: tx('Withdrawn', 'منسحب'),
}

export const attendanceReports: ReportDefinition[] = [
  {
    key: 'attendance.byStudent',
    category: 'attendance',
    title: tx('Attendance by student', 'الحضور حسب الطالب'),
    description: tx(
      'Each student’s marks in the date range and their attendance rate, lowest first.',
      'تسجيلات كل طالب خلال الفترة ونسبة حضوره، من الأدنى.',
    ),
    scopes: ['attendance.read'],
    filters: ['branch', 'year', 'dates', 'grade', 'class'],
    async run(ctx, input) {
      const groups = await tallies(ctx, input, 'studentId')
      const students = new Map(
        (await ctx.students.find({ _id: { $in: groups.map((g) => g._id) } }).toArray()).map((s) => [s._id, s]),
      )
      const classes = await classNames(ctx)
      const rows = groups
        .map((g) => {
          const s = students.get(g._id)
          const row: Record<string, Cell> = {
            studentNumber: s?.studentNumber ?? '',
            name: s ? studentLabel(s, input.lang) : '',
            class: classes.get(g.lastClassId)?.label ?? '',
            ...tallyOf(g),
          }
          row.rate = rate(row)
          return row
        })
        .sort((a, b) => ((a.rate as number) ?? 1) - ((b.rate as number) ?? 1) || String(a.name).localeCompare(String(b.name)))
      const totals = sumRows(rows, SUMMED, 'studentNumber', TOTAL[input.lang])
      totals.rate = rate(totals)
      return {
        columns: [
          { key: 'studentNumber', label: tx('Student no.', 'رقم الطالب'), type: 'text' },
          { key: 'name', label: tx('Name', 'الاسم'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          ...STATUS_COLUMNS,
        ],
        rows,
        totals,
      }
    },
  },
  {
    key: 'attendance.byClass',
    category: 'attendance',
    title: tx('Attendance by class', 'الحضور حسب الصف'),
    description: tx('Marks per class in the date range and each class’s attendance rate.', 'التسجيلات لكل صف خلال الفترة ونسبة الحضور.'),
    scopes: ['attendance.read'],
    filters: ['branch', 'year', 'dates', 'grade', 'class'],
    async run(ctx, input) {
      const groups = await tallies(ctx, input, 'classId')
      const [branch, classes] = await Promise.all([branchNames(ctx), classNames(ctx)])
      const rows = groups
        .map((g) => {
          const row: Record<string, Cell> = {
            branch: branch(g.branchId),
            class: classes.get(g._id)?.label ?? '',
            schoolDays: g.schoolDays?.length ?? 0,
            ...tallyOf(g),
          }
          row.rate = rate(row)
          return row
        })
        .sort((a, b) => String(a.branch).localeCompare(String(b.branch)) || String(a.class).localeCompare(String(b.class)))
      const totals = sumRows(rows, SUMMED, 'branch', TOTAL[input.lang])
      totals.rate = rate(totals)
      return {
        columns: [
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'schoolDays', label: tx('School days', 'أيام الدراسة'), type: 'number' },
          ...STATUS_COLUMNS.map((c) => (c.key === 'days' ? { ...c, label: tx('Marks', 'التسجيلات') } : c)),
        ],
        rows,
        totals,
      }
    },
  },
  {
    key: 'admissions.pipeline',
    category: 'admissions',
    title: tx('Admissions by grade', 'القبول حسب المرحلة'),
    description: tx(
      'Applications for a year per grade applied for, by where they stand.',
      'طلبات الالتحاق لسنة دراسية لكل مرحلة، حسب حالتها.',
    ),
    scopes: ['admissions.read'],
    filters: ['branch', 'year', 'grade'],
    async run(ctx, input) {
      const apps = await ctx.applications
        .find({
          ...inBranches(input.branchIds),
          ...(input.filters.academicYearId ? { academicYearId: input.filters.academicYearId } : {}),
          ...(input.filters.gradeLevel ? { gradeLevel: input.filters.gradeLevel } : {}),
          status: { $ne: 'draft' },
        })
        .toArray()
      const branch = await branchNames(ctx)
      const groups = new Map<string, Record<string, Cell>>()
      for (const a of apps) {
        const key = `${a.branchId}|${a.gradeLevel}`
        const row =
          groups.get(key) ??
          Object.fromEntries([
            ['branch', branch(a.branchId)],
            ['grade', a.gradeLevel],
            ...APPLICATION_STATUS.map((s) => [s, 0]),
            ['total', 0],
          ])
        row[a.status] = ((row[a.status] as number) ?? 0) + 1
        row.total = (row.total as number) + 1
        groups.set(key, row)
      }
      const rows = [...groups.values()].sort(
        (a, b) => String(a.branch).localeCompare(String(b.branch)) || String(a.grade).localeCompare(String(b.grade)),
      )
      return {
        columns: [
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'grade', label: tx('Grade', 'المرحلة'), type: 'text' },
          ...APPLICATION_STATUS.map((s) => ({ key: s, label: APPLICATION_LABEL[s], type: 'number' as const })),
          { key: 'total', label: tx('Total', 'المجموع'), type: 'number' },
        ],
        rows,
        totals: sumRows(rows, [...APPLICATION_STATUS, 'total'], 'branch', TOTAL[input.lang]),
      }
    },
  },
]
