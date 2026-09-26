import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { BookCopyDoc, BookDoc, LibrarySettingsDoc, LoanDoc, TenantContext } from '../db.js'
import { callerBranchIds, callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, todayIso, transact } from '../records.js'
import { addDays, checkCode, daysBetween, escapeRegex } from './common.js'
import { chargeStudents } from '../finance/service.js'
import { libraryOverdueNotices } from '../communication/notices.js'
import { loadCommunication } from '../communication/settings.js'
import { nudgeQueue } from '../notifications/messages.js'

/**
 * SAMS 5.5: the library. A title (book) has physical copies, each with a
 * unique barcode and a home branch. A copy is lent to a student or an
 * employee for `loanDays`; a borrower holds at most `maxLoans` and cannot
 * borrow while a fine is unpaid. Returning late fixes a fine of
 * `finePerDay` per day overdue; a lost copy is charged `lostFee`. Fines are
 * settled (paid at the desk) or waived with a reason.
 */

const DEFAULT_SETTINGS = { loanDays: 14, maxLoans: 3, maxRenewals: 1, finePerDay: 10, lostFee: 1000 }

const date = z.string().date()
const bookBody = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).nullable().default(null),
  isbn: z.string().trim().max(20).nullable().default(null),
  publisher: z.string().trim().max(200).nullable().default(null),
  year: z.number().int().min(1000).max(2100).nullable().default(null),
  categoryCode: z.string().max(64).nullable().default(null),
  language: z.string().trim().max(30).nullable().default(null),
})
const copyBody = z.object({
  branchId: z.string().min(1),
  barcode: z.string().trim().min(1).max(40),
  shelf: z.string().trim().max(40).nullable().default(null),
})
const loanBody = z.object({
  barcode: z.string().trim().min(1).max(40),
  borrowerType: z.enum(['student', 'employee']),
  borrowerId: z.string().min(1),
  loanedAt: date.optional(),
})
const settingsBody = z.object({
  loanDays: z.number().int().min(1).max(365),
  maxLoans: z.number().int().min(1).max(50),
  maxRenewals: z.number().int().min(0).max(10),
  finePerDay: z.number().int().min(0),
  lostFee: z.number().int().min(0),
})
const loanQuery = z.object({
  branchId: z.string().optional(),
  view: z.enum(['open', 'overdue', 'fines', 'all']).default('open'),
  borrowerId: z.string().optional(),
})

async function settingsOf(ctx: TenantContext, tenantId: string): Promise<Omit<LibrarySettingsDoc, '_id' | 'tenantId' | 'updatedAt'>> {
  const s = await ctx.librarySettings.findOne({ _id: tenantId })
  return s ? { loanDays: s.loanDays, maxLoans: s.maxLoans, maxRenewals: s.maxRenewals, finePerDay: s.finePerDay, lostFee: s.lostFee } : DEFAULT_SETTINGS
}

/** What a still-open loan would owe if returned `today`. */
export const accruing = (loan: LoanDoc, finePerDay: number, today: string) =>
  loan.returnedAt || loan.lostAt ? loan.fine : Math.max(0, daysBetween(loan.dueDate, today)) * finePerDay

const bookResponse = (b: BookDoc, copies: BookCopyDoc[] = []) => ({
  id: b._id,
  title: b.title,
  author: b.author,
  isbn: b.isbn,
  publisher: b.publisher,
  year: b.year,
  categoryCode: b.categoryCode,
  language: b.language,
  active: b.active,
  copies: copies.map((c) => ({ id: c._id, barcode: c.barcode, branchId: c.branchId, shelf: c.shelf, status: c.status })),
  available: copies.filter((c) => c.status === 'available').length,
})

async function borrowerName(ctx: TenantContext, type: 'student' | 'employee', id: string) {
  const doc = type === 'student' ? await ctx.students.findOne({ _id: id }) : await ctx.employees.findOne({ _id: id })
  return doc ? { name: `${doc.givenName} ${doc.familyName}`.trim(), branchId: doc.branchId, active: type === 'student' ? true : (doc as { status: string }).status === 'active' } : null
}

function loanResponse(l: LoanDoc, extra: { title?: string; barcode?: string; borrower?: string }, finePerDay: number, today: string) {
  return {
    id: l._id,
    copyId: l.copyId,
    bookId: l.bookId,
    title: extra.title ?? null,
    barcode: extra.barcode ?? null,
    branchId: l.branchId,
    borrowerType: l.borrowerType,
    borrowerId: l.borrowerId,
    borrowerName: extra.borrower ?? null,
    loanedAt: l.loanedAt,
    dueDate: l.dueDate,
    returnedAt: l.returnedAt,
    lostAt: l.lostAt,
    renewals: l.renewals,
    overdue: !l.returnedAt && !l.lostAt && l.dueDate < today,
    fine: accruing(l, finePerDay, today),
    fineStatus: l.fineStatus,
  }
}

export function registerLibraryRoutes(app: FastifyInstance): void {
  app.get('/ops/library/settings', scoped('ops.read'), async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    return reply.send(await withTenant(tenantId, (ctx) => settingsOf(ctx, tenantId)))
  })

  app.put('/ops/library/settings', scoped('ops.library.manage'), async (request, reply) => {
    const parsed = settingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    await withTenant(tenantId, async (ctx) => {
      await ctx.librarySettings.findOneAndUpdate({ _id: tenantId }, { $set: { ...parsed.data, updatedAt: new Date() }, $setOnInsert: { tenantId } }, { upsert: true })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'library.settings', entity: 'library', entityId: tenantId, after: parsed.data })
    })
    return reply.send(parsed.data)
  })

  // ------------------------------------------------------------ catalogue

  app.get('/ops/library/books', scoped('ops.read'), async (request, reply) => {
    const { q, branchId } = request.query as { q?: string; branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<BookDoc> = { active: true }
    if (q?.trim()) {
      const re = new RegExp(escapeRegex(q.trim()), 'i')
      filter.$or = [{ title: re }, { author: re }, { isbn: re }]
    }
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      let books = await ctx.books.find(filter).sort({ title: 1 }).limit(500).toArray()
      // A barcode search finds the copy's title too.
      if (q?.trim()) {
        const copy = await ctx.bookCopies.findOne({ barcode: q.trim() })
        if (copy && !books.some((b) => b._id === copy.bookId)) {
          const b = await ctx.books.findOne({ _id: copy.bookId })
          if (b) books = [b, ...books]
        }
      }
      const copies = await ctx.bookCopies
        .find({ bookId: { $in: books.map((b) => b._id) }, ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}) })
        .toArray()
      return { books, copies }
    })
    return reply.send({ books: data.books.map((b) => bookResponse(b, data.copies.filter((c) => c.bookId === b._id))) })
  })

  app.post('/ops/library/books', scoped('ops.library.manage'), async (request, reply) => {
    const parsed = bookBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    if (!(await checkCode(tenantId, 'bookCategory', parsed.data.categoryCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const now = new Date()
    const doc: BookDoc = { _id: randomUUID(), tenantId, ...parsed.data, active: true, createdAt: now, updatedAt: now }
    await withTenant(tenantId, async (ctx) => {
      await ctx.books.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'book.create', entity: 'book', entityId: doc._id, after: doc })
    })
    return reply.code(201).send(bookResponse(doc))
  })

  app.patch('/ops/library/books/:id', scoped('ops.library.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = bookBody.partial().extend({ active: z.boolean().optional() }).safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    if (parsed.data.categoryCode && !(await checkCode(tenantId, 'bookCategory', parsed.data.categoryCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const after = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.books.findOne({ _id: id })
      if (!before) return null
      const after = await ctx.books.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'book.update', entity: 'book', entityId: id, before, after })
      return after
    })
    if (!after) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(bookResponse(after))
  })

  app.post('/ops/library/books/:id/copies', scoped('ops.library.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = copyBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const result = await transact(
      tenantId,
      async (ctx) => {
        if (!(await ctx.books.findOne({ _id: id }))) throw new Abort('NOT_FOUND')
        const now = new Date()
        const doc: BookCopyDoc = { _id: randomUUID(), tenantId, bookId: id, ...parsed.data, status: 'available', createdAt: now, updatedAt: now }
        await ctx.bookCopies.insertOne(doc)
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'bookCopy.create', entity: 'book', entityId: id, branchId: doc.branchId, after: doc })
        return doc
      },
      'BARCODE_TAKEN',
    )
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ id: result._id, barcode: result.barcode, branchId: result.branchId, shelf: result.shelf, status: result.status })
  })

  app.post('/ops/library/copies/:id/withdraw', scoped('ops.library.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
    const tenantId = request.auth!.tenantId!
    const copy = await withTenant(tenantId, (ctx) => ctx.bookCopies.findOne({ _id: id }))
    if (!copy) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, copy.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const result = await transact(tenantId, async (ctx) => {
      const after = await ctx.bookCopies.findOneAndUpdate({ _id: id, status: 'available' }, { $set: { status: 'withdrawn', updatedAt: new Date() } }, { returnDocument: 'after' })
      if (!after) throw new Abort('NOT_AVAILABLE')
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'bookCopy.withdraw', entity: 'book', entityId: copy.bookId, branchId: copy.branchId, before: copy, after })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send({ id, status: result.status })
  })

  // --------------------------------------------------------------- loans

  app.get('/ops/library/loans', scoped('ops.read'), async (request, reply) => {
    const parsed = loanQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const today = todayIso()
    const filter: Filter<LoanDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.borrowerId) filter.borrowerId = parsed.data.borrowerId
    if (parsed.data.view === 'open') Object.assign(filter, { returnedAt: null, lostAt: null })
    if (parsed.data.view === 'overdue') Object.assign(filter, { returnedAt: null, lostAt: null, dueDate: { $lt: today } })
    if (parsed.data.view === 'fines') filter.fineStatus = 'due'
    const data = await withTenant(tenantId, async (ctx) => {
      const loans = await ctx.loans.find(filter).sort({ dueDate: 1 }).limit(1000).toArray()
      const [copies, books, students, employees, settings] = await Promise.all([
        ctx.bookCopies.find({ _id: { $in: loans.map((l) => l.copyId) } }).toArray(),
        ctx.books.find({ _id: { $in: loans.map((l) => l.bookId) } }).toArray(),
        ctx.students.find({ _id: { $in: loans.filter((l) => l.borrowerType === 'student').map((l) => l.borrowerId) } }).toArray(),
        ctx.employees.find({ _id: { $in: loans.filter((l) => l.borrowerType === 'employee').map((l) => l.borrowerId) } }).toArray(),
        settingsOf(ctx, tenantId),
      ])
      return { loans, copies, books, people: [...students, ...employees], settings }
    })
    const barcode = new Map(data.copies.map((c) => [c._id, c.barcode]))
    const title = new Map(data.books.map((b) => [b._id, b.title]))
    const person = new Map(data.people.map((p) => [p._id, `${p.givenName} ${p.familyName}`.trim()]))
    return reply.send({
      loans: data.loans.map((l) =>
        loanResponse(l, { title: title.get(l.bookId), barcode: barcode.get(l.copyId), borrower: person.get(l.borrowerId) }, data.settings.finePerDay, today),
      ),
    })
  })

  app.post('/ops/library/loans', scoped('ops.library.manage'), async (request, reply) => {
    const parsed = loanBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const allowed = await callerBranchIds(request)
    const body = parsed.data
    const result = await transact(tenantId, async (ctx) => {
      const copy = await ctx.bookCopies.findOne({ barcode: body.barcode })
      if (!copy) throw new Abort('UNKNOWN_COPY')
      if (allowed !== null && !allowed.includes(copy.branchId)) throw new Abort('BRANCH_FORBIDDEN')
      if (copy.status !== 'available') throw new Abort('NOT_AVAILABLE', { status: copy.status })
      const borrower = await borrowerName(ctx, body.borrowerType, body.borrowerId)
      if (!borrower || !borrower.active) throw new Abort('UNKNOWN_BORROWER')
      const settings = await settingsOf(ctx, tenantId)
      const open = await ctx.loans.countDocuments({ borrowerId: body.borrowerId, returnedAt: null, lostAt: null })
      if (open >= settings.maxLoans) throw new Abort('LOAN_LIMIT', { maxLoans: settings.maxLoans })
      if (await ctx.loans.findOne({ borrowerId: body.borrowerId, fineStatus: 'due' })) throw new Abort('FINES_DUE')
      const loanedAt = body.loanedAt ?? todayIso()
      const now = new Date()
      const loan: LoanDoc = {
        _id: randomUUID(),
        tenantId,
        copyId: copy._id,
        bookId: copy.bookId,
        branchId: copy.branchId,
        borrowerType: body.borrowerType,
        borrowerId: body.borrowerId,
        loanedAt,
        dueDate: addDays(loanedAt, settings.loanDays),
        returnedAt: null,
        lostAt: null,
        renewals: 0,
        fine: 0,
        fineStatus: 'none',
        fineSettledAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.loans.insertOne(loan)
      await ctx.bookCopies.findOneAndUpdate({ _id: copy._id, status: 'available' }, { $set: { status: 'on_loan', updatedAt: now } })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'loan.create', entity: 'loan', entityId: loan._id, branchId: loan.branchId, after: loan })
      return { loan, settings, borrower: borrower.name, barcode: copy.barcode }
    }, 'NOT_AVAILABLE')
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(loanResponse(result.loan, { borrower: result.borrower, barcode: result.barcode }, result.settings.finePerDay, todayIso()))
  })

  const loanAction = (
    path: string,
    run: (ctx: TenantContext, loan: LoanDoc, settings: Awaited<ReturnType<typeof settingsOf>>, body: Record<string, unknown>) => Promise<Partial<LoanDoc>>,
  ) =>
    app.post(`/ops/library/loans/:id/${path}`, scoped('ops.library.manage'), async (request, reply) => {
      const { id } = request.params as { id: string }
      const tenantId = request.auth!.tenantId!
      const existing = await withTenant(tenantId, (ctx) => ctx.loans.findOne({ _id: id }))
      if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
      if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
      const body = (request.body ?? {}) as Record<string, unknown>
      if (path === 'waive') {
        const reason = readReason(body)
        if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
        setAuditReason(reason)
      }
      const result = await transact(tenantId, async (ctx) => {
        const loan = await ctx.loans.findOne({ _id: id })
        if (!loan) throw new Abort('NOT_FOUND')
        const settings = await settingsOf(ctx, tenantId)
        const patch = await run(ctx, loan, settings, body)
        const after = (await ctx.loans.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' }))!
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: `loan.${path}`, entity: 'loan', entityId: id, branchId: loan.branchId, before: loan, after })
        return { after, settings }
      })
      if (isFailure(result)) return sendFailure(reply, result)
      return reply.send(loanResponse(result.after, {}, result.settings.finePerDay, todayIso()))
    })

  const isOpen = (l: LoanDoc) => !l.returnedAt && !l.lostAt

  loanAction('return', async (ctx, loan, settings, body) => {
    if (!isOpen(loan)) throw new Abort('NOT_OPEN')
    const returnedAt = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayIso()
    if (returnedAt < loan.loanedAt) throw new Abort('DATES_OUT_OF_ORDER')
    await ctx.bookCopies.findOneAndUpdate({ _id: loan.copyId }, { $set: { status: 'available', updatedAt: new Date() } })
    const fine = Math.max(0, daysBetween(loan.dueDate, returnedAt)) * settings.finePerDay
    return { returnedAt, fine, fineStatus: fine > 0 ? 'due' : 'none' }
  })

  loanAction('renew', async (_ctx, loan, settings) => {
    if (!isOpen(loan)) throw new Abort('NOT_OPEN')
    if (loan.renewals >= settings.maxRenewals) throw new Abort('RENEWAL_LIMIT')
    if (loan.dueDate < todayIso()) throw new Abort('OVERDUE')
    return { renewals: loan.renewals + 1, dueDate: addDays(loan.dueDate, settings.loanDays) }
  })

  loanAction('lost', async (ctx, loan, settings) => {
    if (!isOpen(loan)) throw new Abort('NOT_OPEN')
    await ctx.bookCopies.findOneAndUpdate({ _id: loan.copyId }, { $set: { status: 'lost', updatedAt: new Date() } })
    const fine = settings.lostFee + Math.max(0, daysBetween(loan.dueDate, todayIso())) * settings.finePerDay
    return { lostAt: todayIso(), fine, fineStatus: fine > 0 ? 'due' : 'none' }
  })

  loanAction('pay', async (_ctx, loan) => {
    if (loan.fineStatus !== 'due') throw new Abort('NO_FINE_DUE')
    return { fineStatus: 'paid', fineSettledAt: new Date() }
  })

  loanAction('waive', async (_ctx, loan) => {
    if (loan.fineStatus !== 'due') throw new Abort('NO_FINE_DUE')
    return { fineStatus: 'waived', fineSettledAt: new Date() }
  })

  // ------------------------------------------------ SAMS 11.3 desk --

  /** The borrower on an ID card: a student or staff number, as scanned. */
  app.get('/ops/library/borrower', scoped('ops.read'), async (request, reply) => {
    const card = String((request.query as { card?: string }).card ?? '').trim()
    if (!card || card.length > 60) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const tenantId = request.auth!.tenantId!
    const allowed = await callerBranchIds(request)
    const out = await withTenant(tenantId, async (ctx) => {
      const student = await ctx.students.findOne({ studentNumber: card })
      const employee = student ? null : await ctx.employees.findOne({ employeeNumber: card })
      const found = student
        ? { type: 'student' as const, id: student._id, name: `${student.givenName} ${student.familyName}`.trim(), branchId: student.branchId, active: student.status === 'enrolled' }
        : employee
          ? { type: 'employee' as const, id: employee._id, name: `${employee.givenName} ${employee.familyName}`.trim(), branchId: employee.branchId, active: employee.status === 'active' }
          : null
      if (!found) return null
      if (allowed !== null && !allowed.includes(found.branchId)) return 'forbidden' as const
      const settings = await settingsOf(ctx, tenantId)
      const loans = await ctx.loans.find({ borrowerId: found.id, $or: [{ returnedAt: null, lostAt: null }, { fineStatus: 'due' }] }).toArray()
      const titles = new Map((await ctx.books.find({ _id: { $in: loans.map((l) => l.bookId) } }).toArray()).map((b) => [b._id, b.title]))
      const copies = new Map((await ctx.bookCopies.find({ _id: { $in: loans.map((l) => l.copyId) } }).toArray()).map((c) => [c._id, c.barcode]))
      const today = todayIso()
      return {
        ...found,
        maxLoans: settings.maxLoans,
        loans: loans.map((l) => loanResponse(l, { title: titles.get(l.bookId), barcode: copies.get(l.copyId), borrower: found.name }, settings.finePerDay, today)),
      }
    })
    if (out === null) return reply.code(404).send({ error: 'UNKNOWN_CARD' })
    if (out === 'forbidden') return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    return reply.send(out)
  })

  /** Return by scanning the copy: finds its open loan. */
  app.post('/ops/library/return-by-barcode', scoped('ops.library.manage'), async (request, reply) => {
    const barcode = String((request.body as { barcode?: string } | undefined)?.barcode ?? '').trim()
    if (!barcode) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const loan = await withTenant(tenantId, async (ctx) => {
      const copy = await ctx.bookCopies.findOne({ barcode })
      return copy ? ctx.loans.findOne({ copyId: copy._id, returnedAt: null, lostAt: null }) : null
    })
    if (!loan) return reply.code(404).send({ error: 'NO_OPEN_LOAN' })
    const res = await app.inject({
      method: 'POST',
      url: `${request.routeOptions.url?.replace('/ops/library/return-by-barcode', '') ?? ''}/ops/library/loans/${loan._id}/return`,
      headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' },
      payload: {},
    })
    return reply.code(res.statusCode).type('application/json').send(res.body)
  })

  /** A student's fine onto their invoice for the year (it then counts as
   * settled at the library; the family pays it with their fees). */
  app.post('/ops/library/loans/:id/bill', scoped('ops.library.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const existing = await withTenant(tenantId, (ctx) => ctx.loans.findOne({ _id: id }))
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const result = await transact(tenantId, async (ctx) => {
      const loan = await ctx.loans.findOne({ _id: id })
      if (!loan || loan.fineStatus !== 'due') throw new Abort('NO_FINE_DUE')
      if (loan.borrowerType !== 'student') throw new Abort('STUDENTS_ONLY')
      const student = await ctx.students.findOne({ _id: loan.borrowerId })
      if (!student?.academicYearId) throw new Abort('NO_INVOICE')
      const book = await ctx.books.findOne({ _id: loan.bookId })
      const charged = await chargeStudents(ctx, {
        academicYearId: student.academicYearId,
        charges: [{ studentId: student._id, amount: loan.fine }],
        label: `Library fine — ${book?.title ?? ''}`.trim(),
        labelAr: `غرامة مكتبة — ${book?.title ?? ''}`.trim(),
        sourceFeeItemId: `library:${loan._id}`,
        actorId: request.auth!.sub,
      })
      if (charged.noInvoice.length > 0) throw new Abort('NO_INVOICE')
      const after = (await ctx.loans.findOneAndUpdate(
        { _id: id, fineStatus: 'due' },
        { $set: { fineStatus: 'billed', fineSettledAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' },
      ))!
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'loan.bill',
        entity: 'loan',
        entityId: id,
        branchId: loan.branchId,
        before: { fineStatus: 'due' },
        after: { fineStatus: 'billed', fine: loan.fine, invoiceId: charged.charged[0]?.invoiceId ?? null },
      })
      return { after, invoiceId: charged.charged[0]?.invoiceId ?? null, settings: await settingsOf(ctx, tenantId) }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send({ ...loanResponse(result.after, {}, result.settings.finePerDay, todayIso()), invoiceId: result.invoiceId })
  })

  /** Tells the families of students with overdue books now (the daily run
   * does it on its own when switched on in Communication). */
  app.post('/ops/library/overdue/notify', scoped('ops.library.manage'), async (request, reply) => {
    const body = (request.body ?? {}) as { branchId?: string; loanIds?: string[] }
    const branches = await branchFilter(request, body.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const out = await withTenant(tenantId, async (ctx) => {
      const settings = await loadCommunication(ctx, tenantId)
      return libraryOverdueNotices(ctx, tenantId, {
        asOf: todayIso(),
        repeatDays: settings.libraryOverdue.repeatDays,
        branchIds: branches.branchIds,
        loanIds: Array.isArray(body.loanIds) ? body.loanIds.filter((x) => typeof x === 'string').slice(0, 500) : undefined,
        trigger: 'manual',
        actorId: request.auth!.sub,
      })
    })
    nudgeQueue()
    return reply.send(out)
  })
}
