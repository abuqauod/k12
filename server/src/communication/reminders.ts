import type { InvoiceDoc, TenantContext } from '../db.js'
import { invoicePaidTotals } from '../finance/service.js'
import { installmentViews } from '../finance/installments.js'
import { money } from '../records.js'
import { notifyFamilies, schoolName, type Delivered } from '../notifications/messages.js'

/**
 * SAMS 6.3 fee reminders. An invoice is due for a reminder when money on it
 * falls due within `daysBefore` days (or already has): with an installment
 * plan, the unpaid installments due by then; without one, the whole balance
 * by the invoice's due date. Reminders go to the parents responsible for
 * fees, and one invoice is reminded at most every `repeatDays` days
 * (`InvoiceDoc.remindedAt`).
 */

export interface DueRow {
  invoiceId: string
  invoiceNumber: string
  studentId: string
  studentName: string
  branchId: string
  dueDate: string
  amountDue: number
  overdue: boolean
  remindedAt: string | null
  /** Reminded too recently to be sent again now. */
  recent: boolean
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function dueNow(invoice: InvoiceDoc, paid: number, asOf: string, horizon: string): { dueDate: string; amount: number } | null {
  const plan = invoice.installments ?? []
  if (plan.length > 0) {
    const open = installmentViews(plan, paid, asOf).filter((v) => v.status !== 'paid' && v.dueDate <= horizon)
    if (open.length === 0) return null
    return { dueDate: open[0]!.dueDate, amount: open.reduce((s, v) => s + v.amount - v.paid, 0) }
  }
  const dueDate = invoice.dueDate ?? invoice.issueDate
  if (dueDate > horizon) return null
  return { dueDate, amount: invoice.total - paid }
}

export async function dueReminders(
  ctx: TenantContext,
  params: { branchIds: string[] | null; asOf: string; daysBefore: number; repeatDays: number; invoiceIds?: string[] },
): Promise<DueRow[]> {
  const filter: Record<string, unknown> = { status: { $in: ['open', 'partially_paid'] } }
  if (params.branchIds) filter.branchId = { $in: params.branchIds }
  if (params.invoiceIds) filter._id = { $in: params.invoiceIds }
  const invoices = await ctx.invoices.find(filter).toArray()
  if (invoices.length === 0) return []
  const paid = await invoicePaidTotals(
    ctx,
    invoices.map((i) => i._id),
  )
  const students = await ctx.students.find({ _id: { $in: [...new Set(invoices.map((i) => i.studentId))] } }).toArray()
  const nameOf = new Map(students.map((s) => [s._id, `${s.givenName} ${s.familyName}`.trim()]))
  const horizon = addDays(params.asOf, params.daysBefore)
  const cutoff = addDays(params.asOf, -params.repeatDays)

  const rows: DueRow[] = []
  for (const invoice of invoices) {
    const due = dueNow(invoice, paid.get(invoice._id) ?? 0, params.asOf, horizon)
    if (!due || due.amount <= 0) continue
    const remindedAt = invoice.remindedAt ?? null
    rows.push({
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      studentId: invoice.studentId,
      studentName: nameOf.get(invoice.studentId) ?? '',
      branchId: invoice.branchId,
      dueDate: due.dueDate,
      amountDue: due.amount,
      overdue: due.dueDate < params.asOf,
      remindedAt,
      recent: remindedAt !== null && remindedAt > cutoff,
    })
  }
  return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber))
}

export interface ReminderOutcome extends Delivered {
  invoices: number
  skippedRecent: number
  unreachable: number
}

/** Sends reminders for `rows` that weren't reminded recently, and stamps them. */
export async function sendReminders(
  ctx: TenantContext,
  tenantId: string,
  rows: DueRow[],
  params: { asOf: string; trigger: 'auto' | 'manual'; actorId: string | null },
): Promise<ReminderOutcome> {
  const out: ReminderOutcome = { invoices: 0, skippedRecent: 0, unreachable: 0, families: 0, inApp: 0, email: 0, sms: 0 }
  const school = await schoolName(tenantId)
  for (const row of rows) {
    if (row.recent) {
      out.skippedRecent++
      continue
    }
    const sent = await notifyFamilies(ctx, tenantId, {
      kind: 'fee_reminder',
      sourceId: row.invoiceId,
      dedupe: params.asOf,
      studentIds: [row.studentId],
      recipients: 'financial',
      tokens: (student, parent) => ({
        parentName: parent.fullName,
        studentName: `${student.givenName} ${student.familyName}`.trim(),
        invoiceNumber: row.invoiceNumber,
        amountDue: money(row.amountDue),
        dueDate: row.dueDate,
        schoolName: school,
      }),
      link: (studentId) => `/portal/children/${studentId}?tab=finance`,
      trigger: params.trigger,
      actorId: params.actorId,
    })
    if (sent.families === 0) {
      out.unreachable++
      continue
    }
    await ctx.invoices.findOneAndUpdate({ _id: row.invoiceId }, { $set: { remindedAt: params.asOf } })
    out.invoices++
    out.families += sent.families
    out.inApp += sent.inApp
    out.email += sent.email
    out.sms += sent.sms
  }
  return out
}
