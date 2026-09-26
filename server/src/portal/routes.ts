import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { withTenant, withoutTenant } from '../db.js'
import type { ParentDoc, ParentStudentLinkDoc, StudentDoc, TenantContext } from '../db.js'
import { callerBranchIds } from '../auth/guard.js'
import { parentHiddenFromBranches } from '../parents/service.js'
import { invoicePaidTotals } from '../finance/service.js'
import { loadPaymentSettings } from '../payments/service.js'
import { installmentViews } from '../finance/installments.js'
import { signFileLink } from '../documents/fileTokens.js'
import { scoped, todayIso } from '../records.js'
import { loadCommunication } from '../communication/settings.js'
import { disablePortal, enablePortal, portalStatus, resendInvite } from './access.js'

/**
 * SAMS 6.4, both sides of the parent portal:
 *
 *  - staff (`portal.manage`): see, enable, re-invite and disable a parent's
 *    portal login from the parent record;
 *  - the parent (`portal.parent`): their own children only — the students
 *    whose active link to them grants portal access — with attendance,
 *    finance (only where they are responsible for fees), the document
 *    categories the school shares, and announcements sent to them.
 *
 * Every parent route finds the parent from the signed-in user, never from
 * the URL, and checks each student id against that parent's links.
 */

const studentName = (s: StudentDoc) => `${s.givenName} ${s.familyName}`.trim()

async function staffParent(request: FastifyRequest, reply: FastifyReply): Promise<ParentDoc | null> {
  const { id } = request.params as { id: string }
  const tenantId = request.auth!.tenantId!
  const allowed = await callerBranchIds(request)
  const parent = await withTenant(tenantId, async (ctx) => {
    const p = await ctx.parents.findOne({ _id: id })
    if (!p) return null
    if (allowed !== null && (await parentHiddenFromBranches(ctx, p._id, allowed))) return null
    return p
  })
  if (!parent) {
    await reply.code(404).send({ error: 'NOT_FOUND' })
    return null
  }
  return parent
}

export interface PortalContext {
  parent: ParentDoc
  links: ParentStudentLinkDoc[]
}

/** The signed-in parent and the links that grant portal access. */
export async function portalContext(ctx: TenantContext, userId: string): Promise<PortalContext | null> {
  const parent = await ctx.parents.findOne({ 'portalAccess.userId': userId, 'portalAccess.enabled': true, status: 'active' })
  if (!parent) return null
  const links = await ctx.parentStudentLinks.find({ parentId: parent._id, active: true, portalAccess: true }).toArray()
  return { parent, links }
}

type Handler<T> = (ctx: TenantContext, pc: PortalContext, tenantId: string) => Promise<T | { error: string; status: number }>

async function asParent<T>(request: FastifyRequest, reply: FastifyReply, fn: Handler<T>) {
  const tenantId = request.auth!.tenantId!
  const result = await withTenant(tenantId, async (ctx) => {
    const pc = await portalContext(ctx, request.auth!.sub)
    if (!pc) return { error: 'PORTAL_DISABLED', status: 403 }
    return fn(ctx, pc, tenantId)
  })
  if (result && typeof result === 'object' && 'error' in result && 'status' in result) {
    return reply.code((result as { status: number }).status).send({ error: (result as { error: string }).error })
  }
  return reply.send(result)
}

function childLink(pc: PortalContext, studentId: string): ParentStudentLinkDoc | null {
  return pc.links.find((l) => l.studentId === studentId) ?? null
}

export function registerPortalRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------ staff side --

  app.get('/parents/:id/portal', scoped('portal.manage'), async (request, reply) => {
    const parent = await staffParent(request, reply)
    if (!parent) return
    const children = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const links = await ctx.parentStudentLinks.find({ parentId: parent._id, active: true }).toArray()
      const students = await ctx.students.find({ _id: { $in: links.map((l) => l.studentId) } }).toArray()
      const byId = new Map(students.map((s) => [s._id, s]))
      return links.map((l) => ({
        studentId: l.studentId,
        name: byId.has(l.studentId) ? studentName(byId.get(l.studentId)!) : '',
        portalAccess: l.portalAccess,
        financialResponsibility: l.financialResponsibility,
      }))
    })
    return reply.send({ ...(await portalStatus(parent)), children })
  })

  app.post('/parents/:id/portal/enable', scoped('portal.manage'), async (request, reply) => {
    const parent = await staffParent(request, reply)
    if (!parent) return
    const result = await enablePortal({
      tenantId: request.auth!.tenantId!,
      parent,
      actorId: request.auth!.sub,
      inviterName: request.auth!.email,
    })
    if (!result.ok) return reply.code(result.error === 'EMAIL_REQUIRED' ? 400 : 409).send({ error: result.error })
    const fresh = await withTenant(request.auth!.tenantId!, (ctx) => ctx.parents.findOne({ _id: parent._id }))
    return reply.send({ ...(await portalStatus(fresh!)), outcome: result.outcome, emailSent: result.emailSent, emailError: result.emailError })
  })

  app.post('/parents/:id/portal/resend', scoped('portal.manage'), async (request, reply) => {
    const parent = await staffParent(request, reply)
    if (!parent) return
    const result = await resendInvite({ tenantId: request.auth!.tenantId!, parent, inviterName: request.auth!.email })
    if (!result.ok) return reply.code(409).send({ error: result.error })
    return reply.send({ emailSent: result.emailSent, emailError: result.emailError })
  })

  app.post('/parents/:id/portal/disable', scoped('portal.manage'), async (request, reply) => {
    const parent = await staffParent(request, reply)
    if (!parent) return
    const done = await disablePortal({ tenantId: request.auth!.tenantId!, parent, actorId: request.auth!.sub })
    if (!done) return reply.code(409).send({ error: 'NOT_ENABLED' })
    const fresh = await withTenant(request.auth!.tenantId!, (ctx) => ctx.parents.findOne({ _id: parent._id }))
    return reply.send(await portalStatus(fresh!))
  })

  // ----------------------------------------------------- parent side --

  const parentOnly = scoped('portal.parent')

  app.get('/portal/me', parentOnly, (request, reply) =>
    asParent(request, reply, async (ctx, pc, tenantId) => {
      const students = await ctx.students.find({ _id: { $in: pc.links.map((l) => l.studentId) } }).toArray()
      const classes = await ctx.classes.find({ _id: { $in: students.map((s) => s.classId).filter(Boolean) } }).toArray()
      const branches = await ctx.branches.find({ _id: { $in: [...new Set(students.map((s) => s.branchId))] } }).toArray()
      const classById = new Map(classes.map((c) => [c._id, c]))
      const branchById = new Map(branches.map((b) => [b._id, b]))
      const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
      return {
        school: { name: tenant?.name ?? '', nameAr: tenant?.profile?.nameAr ?? null },
        parent: {
          id: pc.parent._id,
          fullName: pc.parent.fullName,
          fullNameAr: pc.parent.fullNameAr,
          email: pc.parent.email,
          preferredLanguage: pc.parent.preferredLanguage ?? 'en',
        },
        children: students.map((s) => {
          const cls = classById.get(s.classId)
          const link = childLink(pc, s._id)!
          return {
            id: s._id,
            name: studentName(s),
            nameAr: [s.givenNameAr, s.familyNameAr].filter(Boolean).join(' ') || null,
            studentNumber: s.studentNumber,
            status: s.status,
            branchName: branchById.get(s.branchId)?.name ?? '',
            className: cls ? `${cls.gradeLevel} ${cls.name}` : null,
            relationship: link.relationshipType,
            finance: link.financialResponsibility,
          }
        }),
      }
    }),
  )

  app.get('/portal/children/:id', parentOnly, (request, reply) =>
    asParent(request, reply, async (ctx, pc) => {
      const { id } = request.params as { id: string }
      const link = childLink(pc, id)
      if (!link) return { error: 'NOT_FOUND', status: 404 }
      const student = await ctx.students.findOne({ _id: id })
      if (!student) return { error: 'NOT_FOUND', status: 404 }
      const year = student.academicYearId ? await ctx.academicYears.findOne({ _id: student.academicYearId }) : null
      const cls = student.classId ? await ctx.classes.findOne({ _id: student.classId }) : null
      const branch = await ctx.branches.findOne({ _id: student.branchId })
      const since = year?.startDate ?? `${todayIso().slice(0, 4)}-01-01`
      const records = await ctx.attendance.find({ studentId: id, date: { $gte: since } }).sort({ date: -1 }).toArray()
      const counts: Record<string, number> = {}
      for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1
      return {
        id: student._id,
        name: studentName(student),
        nameAr: [student.givenNameAr, student.familyNameAr].filter(Boolean).join(' ') || null,
        studentNumber: student.studentNumber,
        dob: student.dob,
        status: student.status,
        branchName: branch?.name ?? '',
        className: cls ? `${cls.gradeLevel} ${cls.name}` : null,
        academicYear: year ? { name: year.name, startDate: year.startDate, endDate: year.endDate } : null,
        finance: link.financialResponsibility,
        attendance: {
          since,
          counts,
          recent: records
            .filter((r) => r.status !== 'present')
            .slice(0, 30)
            .map((r) => ({ date: r.date, status: r.status, note: r.note })),
        },
      }
    }),
  )

  app.get('/portal/children/:id/finance', parentOnly, (request, reply) =>
    asParent(request, reply, async (ctx, pc) => {
      const { id } = request.params as { id: string }
      const link = childLink(pc, id)
      if (!link) return { error: 'NOT_FOUND', status: 404 }
      if (!link.financialResponsibility) return { error: 'FINANCE_NOT_SHARED', status: 403 }
      const invoices = await ctx.invoices.find({ studentId: id, status: { $ne: 'void' } }).sort({ issueDate: -1 }).toArray()
      const paid = await invoicePaidTotals(
        ctx,
        invoices.map((i) => i._id),
      )
      const receipts = await ctx.receipts.find({ studentId: id }).sort({ issueDate: -1 }).limit(50).toArray()
      const today = todayIso()
      const rows = invoices.map((inv) => {
        const p = paid.get(inv._id) ?? 0
        return {
          id: inv._id,
          invoiceNumber: inv.invoiceNumber,
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          status: inv.status,
          total: inv.total,
          paid: p,
          balance: inv.total - p,
          lines: inv.lineItems.map((l) => ({ label: l.label, labelAr: l.labelAr, amount: l.netAmount })),
          adjustments: (inv.adjustments ?? []).map((a) => ({ label: a.label, amount: a.amount })),
          installments: installmentViews(inv.installments ?? [], p, today).map((v) => ({
            dueDate: v.dueDate,
            amount: v.amount,
            paid: v.paid,
            status: v.status,
          })),
        }
      })
      const payments = await loadPaymentSettings(ctx, request.auth!.tenantId!)
      return {
        balance: rows.reduce((s, r) => s + r.balance, 0),
        // SAMS 11.1: whether the family can pay here, and in what currency.
        onlinePayment: payments.enabled && payments.provider !== null ? { currency: payments.currency } : null,
        invoices: rows,
        receipts: receipts.map((r) => ({
          id: r._id,
          receiptNumber: r.receiptNumber,
          issueDate: r.issueDate,
          amount: r.amount,
          method: r.method,
          payerName: r.payerName,
          allocations: (r.allocations ?? []).map((a) => ({ invoiceNumber: a.invoiceNumber, amount: a.amount })),
        })),
      }
    }),
  )

  app.get('/portal/children/:id/documents', parentOnly, (request, reply) =>
    asParent(request, reply, async (ctx, pc, tenantId) => {
      const { id } = request.params as { id: string }
      if (!childLink(pc, id)) return { error: 'NOT_FOUND', status: 404 }
      const settings = await loadCommunication(ctx, tenantId)
      const docs = await ctx.documents
        .find({
          ownerType: 'student',
          ownerId: id,
          isCurrent: true,
          archivedAt: null,
          categoryCode: { $in: settings.portalDocumentCategories },
          'verification.status': 'verified',
        })
        .sort({ createdAt: -1 })
        .toArray()
      const labels = await ctx.lookups
        .find({ kind: 'documentCategory', code: { $in: [...new Set(docs.map((d) => d.categoryCode))] } })
        .toArray()
      const labelOf = new Map(labels.map((l) => [l.code, l]))
      return {
        documents: docs.map((d) => ({
          id: d._id,
          category: d.categoryCode,
          categoryLabel: labelOf.get(d.categoryCode)?.label ?? d.categoryCode,
          categoryLabelAr: labelOf.get(d.categoryCode)?.labelAr ?? null,
          fileName: d.fileName,
          mime: d.mime,
          size: d.size,
          expiresAt: d.expiresAt,
          uploadedAt: d.createdAt.toISOString(),
        })),
      }
    }),
  )

  app.post('/portal/documents/:id/link', parentOnly, (request, reply) =>
    asParent(request, reply, async (ctx, pc, tenantId) => {
      const { id } = request.params as { id: string }
      const { download } = (request.body ?? {}) as { download?: boolean }
      const doc = await ctx.documents.findOne({ _id: id })
      const settings = await loadCommunication(ctx, tenantId)
      // The same rules as the list: a shared category, verified, current,
      // and a child of this parent.
      if (
        !doc ||
        doc.ownerType !== 'student' ||
        !childLink(pc, doc.ownerId) ||
        !doc.isCurrent ||
        doc.archivedAt ||
        doc.verification.status !== 'verified' ||
        !settings.portalDocumentCategories.includes(doc.categoryCode)
      ) {
        return { error: 'NOT_FOUND', status: 404 }
      }
      const link = await signFileLink({ tenantId, documentId: id, userId: request.auth!.sub, download: download === true })
      return { token: link.token, expiresAt: link.expiresAt.toISOString() }
    }),
  )

  app.get('/portal/announcements', parentOnly, (request, reply) =>
    asParent(request, reply, async (ctx, pc) => {
      const ids = pc.links.map((l) => l.studentId)
      const rows = await ctx.announcements
        .find({ status: 'published', studentIds: { $in: ids } })
        .sort({ publishedAt: -1 })
        .limit(50)
        .toArray()
      return {
        announcements: rows.map((a) => ({
          id: a._id,
          title: a.title,
          body: a.body,
          titleAr: a.titleAr,
          bodyAr: a.bodyAr,
          publishedAt: a.publishedAt?.toISOString() ?? null,
          children: a.studentIds.filter((s) => ids.includes(s)),
        })),
      }
    }),
  )
}
