import { invoicePaidTotals } from '../../finance/service.js'
import { branchNames, classNames, enumLabel, inBranches, lookupLabels, studentLabel, tx } from '../common.js'
import { isCounted, paymentsInRange, receivables } from '../finance.js'
import { sumRows, type ReportDefinition } from '../types.js'
import { studentsInScope, TOTAL } from './shared.js'
import type { RunInput } from '../types.js'
import type { TenantContext } from '../../db.js'

/** Finance reports (SAMS 7.2), on the shared finance queries. */

/** Only the students in the grade/class asked for; null = no such filter. */
async function studentFilter(ctx: TenantContext, input: RunInput): Promise<string[] | null> {
  if (!input.filters.gradeLevel && !input.filters.classId) return null
  return (await studentsInScope(ctx, { ...input, filters: { ...input.filters, academicYearId: null } })).map((s) => s._id)
}

async function studentsById(ctx: TenantContext, ids: string[]) {
  return new Map((await ctx.students.find({ _id: { $in: [...new Set(ids)] } }).toArray()).map((s) => [s._id, s]))
}

const OUTSTANDING_STATUS = { overdue: tx('Overdue only', 'المتأخرة فقط'), current: tx('Not yet due', 'غير مستحقة بعد') }
const PAYMENT_STATUS = { confirmed: tx('Received', 'مستلمة'), pending: tx('Awaiting confirmation', 'بانتظار التأكيد') }
const EXPENSE_STATUS = {
  pending: tx('Awaiting approval', 'بانتظار الموافقة'),
  approved: tx('Approved', 'معتمد'),
  paid: tx('Paid', 'مدفوع'),
  rejected: tx('Rejected', 'مرفوض'),
  cancelled: tx('Cancelled', 'ملغى'),
}
const options = (labels: Record<string, { en: string; ar: string }>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))

export const financeReports: ReportDefinition[] = [
  {
    key: 'finance.outstanding',
    category: 'finance',
    title: tx('Outstanding balances', 'الأرصدة المستحقة'),
    description: tx(
      'Every unpaid invoice as of today: what is left, what is overdue and for how long.',
      'كل فاتورة غير مسددة حتى اليوم: المتبقي والمتأخر ومدة التأخير.',
    ),
    scopes: ['reports.finance'],
    filters: ['branch', 'year', 'grade', 'class', 'status'],
    statuses: options(OUTSTANDING_STATUS),
    async run(ctx, input) {
      const studentIds = await studentFilter(ctx, input)
      let list = await receivables(ctx, { branchIds: input.branchIds, academicYearId: input.filters.academicYearId, studentIds }, input.today)
      if (input.filters.status === 'overdue') list = list.filter((r) => r.overdue > 0)
      if (input.filters.status === 'current') list = list.filter((r) => r.overdue === 0)
      const [students, classes, branch] = await Promise.all([
        studentsById(
          ctx,
          list.map((r) => r.invoice.studentId),
        ),
        classNames(ctx),
        branchNames(ctx),
      ])
      const rows = list
        .map((r) => {
          const s = students.get(r.invoice.studentId)
          return {
            invoiceNumber: r.invoice.invoiceNumber,
            student: s ? studentLabel(s, input.lang) : '',
            class: s ? (classes.get(s.classId)?.label ?? '') : '',
            branch: branch(r.invoice.branchId),
            dueDate: r.invoice.dueDate,
            total: r.invoice.total,
            paid: r.paid,
            outstanding: r.outstanding,
            overdue: r.overdue,
            daysOverdue: r.daysOverdue || null,
          }
        })
        .sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) || b.outstanding - a.outstanding)
      return {
        columns: [
          { key: 'invoiceNumber', label: tx('Invoice', 'الفاتورة'), type: 'text' },
          { key: 'student', label: tx('Student', 'الطالب'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'dueDate', label: tx('Due', 'تاريخ الاستحقاق'), type: 'date' },
          { key: 'total', label: tx('Invoiced', 'قيمة الفاتورة'), type: 'money' },
          { key: 'paid', label: tx('Paid', 'المدفوع'), type: 'money' },
          { key: 'outstanding', label: tx('Outstanding', 'المتبقي'), type: 'money' },
          { key: 'overdue', label: tx('Overdue', 'المتأخر'), type: 'money' },
          { key: 'daysOverdue', label: tx('Days late', 'أيام التأخير'), type: 'number' },
        ],
        rows,
        totals: sumRows(rows, ['total', 'paid', 'outstanding', 'overdue'], 'invoiceNumber', TOTAL[input.lang]),
      }
    },
  },
  {
    key: 'finance.collections',
    category: 'finance',
    title: tx('Payments received', 'الدفعات المستلمة'),
    description: tx(
      'Payments taken in the date range, by method, with those still awaiting confirmation.',
      'الدفعات المستلمة خلال الفترة حسب طريقة الدفع، مع ما ينتظر التأكيد.',
    ),
    scopes: ['reports.finance'],
    filters: ['branch', 'year', 'dates', 'grade', 'class', 'status'],
    statuses: options(PAYMENT_STATUS),
    async run(ctx, input) {
      const studentIds = await studentFilter(ctx, input)
      const found = await paymentsInRange(
        ctx,
        { branchIds: input.branchIds, academicYearId: input.filters.academicYearId, studentIds },
        input.from!,
        input.to!,
      )
      let payments = found.payments
      if (input.filters.status === 'confirmed') payments = payments.filter(isCounted)
      if (input.filters.status === 'pending') payments = payments.filter((p) => !isCounted(p))
      const [students, classes, method] = await Promise.all([
        studentsById(
          ctx,
          payments.map((p) => p.studentId),
        ),
        classNames(ctx),
        lookupLabels(ctx, 'paymentMethod', input.lang),
      ])
      const statusLabel = enumLabel(PAYMENT_STATUS, input.lang)
      const rows = payments
        .map((p) => {
          const s = students.get(p.studentId)
          return {
            paidAt: p.paidAt,
            invoiceNumber: found.invoices.get(p.invoiceId)?.invoiceNumber ?? '',
            student: s ? studentLabel(s, input.lang) : '',
            class: s ? (classes.get(s.classId)?.label ?? '') : '',
            payer: p.payerName,
            method: method(p.method),
            reference: p.reference ?? '',
            status: statusLabel(isCounted(p) ? 'confirmed' : 'pending'),
            amount: p.amount,
          }
        })
        .sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.invoiceNumber.localeCompare(b.invoiceNumber))
      return {
        columns: [
          { key: 'paidAt', label: tx('Date', 'التاريخ'), type: 'date' },
          { key: 'invoiceNumber', label: tx('Invoice', 'الفاتورة'), type: 'text' },
          { key: 'student', label: tx('Student', 'الطالب'), type: 'text' },
          { key: 'class', label: tx('Class', 'الصف'), type: 'text' },
          { key: 'payer', label: tx('Paid by', 'الدافع'), type: 'text' },
          { key: 'method', label: tx('Method', 'طريقة الدفع'), type: 'text' },
          { key: 'reference', label: tx('Reference', 'المرجع'), type: 'text' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
          { key: 'amount', label: tx('Amount', 'المبلغ'), type: 'money' },
        ],
        rows,
        totals: sumRows(rows, ['amount'], 'paidAt', TOTAL[input.lang]),
      }
    },
  },
  {
    key: 'finance.billing',
    category: 'finance',
    title: tx('Billing by grade', 'الفوترة حسب المرحلة'),
    description: tx(
      'Invoices issued in the date range per grade: gross fees, discounts, scholarships, billed, paid and still owed.',
      'الفواتير الصادرة خلال الفترة لكل مرحلة: الرسوم والخصومات والمنح والمفوتر والمدفوع والمتبقي.',
    ),
    scopes: ['reports.finance'],
    filters: ['branch', 'year', 'dates', 'grade'],
    async run(ctx, input) {
      const invoices = await ctx.invoices
        .find({
          ...inBranches(input.branchIds),
          ...(input.filters.academicYearId ? { academicYearId: input.filters.academicYearId } : {}),
          status: { $ne: 'void' },
          issueDate: { $gte: input.from!, $lte: input.to! },
        })
        .toArray()
      // The grade a student was in for the invoice's year: that year's
      // enrollment, else where they are now.
      const enrollments = await ctx.enrollments
        .find({ studentId: { $in: [...new Set(invoices.map((i) => i.studentId))] }, status: { $ne: 'cancelled' } })
        .toArray()
      const [students, classes, branch, paid] = await Promise.all([
        studentsById(
          ctx,
          invoices.map((i) => i.studentId),
        ),
        classNames(ctx),
        branchNames(ctx),
        invoicePaidTotals(
          ctx,
          invoices.map((i) => i._id),
        ),
      ])
      const gradeOf = (studentId: string, yearId: string) => {
        const e = enrollments.find((x) => x.studentId === studentId && x.academicYearId === yearId)
        const classId = e?.classId ?? students.get(studentId)?.classId ?? ''
        return classes.get(classId)?.gradeLevel ?? ''
      }
      const groups = new Map<string, Record<string, number | string>>()
      for (const inv of invoices) {
        const grade = gradeOf(inv.studentId, inv.academicYearId)
        if (input.filters.gradeLevel && grade !== input.filters.gradeLevel) continue
        const key = `${inv.branchId}|${grade}`
        const g = groups.get(key) ?? {
          branch: branch(inv.branchId),
          grade,
          invoices: 0,
          gross: 0,
          discounts: 0,
          scholarships: 0,
          billed: 0,
          paid: 0,
          outstanding: 0,
        }
        const add = (k: string, v: number) => (g[k] = (g[k] as number) + v)
        add('invoices', 1)
        for (const line of inv.lineItems) {
          add('gross', line.amount)
          add('discounts', line.amount - line.netAmount)
        }
        for (const adj of inv.adjustments ?? []) add(adj.source === 'scholarship' ? 'scholarships' : 'discounts', adj.amount)
        add('billed', inv.total)
        const p = paid.get(inv._id) ?? 0
        add('paid', p)
        add('outstanding', inv.status === 'paid' ? 0 : Math.max(0, inv.total - p))
        groups.set(key, g)
      }
      const rows = [...groups.values()].sort(
        (a, b) => String(a.branch).localeCompare(String(b.branch)) || String(a.grade).localeCompare(String(b.grade)),
      )
      const money = ['gross', 'discounts', 'scholarships', 'billed', 'paid', 'outstanding']
      return {
        columns: [
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'grade', label: tx('Grade', 'المرحلة'), type: 'text' },
          { key: 'invoices', label: tx('Invoices', 'الفواتير'), type: 'number' },
          { key: 'gross', label: tx('Gross fees', 'إجمالي الرسوم'), type: 'money' },
          { key: 'discounts', label: tx('Discounts', 'الخصومات'), type: 'money' },
          { key: 'scholarships', label: tx('Scholarships', 'المنح'), type: 'money' },
          { key: 'billed', label: tx('Billed', 'المفوتر'), type: 'money' },
          { key: 'paid', label: tx('Paid', 'المدفوع'), type: 'money' },
          { key: 'outstanding', label: tx('Outstanding', 'المتبقي'), type: 'money' },
        ],
        rows,
        totals: sumRows(rows, ['invoices', ...money], 'branch', TOTAL[input.lang]),
      }
    },
  },
  {
    key: 'finance.expenses',
    category: 'finance',
    title: tx('Expenses', 'المصروفات'),
    description: tx('Expenses incurred in the date range, by category and vendor.', 'المصروفات خلال الفترة حسب الفئة والمورد.'),
    scopes: ['reports.finance'],
    filters: ['branch', 'dates', 'status'],
    statuses: options(EXPENSE_STATUS),
    async run(ctx, input) {
      const status = input.filters.status as keyof typeof EXPENSE_STATUS | null
      const expenses = await ctx.expenses
        .find({
          ...inBranches(input.branchIds),
          expenseDate: { $gte: input.from!, $lte: input.to! },
          ...(status ? { status } : {}),
        })
        .toArray()
      const vendors = new Map(
        (await ctx.vendors.find({ _id: { $in: expenses.flatMap((e) => (e.vendorId ? [e.vendorId] : [])) } }).toArray()).map((v) => [
          v._id,
          v.name,
        ]),
      )
      const [category, branch] = await Promise.all([lookupLabels(ctx, 'expenseCategory', input.lang), branchNames(ctx)])
      const statusLabel = enumLabel(EXPENSE_STATUS, input.lang)
      const rows = expenses
        .map((e) => ({
          expenseNumber: e.expenseNumber,
          date: e.expenseDate,
          branch: branch(e.branchId),
          category: category(e.categoryCode),
          vendor: e.vendorId ? (vendors.get(e.vendorId) ?? '') : '',
          description: e.description,
          status: statusLabel(e.status),
          paidAt: e.paidAt,
          amount: e.amount,
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.expenseNumber.localeCompare(b.expenseNumber))
      return {
        columns: [
          { key: 'expenseNumber', label: tx('Expense', 'رقم المصروف'), type: 'text' },
          { key: 'date', label: tx('Date', 'التاريخ'), type: 'date' },
          { key: 'branch', label: tx('Branch', 'الفرع'), type: 'text' },
          { key: 'category', label: tx('Category', 'الفئة'), type: 'text' },
          { key: 'vendor', label: tx('Vendor', 'المورد'), type: 'text' },
          { key: 'description', label: tx('Description', 'الوصف'), type: 'text' },
          { key: 'status', label: tx('Status', 'الحالة'), type: 'text' },
          { key: 'paidAt', label: tx('Paid on', 'تاريخ الدفع'), type: 'date' },
          { key: 'amount', label: tx('Amount', 'المبلغ'), type: 'money' },
        ],
        rows,
        totals: sumRows(rows, ['amount'], 'expenseNumber', TOTAL[input.lang]),
      }
    },
  },
]
