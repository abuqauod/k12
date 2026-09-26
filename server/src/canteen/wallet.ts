import { randomUUID } from 'node:crypto'
import type { TenantContext, WalletAccountDoc, WalletTransactionDoc, WalletTxType } from '../db.js'
import { Abort } from '../records.js'

/**
 * SAMS 11.4 — a student's canteen wallet. Every change is a transaction row
 * with the balance after it; the account's balance moves only through
 * `creditWallet` / `debitWallet`, inside the caller's transaction, with a
 * conditional update so two tills can never spend the same money.
 */

export async function walletOf(ctx: TenantContext, studentId: string): Promise<WalletAccountDoc | null> {
  const existing = await ctx.walletAccounts.findOne({ _id: studentId })
  if (existing) return existing
  const student = await ctx.students.findOne({ _id: studentId })
  if (!student) return null
  const doc: WalletAccountDoc = {
    _id: studentId,
    tenantId: '',
    studentId,
    branchId: student.branchId,
    balance: 0,
    dailyLimit: null,
    blockedCategories: [],
    active: true,
    updatedAt: new Date(),
  }
  await ctx.walletAccounts.findOneAndUpdate(
    { _id: studentId },
    { $setOnInsert: { studentId, branchId: student.branchId, balance: 0, dailyLimit: null, blockedCategories: [], active: true, updatedAt: doc.updatedAt } as never },
    { upsert: true },
  )
  return (await ctx.walletAccounts.findOne({ _id: studentId })) ?? doc
}

interface Movement {
  studentId: string
  amount: number
  type: WalletTxType
  method?: string | null
  items?: WalletTransactionDoc['items']
  reference?: string | null
  onlinePaymentId?: string | null
  reverses?: string | null
  actorId: string | null
}

async function move(ctx: TenantContext, m: Movement, signed: number): Promise<WalletTransactionDoc> {
  const account = await walletOf(ctx, m.studentId)
  if (!account) throw new Abort('NOT_FOUND')
  // Only if the money is there (for a debit): no race can overdraw it.
  const updated = await ctx.walletAccounts.findOneAndUpdate(
    { _id: m.studentId, ...(signed < 0 ? { balance: { $gte: -signed } } : {}) },
    { $inc: { balance: signed }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!updated) throw new Abort('INSUFFICIENT_BALANCE', { balance: account.balance })
  const tx: WalletTransactionDoc = {
    _id: randomUUID(),
    tenantId: '',
    studentId: m.studentId,
    branchId: account.branchId,
    type: m.type,
    amount: signed,
    balanceAfter: updated.balance,
    method: m.method ?? null,
    items: m.items ?? [],
    reference: m.reference ?? null,
    onlinePaymentId: m.onlinePaymentId ?? null,
    reverses: m.reverses ?? null,
    voided: false,
    actorId: m.actorId,
    createdAt: new Date(),
  }
  const { tenantId: _t, ...row } = tx
  await ctx.walletTransactions.insertOne(row)
  return tx
}

export const creditWallet = (ctx: TenantContext, m: Movement) => move(ctx, m, Math.abs(m.amount))
export const debitWallet = (ctx: TenantContext, m: Movement) => move(ctx, m, -Math.abs(m.amount))

/** What the student has spent today (UTC day), purchases less refunds. */
export async function spentToday(ctx: TenantContext, studentId: string, now = new Date()): Promise<number> {
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  const rows = await ctx.walletTransactions.find({ studentId, createdAt: { $gte: start }, type: { $in: ['purchase', 'refund'] } }).toArray()
  return -rows.reduce((sum, r) => sum + r.amount, 0)
}

export function walletTxResponse(t: WalletTransactionDoc) {
  return {
    id: t._id,
    type: t.type,
    amount: t.amount,
    balanceAfter: t.balanceAfter,
    method: t.method,
    items: t.items,
    reference: t.reference,
    voided: t.voided,
    createdAt: t.createdAt.toISOString(),
  }
}
