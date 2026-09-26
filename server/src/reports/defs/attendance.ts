import type { AttendanceRecordDoc } from '../../db.js'
import { branchNames, classNames, inBranches, studentLabel, tx } from '../common.js'
import { sumRows, type Cell, type ReportDefinition, type RunInput } from '../types.js'
import type { TenantContext } from '../../db.js'
import { classFilter, TOTAL } from './shared.js'

/** Attendance and admissions reports (SAMS 7.2). */

const COUNTED = ['present', 'late', 'absent', 'excused', 'early_departure'] as const

async function records(ctx: TenantContext, input: RunInput): Promise<AttendanceRecordDoc[]> {
  const classIds = await classFilter(ctx, input)
  return ctx.attendance
    .find({
      ...inBranches(input.branchIds),
      ...(input.filters.academicYearId ? { academicYearId: input.filters.academicYearId } : {}),
      ...(classIds ? { classId: { $in: classIds } } : {}),
      date: { $gte: input.from!, $lte: input.to! },
    })
    .toArray()
}

/** Present, late and early departure count as attending. */
const rate = (row: Record<string, Cell>) => {
  const days = row.days as number
  return days > 0 ? ((row.present as number) + (row.late as number) + (row.early_departure as number)) / days : null
}

const tally = (list: AttendanceRecordDoc[]) => {
  const out: Record<string, number> = { present: 0, late: 0, absent: 0, excused: 0, early_departure: 0, days: list.length }
  for (const r of list) out[r.status] = (out[r.status] ?? 0) + 1
  return out
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
      const list = await records(ctx, input)
      const byStudent = new Map<string, AttendanceRecordDoc[]>()
      for (const r of list) byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), r])
      const students = new Map((await ctx.students.find({ _id: { $in: [...byStudent.keys()] } }).toArray()).map((s) => [s._id, s]))
      const classes = await classNames(ctx)
      const rows = [...byStudent.entries()]
        .map(([studentId, marks]) => {
          const s = students.get(studentId)
          const last = marks.reduce((a, b) => (a.date > b.date ? a : b))
          const row: Record<string, Cell> = {
            studentNumber: s?.studentNumber ?? '',
            name: s ? studentLabel(s, input.lang) : '',
            class: classes.get(last.classId)?.label ?? '',
            ...tally(marks),
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
      const list = await records(ctx, input)
      const byClass = new Map<string, AttendanceRecordDoc[]>()
      for (const r of list) byClass.set(r.classId, [...(byClass.get(r.classId) ?? []), r])
      const [branch, classes] = await Promise.all([branchNames(ctx), classNames(ctx)])
      const rows = [...byClass.entries()]
        .map(([classId, marks]) => {
          const row: Record<string, Cell> = {
            branch: branch(marks[0]!.branchId),
            class: classes.get(classId)?.label ?? '',
            schoolDays: new Set(marks.map((m) => m.date)).size,
            ...tally(marks),
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
