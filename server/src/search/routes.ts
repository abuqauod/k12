import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { parentsHiddenFromBranches } from '../parents/service.js'
import type { BusDoc, ParentDoc, SchoolClassDoc, StopDoc, StudentDoc, TenantContext } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerHasPermission,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'

/**
 * A single, small, tenant-scoped fan-out search across the handful of
 * entities worth a quick-jump result: students, parents, classes, buses,
 * stops. Not a generic search framework — five targeted, capped queries,
 * matching the regex-`$or` pattern already used by /students and /parents'
 * own `search` query param.
 */

const searchQuery = z.object({
  q: z.string().min(2).max(100),
  branchId: z.string().optional(),
})

const PER_TYPE_LIMIT = 5

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type SearchResultType = 'student' | 'parent' | 'class' | 'bus' | 'stop' | 'enrollment' | 'invoice' | 'payment'

export interface SearchResult {
  type: SearchResultType
  id: string
  label: string
  meta: string | null
  branchId: string | null
}

function studentResult(doc: StudentDoc): SearchResult {
  return {
    type: 'student',
    id: doc._id,
    label: `${doc.givenName} ${doc.familyName}`.trim(),
    meta: doc.studentNumber || doc.primaryPhone || null,
    branchId: doc.branchId,
  }
}

function parentResult(doc: ParentDoc): SearchResult {
  return {
    type: 'parent',
    id: doc._id,
    label: doc.fullName,
    meta: doc.primaryPhone || doc.email || null,
    branchId: null,
  }
}

function classResult(doc: SchoolClassDoc): SearchResult {
  return {
    type: 'class',
    id: doc._id,
    label: `${doc.gradeLevel} ${doc.name}`.trim(),
    meta: null,
    branchId: doc.branchId,
  }
}

function busResult(doc: BusDoc): SearchResult {
  return { type: 'bus', id: doc._id, label: doc.name, meta: null, branchId: doc.branchId }
}

function stopResult(doc: StopDoc): SearchResult {
  return { type: 'stop', id: doc._id, label: doc.name, meta: null, branchId: doc.branchId }
}

async function runSearch(
  ctx: TenantContext,
  pattern: { $regex: string; $options: string },
  branchFilter: { branchId?: string | { $in: string[] } },
  /** Parents outside the caller's branches (SAMS 1.9) — see parents/service.ts. */
  hiddenParentIds: Set<string> = new Set(),
): Promise<SearchResult[]> {
  const [students, parents, classes, buses, stops] = await Promise.all([
    ctx.students
      .find({
        status: 'enrolled',
        ...branchFilter,
        $or: [
          { givenName: pattern },
          { familyName: pattern },
          { studentNumber: pattern },
          { primaryPhone: pattern },
          { secondaryPhone: pattern },
        ],
      })
      .limit(PER_TYPE_LIMIT)
      .toArray(),
    ctx.parents
      .find({
        status: { $ne: 'archived' },
        ...(hiddenParentIds.size > 0 ? { _id: { $nin: [...hiddenParentIds] } } : {}),
        $or: [
          { fullName: pattern },
          { fullNameAr: pattern },
          { primaryPhone: pattern },
          { alternativePhone: pattern },
          { email: pattern },
        ],
      })
      .limit(PER_TYPE_LIMIT)
      .toArray(),
    ctx.classes
      .find({ active: true, ...branchFilter, $or: [{ name: pattern }, { gradeLevel: pattern }] })
      .limit(PER_TYPE_LIMIT)
      .toArray(),
    ctx.buses
      .find({ active: true, ...branchFilter, name: pattern })
      .limit(PER_TYPE_LIMIT)
      .toArray(),
    ctx.stops
      .find({ active: true, ...branchFilter, name: pattern })
      .limit(PER_TYPE_LIMIT)
      .toArray(),
  ])
  return [
    ...students.map(studentResult),
    ...parents.map(parentResult),
    ...classes.map(classResult),
    ...buses.map(busResult),
    ...stops.map(stopResult),
  ]
}

/**
 * Administrative records (SAMS 1.12): enrollments, invoices, payments. Each
 * type only runs when the caller holds its read scope, and stays inside
 * the same branch filter as everything else.
 */
async function runRecordSearch(
  ctx: TenantContext,
  pattern: { $regex: string; $options: string },
  branchFilter: { branchId?: string | { $in: string[] } },
  allow: { enrollments: boolean; finance: boolean },
): Promise<SearchResult[]> {
  const results: SearchResult[] = []

  if (allow.enrollments) {
    // Any status — a withdrawn student is exactly who an admin looks up here.
    const students = await ctx.students
      .find({ ...branchFilter, $or: [{ givenName: pattern }, { familyName: pattern }, { studentNumber: pattern }] })
      .limit(PER_TYPE_LIMIT)
      .toArray()
    for (const student of students) {
      const [latest] = await ctx.enrollments.find({ studentId: student._id }).sort({ startDate: -1 }).limit(1).toArray()
      if (!latest) continue
      results.push({
        type: 'enrollment',
        id: student._id,
        label: `${student.givenName} ${student.familyName}`.trim(),
        meta: `${student.studentNumber} · ${latest.status}`,
        branchId: latest.branchId,
      })
    }
  }

  if (allow.finance) {
    const invoices = await ctx.invoices
      .find({ ...branchFilter, invoiceNumber: pattern })
      .limit(PER_TYPE_LIMIT)
      .toArray()
    for (const invoice of invoices) {
      results.push({
        type: 'invoice',
        id: invoice._id,
        label: invoice.invoiceNumber,
        meta: invoice.status,
        branchId: invoice.branchId,
      })
    }

    // Payments carry no branch of their own: they follow their invoice.
    const payments = await ctx.payments
      .find({ $or: [{ reference: pattern }, { payerName: pattern }] })
      .limit(PER_TYPE_LIMIT * 4)
      .toArray()
    const owners = await ctx.invoices
      .find({ _id: { $in: payments.map((p) => p.invoiceId) }, ...branchFilter })
      .toArray()
    const byId = new Map(owners.map((i) => [i._id, i]))
    for (const payment of payments) {
      const invoice = byId.get(payment.invoiceId)
      if (!invoice) continue
      results.push({
        type: 'payment',
        id: invoice._id,
        label: payment.reference || payment.payerName,
        meta: `${invoice.invoiceNumber} · ${payment.voidedAt ? 'void' : payment.method}`,
        branchId: invoice.branchId,
      })
      if (results.filter((r) => r.type === 'payment').length >= PER_TYPE_LIMIT) break
    }
  }

  return results
}

export function registerSearchRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('search.read')] }

  app.get('/search', readGuard, async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { q, branchId } = parsed.data

    const allowed = await callerBranchIds(request)
    if (branchId && allowed !== null && !allowed.includes(branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const branchFilter: { branchId?: string | { $in: string[] } } = {}
    if (branchId) branchFilter.branchId = branchId
    else if (allowed !== null) branchFilter.branchId = { $in: allowed }

    const pattern = { $regex: escapeRegex(q), $options: 'i' }
    // Parents have no branch of their own; they follow their children's.
    const parentScope = branchId ? [branchId] : allowed
    const allow = {
      enrollments: await callerHasPermission(request, 'enrollments.read'),
      finance: await callerHasPermission(request, 'finance.read'),
    }
    const results = await withTenant(request.auth!.tenantId!, async (ctx) => [
      ...(await runSearch(
        ctx,
        pattern,
        branchFilter,
        parentScope ? await parentsHiddenFromBranches(ctx, parentScope) : undefined,
      )),
      ...(await runRecordSearch(ctx, pattern, branchFilter, allow)),
    ])
    return reply.send({ results })
  })
}
