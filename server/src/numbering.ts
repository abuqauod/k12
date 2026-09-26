import type { Document } from 'mongodb'
import type { NumberFormat, TenantContext, TenantScope } from './db.js'

/**
 * Human-facing record numbers (backlog: configurable numbering). Every
 * numbered record gets its number here, from a per-tenant counter and the
 * school's format for that kind (Settings → Numbering); a kind the school
 * never changed keeps its built-in format (INV-000123).
 *
 *  - The count only ever goes up, so changing a prefix or padding can't
 *    reproduce an earlier number. "Include the year" counts per year.
 *  - A school may move the next number forward (to carry on from a
 *    previous system), never back.
 *  - A number already used by a record (typed in by hand, imported) is
 *    skipped rather than reused.
 */

export const NUMBER_KINDS = {
  studentNumber: { prefix: 'STU', label: { en: 'Students', ar: 'الطلاب' } },
  applicationNumber: { prefix: 'APP', label: { en: 'Applications', ar: 'طلبات الالتحاق' } },
  invoiceNumber: { prefix: 'INV', label: { en: 'Invoices', ar: 'الفواتير' } },
  receiptNumber: { prefix: 'RCT', label: { en: 'Receipts', ar: 'الإيصالات' } },
  refundNumber: { prefix: 'RFD', label: { en: 'Refunds', ar: 'المبالغ المستردة' } },
  expenseNumber: { prefix: 'EXP', label: { en: 'Expenses', ar: 'المصروفات' } },
  employeeNumber: { prefix: 'EMP', label: { en: 'Employees', ar: 'الموظفون' } },
  assetTag: { prefix: 'AST', label: { en: 'Assets', ar: 'الأصول' } },
  maintenanceNumber: { prefix: 'MNT', label: { en: 'Maintenance requests', ar: 'طلبات الصيانة' } },
} as const

export type NumberKind = keyof typeof NUMBER_KINDS
export const isNumberKind = (k: string): k is NumberKind => Object.hasOwn(NUMBER_KINDS, k)

export const defaultFormat = (kind: NumberKind): NumberFormat => ({
  prefix: NUMBER_KINDS[kind].prefix,
  separator: '-',
  padding: 6,
  includeYear: false,
})

export function formatNumber(format: NumberFormat, seq: number, year: number): string {
  const parts = [format.prefix, ...(format.includeYear ? [String(year)] : []), String(seq).padStart(format.padding, '0')]
  return parts.filter((p) => p !== '').join(format.separator)
}

/** The counter a format uses: yearly formats count per year. */
export const counterId = (tenantId: string, kind: NumberKind, format: NumberFormat, year: number) =>
  format.includeYear ? `${tenantId}:${kind}:${year}` : `${tenantId}:${kind}`

export async function formatFor(ctx: TenantContext, tenantId: string, kind: NumberKind): Promise<NumberFormat> {
  const doc = await ctx.numberingSettings.findOne({ _id: tenantId })
  return { ...defaultFormat(kind), ...(doc?.formats?.[kind] ?? {}) }
}

/** Where each kind's numbers live, to skip one that is already taken. */
function takenCheck(ctx: TenantContext, kind: NumberKind): (n: string) => Promise<boolean> {
  const by = <T extends Document>(col: TenantScope<T>, field: string) => async (n: string) =>
    (await col.countDocuments({ [field]: n } as never)) > 0
  switch (kind) {
    case 'studentNumber':
      return by(ctx.students, 'studentNumber')
    case 'applicationNumber':
      return by(ctx.applications, 'applicationNumber')
    case 'invoiceNumber':
      return by(ctx.invoices, 'invoiceNumber')
    case 'receiptNumber':
      return by(ctx.receipts, 'receiptNumber')
    case 'refundNumber':
      return by(ctx.refunds, 'refundNumber')
    case 'expenseNumber':
      return by(ctx.expenses, 'expenseNumber')
    case 'employeeNumber':
      return by(ctx.employees, 'employeeNumber')
    case 'assetTag':
      return by(ctx.assets, 'assetTag')
    case 'maintenanceNumber':
      return by(ctx.maintenanceRequests, 'requestNumber')
  }
}

/** The next number for `kind`, in the school's format. */
export async function nextNumber(ctx: TenantContext, tenantId: string, kind: NumberKind, now = new Date()): Promise<string> {
  const format = await formatFor(ctx, tenantId, kind)
  const year = now.getUTCFullYear()
  const taken = takenCheck(ctx, kind)
  for (let i = 0; i < 1000; i++) {
    const updated = await ctx.financeCounters.findOneAndUpdate(
      { _id: counterId(tenantId, kind, format, year) },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    )
    const number = formatNumber(format, updated!.seq, year)
    if (!(await taken(number))) return number
  }
  throw new Error(`no free ${kind} after 1000 tries`)
}

/** The number the next record would get (without taking it). */
export async function previewNext(ctx: TenantContext, tenantId: string, kind: NumberKind, format: NumberFormat, now = new Date()) {
  const year = now.getUTCFullYear()
  const counter = await ctx.financeCounters.findOne({ _id: counterId(tenantId, kind, format, year) })
  const seq = (counter?.seq ?? 0) + 1
  return { seq, example: formatNumber(format, seq, year) }
}
