import { branchNames, enumLabel, inBranches, lookupLabels, studentLabel, tx } from '../common.js'
import type { ReportDefinition } from '../types.js'
import { classFilter } from './shared.js'

/** Backlog: clinic visits and behaviour incidents in the report catalog. */

const OUTCOME = {
  returned_to_class: tx('Returned to class', 'عاد إلى الصف'),
  rested: tx('Rested', 'استراحة'),
  sent_home: tx('Sent home', 'أُرسل إلى المنزل'),
  referred: tx('Referred', 'إحالة'),
  emergency: tx('Emergency', 'طوارئ'),
}
const INCIDENT_STATUS = { open: tx('Open', 'مفتوحة'), resolved: tx('Resolved', 'مغلقة'), dismissed: tx('Dismissed', 'مرفوضة') }
const SEVERITY = { minor: tx('Minor', 'بسيطة'), moderate: tx('Moderate', 'متوسطة'), major: tx('Major', 'جسيمة') }

const options = (labels: Record<string, { en: string; ar: string }>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))
const range = (from: string, to: string) => ({ $gte: new Date(`${from}T00:00:00Z`), $lte: new Date(`${to}T23:59:59.999Z`) })

export const wellbeingReports: ReportDefinition[] = [
  {
    key: 'health.visits',
    category: 'students',
    title: tx('Clinic visits', 'زيارات العيادة'),
    description: tx('Every clinic visit in the date range, with what happened and whether the family was told.', 'كل زيارة للعيادة خلال الفترة، مع النتيجة وإن تم إبلاغ الأسرة.'),
    scopes: ['health.read'],
    filters: ['branch', 'dates', 'grade', 'class', 'status'],
    statuses: options(OUTCOME),
    async run(ctx, input) {
      const classIds = await classFilter(ctx, input)
      const inClass = classIds
        ? (await ctx.students.find({ classId: { $in: classIds } }).toArray()).map((s) => s._id)
        : null
      const visits = await ctx.clinicVisits
        .find({
          ...inBranches(input.branchIds),
          visitedAt: range(input.from!, input.to!),
          ...(inClass ? { studentId: { $in: inClass } } : {}),
          ...(input.filters.status ? { outcome: input.filters.status as keyof typeof OUTCOME } : {}),
        })
        .toArray()
      const students = new Map((await ctx.students.find({ _id: { $in: visits.map((v) => v.studentId) } }).toArray()).map((s) => [s._id, s]))
      const branch = await branchNames(ctx)
      const outcome = enumLabel(OUTCOME, input.lang)
      const yes = input.lang === 'ar' ? 'نعم' : 'Yes'
      const rows = visits
        .map((v) => {
          const s = students.get(v.studentId)
          return {
            when: v.visitedAt.toISOString().slice(0, 16).replace('T', ' '),
            studentNumber: s?.studentNumber ?? '',
            student: s ? studentLabel(s, input.lang) : '',
            class: s?.studentGroup ?? '',
            branch: branch(v.branchId),
            complaint: v.complaint,
            temperature: v.temperature,
            treatment: v.treatment ?? '',
            outcome: outcome(v.outcome),
            notified: v.parentsNotifiedAt ? yes : '',
          }
        })
        .sort((a, b) => b.when.localeCompare(a.when))
      return {
        columns: [
          { key: 'when', label: tx('When (UTC)', 'الوقت (UTC)'), type: 'text' },
          { key: 'studentNumber', label: tx('Student no.', 'رقم الطالب'), type: 'text' },
          { key: 'student', label: tx('Student', 'الطالب'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'complaint', label: tx('Complaint', 'الشكوى'), type: 'text' },
          { key: 'temperature', label: tx('Temp. °C', 'الحرارة °م'), type: 'number' },
          { key: 'treatment', label: tx('Treatment', 'الإجراء'), type: 'text' },
          { key: 'outcome', label: tx('Outcome', 'النتيجة'), type: 'text' },
          { key: 'notified', label: tx('Family told', 'أُبلغت الأسرة'), type: 'text' },
        ],
        rows,
        totals: null,
      }
    },
  },
  {
    key: 'discipline.incidents',
    category: 'students',
    title: tx('Behaviour incidents', 'الحوادث السلوكية'),
    description: tx('Incidents in the date range, per student, with the action taken.', 'الحوادث خلال الفترة لكل طالب، مع الإجراء المتخذ.'),
    scopes: ['discipline.manage'],
    filters: ['branch', 'dates', 'grade', 'class', 'status'],
    statuses: options(INCIDENT_STATUS),
    async run(ctx, input) {
      const classIds = await classFilter(ctx, input)
      const incidents = await ctx.incidents
        .find({
          ...inBranches(input.branchIds),
          occurredAt: range(input.from!, input.to!),
          ...(input.filters.status ? { status: input.filters.status as keyof typeof INCIDENT_STATUS } : {}),
        })
        .toArray()
      const students = new Map(
        (await ctx.students.find({ _id: { $in: incidents.flatMap((i) => i.studentIds) } }).toArray()).map((s) => [s._id, s]),
      )
      const [type, action, branch] = await Promise.all([
        lookupLabels(ctx, 'incidentType', input.lang),
        lookupLabels(ctx, 'disciplineAction', input.lang),
        branchNames(ctx),
      ])
      const status = enumLabel(INCIDENT_STATUS, input.lang)
      const severity = enumLabel(SEVERITY, input.lang)
      const rows = incidents
        .flatMap((i) =>
          i.studentIds.map((sid) => ({ i, s: students.get(sid), sid })),
        )
        .filter(({ s }) => !classIds || (s && classIds.includes(s.classId)))
        .map(({ i, s, sid }) => ({
          incidentNumber: i.incidentNumber,
          date: i.occurredAt.toISOString().slice(0, 10),
          studentNumber: s?.studentNumber ?? '',
          student: s ? studentLabel(s, input.lang) : '',
          class: s?.studentGroup ?? '',
          branch: branch(i.branchId),
          type: type(i.typeCode),
          severity: severity(i.severity),
          actions: i.actions
            .filter((a) => a.studentId === sid)
            .map((a) => action(a.code))
            .join(', '),
          status: status(i.status),
        }))
        .sort((a, b) => b.date.localeCompare(a.date) || a.incidentNumber.localeCompare(b.incidentNumber))
      return {
        columns: [
          { key: 'incidentNumber', label: tx('Incident', 'رقم الحادثة'), type: 'text' },
          { key: 'date', label: tx('Date', 'التاريخ'), type: 'date' },
          { key: 'studentNumber', label: tx('Student no.', 'رقم الطالب'), type: 'text' },
          { key: 'student', label: tx('Student', 'الطالب'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'type', label: tx('Type', 'النوع'), type: 'text' },
          { key: 'severity', label: tx('Severity', 'الخطورة'), type: 'text' },
          { key: 'actions', label: tx('Action taken', 'الإجراء المتخذ'), type: 'text' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
        ],
        rows,
        totals: null,
      }
    },
  },
]
