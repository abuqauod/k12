import { branchNames, classNames, enumLabel, inBranches, lookupLabels, studentLabel, tx } from '../common.js'
import { sumRows, type ReportDefinition } from '../types.js'
import { classFilter, studentsInScope, TOTAL, yearOrCurrent } from './shared.js'

/** Student and enrollment reports (SAMS 7.2). */

const STUDENT_STATUS = {
  enrolled: tx('Enrolled', 'مسجل'),
  graduated: tx('Graduated', 'متخرج'),
  withdrawn: tx('Withdrawn', 'منسحب'),
  inquiry: tx('Inquiry', 'استفسار'),
}
const GENDER = { male: tx('Male', 'ذكر'), female: tx('Female', 'أنثى') }
const MOVEMENT_STATUS = {
  withdrawn: tx('Withdrawn', 'انسحاب'),
  transferred: tx('Transferred', 'نقل'),
  graduated: tx('Graduated', 'تخرج'),
}

const options = (labels: Record<string, { en: string; ar: string }>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))

export const studentReports: ReportDefinition[] = [
  {
    key: 'students.roster',
    category: 'students',
    title: tx('Student roster', 'قائمة الطلاب'),
    description: tx('Every student with their class, branch and status.', 'جميع الطلاب مع الصف والفرع والحالة.'),
    scopes: ['students.read'],
    filters: ['branch', 'year', 'grade', 'class', 'status'],
    statuses: options(STUDENT_STATUS),
    async run(ctx, input) {
      const status = input.filters.status as keyof typeof STUDENT_STATUS | null
      const students = await studentsInScope(ctx, input, status ? { status } : {})
      const [branch, classes] = await Promise.all([branchNames(ctx), classNames(ctx)])
      const statusLabel = enumLabel(STUDENT_STATUS, input.lang)
      const genderLabel = enumLabel(GENDER, input.lang)
      const rows = students
        .map((s) => ({
          studentNumber: s.studentNumber,
          name: studentLabel(s, input.lang),
          gender: genderLabel(s.gender),
          dob: s.dob,
          grade: classes.get(s.classId)?.gradeLevel ?? '',
          class: classes.get(s.classId)?.label ?? '',
          branch: branch(s.branchId),
          status: statusLabel(s.status),
          admissionDate: s.admissionDate,
          phone: s.primaryPhone,
        }))
        .sort((a, b) => a.grade.localeCompare(b.grade) || a.class.localeCompare(b.class) || a.name.localeCompare(b.name))
      return {
        columns: [
          { key: 'studentNumber', label: tx('Student no.', 'رقم الطالب'), type: 'text' },
          { key: 'name', label: tx('Name', 'الاسم'), type: 'text' },
          { key: 'gender', label: tx('Gender', 'الجنس'), type: 'text' },
          { key: 'dob', label: tx('Date of birth', 'تاريخ الميلاد'), type: 'date' },
          { key: 'grade', label: tx('Grade', 'المرحلة'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
          { key: 'admissionDate', label: tx('Admitted', 'تاريخ القبول'), type: 'date' },
          { key: 'phone', label: tx('Phone', 'الهاتف'), type: 'text' },
        ],
        rows,
        totals: null,
      }
    },
  },
  {
    key: 'students.enrollment',
    category: 'students',
    title: tx('Enrollment by class', 'التسجيل حسب الصف'),
    description: tx(
      'Places in each class for a year: active, planned, withdrawn and transferred, against capacity.',
      'المقاعد في كل صف لسنة دراسية: الفعّالة والمخطط لها والمنسحبة والمنقولة، مقارنة بالسعة.',
    ),
    scopes: ['enrollments.read'],
    filters: ['branch', 'year', 'grade', 'class'],
    async run(ctx, input) {
      const yearId = await yearOrCurrent(ctx, input)
      const classIds = await classFilter(ctx, input)
      const enrollments = yearId
        ? await ctx.enrollments
            .find({ ...inBranches(input.branchIds), academicYearId: yearId, ...(classIds ? { classId: { $in: classIds } } : {}) })
            .toArray()
        : []
      const classes = await ctx.classes
        .find({
          ...inBranches(input.branchIds),
          ...(classIds ? { _id: { $in: classIds } } : {}),
          $or: [{ academicYearId: yearId }, { academicYearId: null }, { _id: { $in: [...new Set(enrollments.map((e) => e.classId))] } }],
        })
        .toArray()
      const branch = await branchNames(ctx)
      const count = (classId: string, status: string) =>
        enrollments.filter((e) => e.classId === classId && e.status === status).length
      const rows = classes
        .filter((c) => c.active || enrollments.some((e) => e.classId === c._id))
        .map((c) => {
          const active = count(c._id, 'active')
          return {
            branch: branch(c.branchId),
            grade: c.gradeLevel,
            class: `${c.gradeLevel} ${c.name}`.trim(),
            capacity: c.capacity,
            active,
            pending: count(c._id, 'pending'),
            withdrawn: count(c._id, 'withdrawn'),
            transferred: count(c._id, 'transferred'),
            fill: c.capacity > 0 ? active / c.capacity : null,
          }
        })
        .sort((a, b) => a.branch.localeCompare(b.branch) || a.grade.localeCompare(b.grade) || a.class.localeCompare(b.class))
      const totals = sumRows(rows, ['capacity', 'active', 'pending', 'withdrawn', 'transferred'], 'branch', TOTAL[input.lang])
      totals.fill = (totals.capacity as number) > 0 ? (totals.active as number) / (totals.capacity as number) : null
      return {
        columns: [
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'grade', label: tx('Grade', 'المرحلة'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'capacity', label: tx('Capacity', 'السعة'), type: 'number' },
          { key: 'active', label: tx('Active', 'فعّال'), type: 'number' },
          { key: 'pending', label: tx('Planned', 'مخطط'), type: 'number' },
          { key: 'withdrawn', label: tx('Withdrawn', 'منسحب'), type: 'number' },
          { key: 'transferred', label: tx('Transferred', 'منقول'), type: 'number' },
          { key: 'fill', label: tx('Filled', 'نسبة الإشغال'), type: 'percent' },
        ],
        rows,
        totals,
      }
    },
  },
  {
    key: 'students.movement',
    category: 'students',
    title: tx('Withdrawals and transfers', 'الانسحابات والتنقلات'),
    description: tx(
      'Places that ended in the date range: withdrawn, transferred or graduated, with the reason.',
      'المقاعد التي انتهت خلال الفترة: انسحاب أو نقل أو تخرج، مع السبب.',
    ),
    scopes: ['enrollments.read'],
    filters: ['branch', 'year', 'dates', 'grade', 'class', 'status'],
    statuses: options(MOVEMENT_STATUS),
    async run(ctx, input) {
      const classIds = await classFilter(ctx, input)
      const status = input.filters.status as keyof typeof MOVEMENT_STATUS | null
      const rows0 = await ctx.enrollments
        .find({
          ...inBranches(input.branchIds),
          ...(input.filters.academicYearId ? { academicYearId: input.filters.academicYearId } : {}),
          ...(classIds ? { classId: { $in: classIds } } : {}),
          status: status ? status : { $in: Object.keys(MOVEMENT_STATUS) as (keyof typeof MOVEMENT_STATUS)[] },
          endDate: { $gte: input.from!, $lte: input.to! },
        })
        .toArray()
      const students = new Map(
        (await ctx.students.find({ _id: { $in: rows0.map((e) => e.studentId) } }).toArray()).map((s) => [s._id, s]),
      )
      const [branch, classes, reason] = await Promise.all([
        branchNames(ctx),
        classNames(ctx),
        lookupLabels(ctx, 'withdrawalReason', input.lang),
      ])
      const statusLabel = enumLabel(MOVEMENT_STATUS, input.lang)
      const rows = rows0
        .map((e) => {
          const s = students.get(e.studentId)
          return {
            date: e.endDate,
            studentNumber: s?.studentNumber ?? '',
            name: s ? studentLabel(s, input.lang) : '',
            class: classes.get(e.classId)?.label ?? '',
            branch: branch(e.branchId),
            status: statusLabel(e.status),
            reason: [reason(e.reasonCode ?? null), e.reason ?? ''].filter(Boolean).join(' — '),
          }
        })
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      return {
        columns: [
          { key: 'date', label: tx('Date', 'التاريخ'), type: 'date' },
          { key: 'studentNumber', label: tx('Student no.', 'رقم الطالب'), type: 'text' },
          { key: 'name', label: tx('Name', 'الاسم'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'status', label: tx('Change', 'نوع التغيير'), type: 'text' },
          { key: 'reason', label: tx('Reason', 'السبب'), type: 'text' },
        ],
        rows,
        totals: null,
      }
    },
  },
]
