import { coveringContract, fullName } from '../../hr/common.js'
import { branchNames, daysBetween, enumLabel, inBranches, lookupLabels, pickLang, studentLabel, tx } from '../common.js'
import { sumRows, type ReportDefinition } from '../types.js'
import { TOTAL } from './shared.js'

/** HR and operations reports (SAMS 7.2). Salaries never appear here. */

const EMPLOYEE_STATUS = { active: tx('Active', 'على رأس العمل'), terminated: tx('Left', 'منتهي الخدمة') }
const LEAVE_STATUS = {
  pending: tx('Pending', 'قيد الانتظار'),
  approved: tx('Approved', 'موافق عليها'),
  rejected: tx('Rejected', 'مرفوضة'),
  cancelled: tx('Cancelled', 'ملغاة'),
}
const MAINTENANCE_STATUS = {
  open: tx('Open', 'مفتوح'),
  in_progress: tx('In progress', 'قيد التنفيذ'),
  resolved: tx('Resolved', 'تم الحل'),
  closed: tx('Closed', 'مغلق'),
  cancelled: tx('Cancelled', 'ملغى'),
}
const PRIORITY = { low: tx('Low', 'منخفضة'), normal: tx('Normal', 'عادية'), high: tx('High', 'عالية'), urgent: tx('Urgent', 'عاجلة') }
const LOAN_STATUS = { overdue: tx('Overdue only', 'المتأخرة فقط') }
const BORROWER = { student: tx('Student', 'طالب'), employee: tx('Staff', 'موظف') }

const options = (labels: Record<string, { en: string; ar: string }>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))

export const hrReports: ReportDefinition[] = [
  {
    key: 'hr.staff',
    category: 'hr',
    title: tx('Staff list', 'قائمة الموظفين'),
    description: tx(
      'Employees with their department, position and the contract covering today.',
      'الموظفون مع القسم والوظيفة والعقد الساري اليوم.',
    ),
    scopes: ['reports.hr'],
    filters: ['branch', 'status'],
    statuses: options(EMPLOYEE_STATUS),
    async run(ctx, input) {
      const status = input.filters.status as keyof typeof EMPLOYEE_STATUS | null
      const employees = await ctx.employees.find({ ...inBranches(input.branchIds), ...(status ? { status } : {}) }).toArray()
      const contracts = await ctx.contracts.find({ employeeId: { $in: employees.map((e) => e._id) } }).toArray()
      const [branch, dept, position, contractType] = await Promise.all([
        branchNames(ctx),
        lookupLabels(ctx, 'department', input.lang),
        lookupLabels(ctx, 'position', input.lang),
        lookupLabels(ctx, 'contractType', input.lang),
      ])
      const statusLabel = enumLabel(EMPLOYEE_STATUS, input.lang)
      const rows = employees
        .map((e) => {
          const c = coveringContract(
            contracts.filter((x) => x.employeeId === e._id && x.closedReason !== 'terminated'),
            input.today,
          )
          return {
            employeeNumber: e.employeeNumber,
            name: pickLang(input.lang, fullName(e), e.fullNameAr),
            branch: branch(e.branchId),
            department: dept(e.departmentCode),
            position: position(e.positionCode),
            hireDate: e.hireDate,
            status: statusLabel(e.status),
            contract: c ? contractType(c.typeCode) : '',
            contractEnds: c?.endDate ?? null,
            phone: e.phone ?? '',
            email: e.email ?? '',
          }
        })
        .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
      return {
        columns: [
          { key: 'employeeNumber', label: tx('Employee no.', 'الرقم الوظيفي'), type: 'text' },
          { key: 'name', label: tx('Name', 'الاسم'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'department', label: tx('Department', 'القسم'), type: 'text' },
          { key: 'position', label: tx('Position', 'الوظيفة'), type: 'text' },
          { key: 'hireDate', label: tx('Hired', 'تاريخ التعيين'), type: 'date' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
          { key: 'contract', label: tx('Contract', 'العقد'), type: 'text' },
          { key: 'contractEnds', label: tx('Contract ends', 'نهاية العقد'), type: 'date' },
          { key: 'phone', label: tx('Phone', 'الهاتف'), type: 'text' },
          { key: 'email', label: tx('Email', 'البريد الإلكتروني'), type: 'text' },
        ],
        rows,
        totals: null,
      }
    },
  },
  {
    key: 'hr.leave',
    category: 'hr',
    title: tx('Leave requests', 'طلبات الإجازة'),
    description: tx('Leave overlapping the date range, with working days and status.', 'الإجازات ضمن الفترة مع أيام العمل والحالة.'),
    scopes: ['reports.hr'],
    filters: ['branch', 'dates', 'status'],
    statuses: options(LEAVE_STATUS),
    async run(ctx, input) {
      const status = input.filters.status as keyof typeof LEAVE_STATUS | null
      const requests = await ctx.leaveRequests
        .find({
          ...inBranches(input.branchIds),
          startDate: { $lte: input.to! },
          endDate: { $gte: input.from! },
          ...(status ? { status } : {}),
        })
        .toArray()
      const employees = new Map(
        (await ctx.employees.find({ _id: { $in: requests.map((r) => r.employeeId) } }).toArray()).map((e) => [e._id, e]),
      )
      const types = new Map((await ctx.leaveTypes.find({}).toArray()).map((t) => [t.code, pickLang(input.lang, t.name, t.nameAr)]))
      const branch = await branchNames(ctx)
      const statusLabel = enumLabel(LEAVE_STATUS, input.lang)
      const rows = requests
        .map((r) => {
          const e = employees.get(r.employeeId)
          return {
            employeeNumber: e?.employeeNumber ?? '',
            name: e ? pickLang(input.lang, fullName(e), e.fullNameAr) : '',
            branch: branch(r.branchId),
            type: types.get(r.typeCode) ?? r.typeCode,
            startDate: r.startDate,
            endDate: r.endDate,
            days: r.days,
            status: statusLabel(r.status),
          }
        })
        .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name))
      return {
        columns: [
          { key: 'employeeNumber', label: tx('Employee no.', 'الرقم الوظيفي'), type: 'text' },
          { key: 'name', label: tx('Name', 'الاسم'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'type', label: tx('Leave type', 'نوع الإجازة'), type: 'text' },
          { key: 'startDate', label: tx('From', 'من'), type: 'date' },
          { key: 'endDate', label: tx('To', 'إلى'), type: 'date' },
          { key: 'days', label: tx('Days', 'الأيام'), type: 'number' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
        ],
        rows,
        totals: sumRows(rows, ['days'], 'employeeNumber', TOTAL[input.lang]),
      }
    },
  },
  {
    key: 'ops.maintenance',
    category: 'operations',
    title: tx('Maintenance requests', 'طلبات الصيانة'),
    description: tx(
      'Requests reported in the date range, their priority, status and cost.',
      'الطلبات المبلغ عنها خلال الفترة مع الأولوية والحالة والتكلفة.',
    ),
    scopes: ['ops.read'],
    filters: ['branch', 'dates', 'status'],
    statuses: options(MAINTENANCE_STATUS),
    async run(ctx, input) {
      const status = input.filters.status as keyof typeof MAINTENANCE_STATUS | null
      const list = await ctx.maintenanceRequests
        .find({
          ...inBranches(input.branchIds),
          createdAt: { $gte: new Date(`${input.from}T00:00:00Z`), $lte: new Date(`${input.to}T23:59:59.999Z`) },
          ...(status ? { status } : {}),
        })
        .toArray()
      const branch = await branchNames(ctx)
      const statusLabel = enumLabel(MAINTENANCE_STATUS, input.lang)
      const priority = enumLabel(PRIORITY, input.lang)
      const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
      const rows = list
        .map((m) => ({
          requestNumber: m.requestNumber,
          reported: day(m.createdAt)!,
          branch: branch(m.branchId),
          title: m.title,
          priority: priority(m.priority),
          status: statusLabel(m.status),
          resolved: day(m.resolvedAt),
          cost: m.cost,
        }))
        .sort((a, b) => a.reported.localeCompare(b.reported) || a.requestNumber.localeCompare(b.requestNumber))
      return {
        columns: [
          { key: 'requestNumber', label: tx('Request', 'رقم الطلب'), type: 'text' },
          { key: 'reported', label: tx('Reported', 'تاريخ الإبلاغ'), type: 'date' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'title', label: tx('Problem', 'المشكلة'), type: 'text' },
          { key: 'priority', label: tx('Priority', 'الأولوية'), type: 'text' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
          { key: 'resolved', label: tx('Resolved', 'تاريخ الحل'), type: 'date' },
          { key: 'cost', label: tx('Cost', 'التكلفة'), type: 'money' },
        ],
        rows,
        totals: sumRows(rows, ['cost'], 'requestNumber', TOTAL[input.lang]),
      }
    },
  },
  {
    key: 'ops.loans',
    category: 'operations',
    title: tx('Library books on loan', 'كتب المكتبة المعارة'),
    description: tx('Books out today, who has them and how late they are.', 'الكتب المعارة اليوم ومن يحملها ومدة تأخيرها.'),
    scopes: ['ops.read'],
    filters: ['branch', 'status'],
    statuses: options(LOAN_STATUS),
    async run(ctx, input) {
      const loans = await ctx.loans
        .find({
          ...inBranches(input.branchIds),
          returnedAt: null,
          lostAt: null,
          ...(input.filters.status === 'overdue' ? { dueDate: { $lt: input.today } } : {}),
        })
        .toArray()
      const [books, students, employees, branch] = await Promise.all([
        ctx.books.find({ _id: { $in: loans.map((l) => l.bookId) } }).toArray(),
        ctx.students.find({ _id: { $in: loans.filter((l) => l.borrowerType === 'student').map((l) => l.borrowerId) } }).toArray(),
        ctx.employees.find({ _id: { $in: loans.filter((l) => l.borrowerType === 'employee').map((l) => l.borrowerId) } }).toArray(),
        branchNames(ctx),
      ])
      const title = new Map(books.map((b) => [b._id, b.title]))
      const who = new Map<string, string>([
        ...students.map((s) => [s._id, studentLabel(s, input.lang)] as [string, string]),
        ...employees.map((e) => [e._id, pickLang(input.lang, fullName(e), e.fullNameAr)] as [string, string]),
      ])
      const borrower = enumLabel(BORROWER, input.lang)
      const rows = loans
        .map((l) => ({
          book: title.get(l.bookId) ?? '',
          borrower: who.get(l.borrowerId) ?? '',
          borrowerType: borrower(l.borrowerType),
          branch: branch(l.branchId),
          loanedAt: l.loanedAt,
          dueDate: l.dueDate,
          daysLate: l.dueDate < input.today ? daysBetween(l.dueDate, input.today) : null,
        }))
        .sort((a, b) => (b.daysLate ?? 0) - (a.daysLate ?? 0) || a.dueDate.localeCompare(b.dueDate))
      return {
        columns: [
          { key: 'book', label: tx('Book', 'الكتاب'), type: 'text' },
          { key: 'borrower', label: tx('Borrower', 'المستعير'), type: 'text' },
          { key: 'borrowerType', label: tx('Type', 'النوع'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'loanedAt', label: tx('Borrowed', 'تاريخ الإعارة'), type: 'date' },
          { key: 'dueDate', label: tx('Due', 'تاريخ الإرجاع'), type: 'date' },
          { key: 'daysLate', label: tx('Days late', 'أيام التأخير'), type: 'number' },
        ],
        rows,
        totals: null,
      }
    },
  },
]
