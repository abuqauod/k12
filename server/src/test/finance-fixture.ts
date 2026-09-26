// Shared set-up for the Phase 3 finance tests: a year, one class and one
// fee structure per branch, and helpers that go through the real routes
// (so invoice generation, payments and receipts run exactly as in use).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, type Fixture } from './harness.js'

export interface FinanceFixture {
  yearId: string
  classOf: Record<string, string>
  feeOf: Record<string, string>
  /** A new student enrolled in `branchId`'s class. */
  student(branchId?: string): Promise<string>
  /** A new invoice (Tuition 10,000 + Books 2,000) for a new student, or `studentId`. */
  invoice(opts?: { branchId?: string; studentId?: string; dueDate?: string | null }): Promise<Invoice>
  pay(invoiceId: string, amount: number, extra?: Record<string, unknown>, token?: string): Promise<Record<string, unknown>>
}

export interface Invoice {
  id: string
  studentId: string
  invoiceNumber: string
  total: number
  status: string
  lineItems: { id: string; label: string; amount: number; netAmount: number }[]
}

export async function financeFixture(fx: Fixture): Promise<FinanceFixture> {
  const yearId = randomUUID()
  const classOf: Record<string, string> = {}
  const feeOf: Record<string, string> = {}
  await withTenant(fx.tenantId, (ctx) =>
    ctx.academicYears.insertOne({
      _id: yearId,
      name: '2026–2027',
      startDate: '2026-08-01',
      endDate: '2027-06-30',
      terms: [],
      current: true,
      createdAt: new Date(),
    }),
  )
  for (const branchId of [fx.branchA, fx.branchB]) {
    classOf[branchId] = randomUUID()
    await withTenant(fx.tenantId, (ctx) =>
      ctx.classes.insertOne({
        _id: classOf[branchId]!,
        branchId,
        gradeLevel: 'Grade 5',
        name: 'A',
        capacity: 40,
        homeroomTeacherId: null,
        academicYearId: yearId,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
    const fee = await call(fx.app, fx.tokens.admin, 'POST', '/finance/fee-structures', {
      branchId,
      academicYearId: yearId,
      gradeLevel: 'Grade 5',
      name: 'Grade 5 fees',
      lineItems: [
        { label: 'Tuition', amount: 10000 },
        { label: 'Books', amount: 2000 },
      ],
    })
    assert.equal(fee.status, 201, fee.error)
    feeOf[branchId] = (fee.body as { id: string }).id
  }

  const student = async (branchId = fx.branchA) => {
    const res = await call(fx.app, fx.tokens.admin, 'POST', '/students', {
      studentNumber: `F-${randomUUID().slice(0, 8)}`,
      givenName: 'Sami',
      familyName: 'Fin',
      classId: classOf[branchId],
    })
    assert.equal(res.status, 201, res.error)
    return (res.body as { id: string }).id
  }

  return {
    yearId,
    classOf,
    feeOf,
    student,
    async invoice(opts = {}) {
      const branchId = opts.branchId ?? fx.branchA
      const studentId = opts.studentId ?? (await student(branchId))
      const res = await call(fx.app, fx.tokens.admin, 'POST', '/finance/invoices', {
        studentId,
        feeStructureId: feeOf[branchId],
        dueDate: opts.dueDate ?? null,
      })
      assert.equal(res.status, 201, res.error)
      return res.body as Invoice
    },
    async pay(invoiceId, amount, extra = {}, token = fx.tokens.admin) {
      const res = await call(fx.app, token, 'POST', `/finance/invoices/${invoiceId}/payments`, {
        amount,
        method: 'cash',
        paidAt: '2026-09-01',
        payerName: 'Parent',
        ...extra,
      })
      assert.equal(res.status, 201, res.error)
      return res.body as Record<string, unknown>
    },
  }
}
