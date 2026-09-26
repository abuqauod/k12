import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { tenantHasModule } from '../billing/usage.js'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { StudentDoc, TenantContext } from '../db.js'
import { callerBranchIds, callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, transact } from '../records.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { portalContext } from '../portal/routes.js'
import { apiBaseOf, loadPaymentSettings, onlinePaymentResponse, startCheckout, WALLET_TOPUP_MAX, WALLET_TOPUP_MIN } from '../payments/service.js'
import { creditWallet, debitWallet, spentToday, walletOf, walletTxResponse } from './wallet.js'

/**
 * SAMS 11.4 — the canteen and students' wallets:
 *  - products per branch (`canteen.manage`);
 *  - the till (`canteen.sell`): the ID card is scanned, products tapped, the
 *    wallet charged — refused if the balance is short, over the parent's
 *    daily limit, or a category the parent blocked;
 *  - top-ups at the office (`canteen.manage`) or online by the family
 *    through the school's gateway (SAMS 11.1), and a same-day refund;
 *  - the family's view in the portal: balance, statement, top-up, controls.
 * The till sees only a student's name, number and whether they can buy —
 * never the rest of the record.
 */

const productBody = z.object({
  branchId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  nameAr: z.string().trim().max(80).nullable().default(null),
  price: z.number().int().min(0).max(1_000_000),
  categoryCode: z.string().max(64).nullable().default(null),
  active: z.boolean().default(true),
})
const saleBody = z
  .object({
    card: z.string().trim().min(1).max(60),
    items: z.array(z.object({ productId: z.string().min(1), qty: z.number().int().min(1).max(50) })).min(1).max(40),
  })
  .strict()
const topupBody = z
  .object({ amount: z.number().int().positive().max(10_000_000), method: z.string().min(1).max(40), reference: z.string().trim().max(80).nullable().default(null) })
  .strict()
const controlsBody = z
  .object({ dailyLimit: z.number().int().min(0).max(1_000_000).nullable(), blockedCategories: z.array(z.string().min(1).max(64)).max(30) })
  .strict()

const studentName = (s: StudentDoc) => `${s.givenName} ${s.familyName}`.trim()

/** A student on a scanned card, in the caller's branches. */
async function studentByCard(ctx: TenantContext, request: FastifyRequest, card: string): Promise<StudentDoc> {
  const student = await ctx.students.findOne({ studentNumber: card })
  if (!student || student.status !== 'enrolled') throw new Abort('UNKNOWN_CARD')
  const allowed = await callerBranchIds(request)
  if (allowed !== null && !allowed.includes(student.branchId)) throw new Abort('BRANCH_FORBIDDEN')
  return student
}

export function registerCanteenRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------ products --

  app.get('/canteen/products', scoped('canteen.sell'), async (request, reply) => {
    const q = request.query as { branchId?: string; all?: string }
    const branches = await branchFilter(request, q.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.canteenProducts
        .find({ ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}), ...(q.all === '1' ? {} : { active: true }) })
        .sort({ categoryCode: 1, name: 1 })
        .toArray(),
    )
    return reply.send({
      products: rows.map((p) => ({ id: p._id, branchId: p.branchId, name: p.name, nameAr: p.nameAr, price: p.price, categoryCode: p.categoryCode, active: p.active })),
    })
  })

  const saveProduct = async (request: FastifyRequest, id: string | null) => {
    const parsed = productBody.safeParse(request.body)
    if (!parsed.success) return { error: 'INVALID_BODY', status: 400 }
    const b = parsed.data
    if (!(await callerCanUseBranch(request, b.branchId))) return { error: 'BRANCH_FORBIDDEN', status: 403 }
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, 'canteenCategory')
    return withTenant(tenantId, async (ctx) => {
      if (b.categoryCode && !(await activeCodes(ctx, 'canteenCategory')).has(b.categoryCode)) return { error: 'INVALID_CATEGORY', status: 400 }
      const now = new Date()
      if (id) {
        const before = await ctx.canteenProducts.findOne({ _id: id })
        if (!before) return { error: 'NOT_FOUND', status: 404 }
        if (!(await callerCanUseBranch(request, before.branchId))) return { error: 'BRANCH_FORBIDDEN', status: 403 }
        await ctx.canteenProducts.findOneAndUpdate({ _id: id }, { $set: { ...b, updatedAt: now } })
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'canteen.product.update', entity: 'canteenProduct', entityId: id, branchId: b.branchId, before, after: b })
        return { id }
      }
      const _id = randomUUID()
      await ctx.canteenProducts.insertOne({ _id, ...b, createdAt: now, updatedAt: now })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'canteen.product.create', entity: 'canteenProduct', entityId: _id, branchId: b.branchId, before: null, after: b })
      return { id: _id }
    })
  }
  app.post('/canteen/products', scoped('canteen.manage'), async (request, reply) => {
    const out = await saveProduct(request, null)
    return 'error' in out ? reply.code(out.status as number).send({ error: out.error }) : reply.code(201).send(out)
  })
  app.patch('/canteen/products/:id', scoped('canteen.manage'), async (request, reply) => {
    const out = await saveProduct(request, (request.params as { id: string }).id)
    return 'error' in out ? reply.code(out.status as number).send({ error: out.error }) : reply.send(out)
  })

  // ---------------------------------------------------------- till --

  /** What the till shows for a scanned card: name, balance, what's left today. */
  app.get('/canteen/card', scoped('canteen.sell'), async (request, reply) => {
    const card = String((request.query as { card?: string }).card ?? '').trim()
    if (!card) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const student = await studentByCard(ctx, request, card)
      const wallet = (await walletOf(ctx, student._id))!
      const spent = await spentToday(ctx, student._id)
      return {
        studentId: student._id,
        name: studentName(student),
        studentNumber: student.studentNumber,
        balance: wallet.balance,
        active: wallet.active,
        leftToday: wallet.dailyLimit === null ? null : Math.max(0, wallet.dailyLimit - spent),
        blockedCategories: wallet.blockedCategories,
      }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  app.post('/canteen/sales', scoped('canteen.sell'), async (request, reply) => {
    const parsed = saleBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const student = await studentByCard(ctx, request, b.card)
      const wallet = (await walletOf(ctx, student._id))!
      if (!wallet.active) throw new Abort('WALLET_FROZEN')
      const products = await ctx.canteenProducts.find({ _id: { $in: b.items.map((i) => i.productId) }, active: true }).toArray()
      const byId = new Map(products.map((p) => [p._id, p]))
      const items = b.items.map((i) => {
        const p = byId.get(i.productId)
        if (!p || p.branchId !== student.branchId) throw new Abort('UNKNOWN_PRODUCT')
        return { productId: p._id, name: p.name, qty: i.qty, price: p.price, categoryCode: p.categoryCode }
      })
      const blocked = items.find((i) => i.categoryCode && wallet.blockedCategories.includes(i.categoryCode))
      if (blocked) throw new Abort('CATEGORY_BLOCKED', { product: blocked.name })
      const total = items.reduce((sum, i) => sum + i.price * i.qty, 0)
      if (wallet.dailyLimit !== null && (await spentToday(ctx, student._id)) + total > wallet.dailyLimit) {
        throw new Abort('DAILY_LIMIT', { leftToday: Math.max(0, wallet.dailyLimit - (await spentToday(ctx, student._id))) })
      }
      const tx = await debitWallet(ctx, { studentId: student._id, amount: total, type: 'purchase', items, actorId: request.auth!.sub })
      return { ...walletTxResponse(tx), name: studentName(student), total }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(result)
  })

  /** Takes back a sale the same day (wrong item, not served). */
  app.post('/canteen/sales/:id/refund', scoped('canteen.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const sale = await ctx.walletTransactions.findOne({ _id: id, type: 'purchase' })
      if (!sale) throw new Abort('NOT_FOUND')
      if (!(await callerCanUseBranch(request, sale.branchId))) throw new Abort('BRANCH_FORBIDDEN')
      if (sale.voided) throw new Abort('ALREADY_REFUNDED')
      if (sale.createdAt.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) throw new Abort('NOT_TODAY')
      const marked = await ctx.walletTransactions.findOneAndUpdate({ _id: id, voided: false }, { $set: { voided: true } })
      if (!marked) throw new Abort('ALREADY_REFUNDED')
      const tx = await creditWallet(ctx, { studentId: sale.studentId, amount: -sale.amount, type: 'refund', reverses: sale._id, items: sale.items, actorId: request.auth!.sub })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'canteen.sale.refund', entity: 'walletTransaction', entityId: id, branchId: sale.branchId, before: { amount: sale.amount }, after: { refund: tx._id } })
      return walletTxResponse(tx)
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  /** A branch's day at the till. */
  app.get('/canteen/summary', scoped('canteen.manage'), async (request, reply) => {
    const q = request.query as { branchId?: string; date?: string }
    const branches = await branchFilter(request, q.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date! : new Date().toISOString().slice(0, 10)
    const from = new Date(`${day}T00:00:00Z`)
    const to = new Date(from.getTime() + 86_400_000)
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.walletTransactions
        .find({ ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}), createdAt: { $gte: from, $lt: to } })
        .toArray(),
    )
    const sales = rows.filter((r) => r.type === 'purchase' && !r.voided)
    const byProduct = new Map<string, { name: string; qty: number; total: number }>()
    for (const s of sales) {
      for (const i of s.items) {
        const cur = byProduct.get(i.productId) ?? { name: i.name, qty: 0, total: 0 }
        cur.qty += i.qty
        cur.total += i.qty * i.price
        byProduct.set(i.productId, cur)
      }
    }
    return reply.send({
      date: day,
      sales: sales.length,
      salesTotal: -sales.reduce((s, r) => s + r.amount, 0),
      topups: rows.filter((r) => r.type === 'topup').reduce((s, r) => s + r.amount, 0),
      products: [...byProduct.values()].sort((a, b) => b.total - a.total),
    })
  })

  // -------------------------------------------------- the office --

  app.get('/canteen/wallets/:studentId', scoped('canteen.manage'), async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const out = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const student = await ctx.students.findOne({ _id: studentId })
      if (!student) return null
      if (!(await callerCanUseBranch(request, student.branchId))) return 'forbidden' as const
      const wallet = (await walletOf(ctx, studentId))!
      const txs = await ctx.walletTransactions.find({ studentId }).sort({ createdAt: -1 }).limit(100).toArray()
      return { studentId, name: studentName(student), balance: wallet.balance, dailyLimit: wallet.dailyLimit, blockedCategories: wallet.blockedCategories, active: wallet.active, transactions: txs.map(walletTxResponse) }
    })
    if (out === null) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (out === 'forbidden') return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    return reply.send(out)
  })

  app.post('/canteen/wallets/:studentId/topup', scoped('canteen.manage'), async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const parsed = topupBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, 'paymentMethod')
    const result = await transact(tenantId, async (ctx) => {
      const student = await ctx.students.findOne({ _id: studentId })
      if (!student) throw new Abort('NOT_FOUND')
      if (!(await callerCanUseBranch(request, student.branchId))) throw new Abort('BRANCH_FORBIDDEN')
      if (!(await activeCodes(ctx, 'paymentMethod')).has(parsed.data.method)) throw new Abort('INVALID_PAYMENT_METHOD')
      const tx = await creditWallet(ctx, { studentId, amount: parsed.data.amount, type: 'topup', method: parsed.data.method, reference: parsed.data.reference, actorId: request.auth!.sub })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'canteen.wallet.topup', entity: 'walletTransaction', entityId: tx._id, branchId: tx.branchId, before: null, after: { studentId, amount: tx.amount, method: tx.method } })
      return walletTxResponse(tx)
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(result)
  })

  // ------------------------------------------------------ portal --

  const asFamily = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string }
    return withTenant(request.auth!.tenantId!, async (ctx) => {
      const pc = await portalContext(ctx, request.auth!.sub)
      const link = pc?.links.find((l) => l.studentId === id)
      return link && pc ? { parent: pc.parent, link } : null
    })
  }

  app.get('/portal/children/:id/wallet', scoped('portal.parent'), async (request, reply) => {
    const fam = await asFamily(request)
    if (!fam) return reply.code(404).send({ error: 'NOT_FOUND' })
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, 'canteenCategory')
    const out = await withTenant(tenantId, async (ctx) => {
      const wallet = (await walletOf(ctx, id))!
      const txs = await ctx.walletTransactions.find({ studentId: id }).sort({ createdAt: -1 }).limit(50).toArray()
      const payments = await loadPaymentSettings(ctx, tenantId)
      // The portal can't read settings lists: the categories come with it.
      const categories = await ctx.lookups.find({ kind: 'canteenCategory', active: true }).sort({ order: 1 }).toArray()
      return {
        categories: categories.map((c) => ({ code: c.code, label: c.label, labelAr: c.labelAr })),
        balance: wallet.balance,
        dailyLimit: wallet.dailyLimit,
        blockedCategories: wallet.blockedCategories,
        spentToday: await spentToday(ctx, id),
        canTopUp:
          fam.link.financialResponsibility &&
          payments.enabled &&
          payments.provider !== null &&
          (await tenantHasModule(tenantId, 'onlinePayments')),
        canControl: fam.link.financialResponsibility,
        topupMin: WALLET_TOPUP_MIN,
        topupMax: WALLET_TOPUP_MAX,
        currency: payments.currency,
        transactions: txs.map(walletTxResponse),
      }
    })
    return reply.send(out)
  })

  app.put('/portal/children/:id/wallet/controls', scoped('portal.parent'), async (request, reply) => {
    const fam = await asFamily(request)
    if (!fam) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!fam.link.financialResponsibility) return reply.code(403).send({ error: 'FINANCE_NOT_SHARED' })
    const parsed = controlsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { id } = request.params as { id: string }
    const out = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const codes = await activeCodes(ctx, 'canteenCategory')
      if (parsed.data.blockedCategories.some((c) => !codes.has(c))) return null
      await walletOf(ctx, id)
      const before = await ctx.walletAccounts.findOne({ _id: id })
      await ctx.walletAccounts.findOneAndUpdate({ _id: id }, { $set: { dailyLimit: parsed.data.dailyLimit, blockedCategories: parsed.data.blockedCategories, updatedAt: new Date() } })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'canteen.wallet.controls',
        entity: 'walletAccount',
        entityId: id,
        branchId: before?.branchId ?? null,
        before: { dailyLimit: before?.dailyLimit ?? null, blockedCategories: before?.blockedCategories ?? [] },
        after: parsed.data,
      })
      return parsed.data
    })
    if (!out) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    return reply.send(out)
  })

  app.post('/portal/children/:id/wallet/topup', scoped('portal.parent'), async (request, reply) => {
    const fam = await asFamily(request)
    if (!fam) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!fam.link.financialResponsibility) return reply.code(403).send({ error: 'FINANCE_NOT_SHARED' })
    const amount = Number((request.body as { amount?: unknown } | undefined)?.amount)
    if (!Number.isInteger(amount)) return reply.code(400).send({ error: 'INVALID_AMOUNT' })
    const result = await startCheckout({
      tenantId: request.auth!.tenantId!,
      studentId: (request.params as { id: string }).id,
      parentId: fam.parent._id,
      payer: { name: fam.parent.fullName, email: fam.parent.email, phone: fam.parent.primaryPhone },
      amount,
      apiBase: apiBaseOf(request),
      lang: fam.parent.preferredLanguage === 'ar' ? 'ar' : 'en',
      actorId: request.auth!.sub,
      purpose: 'wallet',
    })
    if (!result.ok) return reply.code(result.status).send({ error: result.error })
    return reply.code(201).send({ ...onlinePaymentResponse(result.payment), redirectUrl: result.redirectUrl })
  })
}
