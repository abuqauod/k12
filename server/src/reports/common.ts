import type { FastifyRequest } from 'fastify'
import { withoutTenant } from '../db.js'
import type { AcademicYearDoc, GuardianLanguage, ReportFilters, ReportRange, TenantContext } from '../db.js'
import { callerBranchIds, callerScopes } from '../auth/guard.js'
import { scopesFor, type PermissionScope } from '../auth/scopes.js'
import { LOOKUP_KINDS } from '../settings/lookups.js'

/**
 * SAMS 7.1: the plumbing every report shares — who is asking (a request,
 * or a scheduled export running as its owner), the branches they may see,
 * the lookups and names reports resolve codes to, and the date ranges a
 * schedule uses.
 */

export type Lang = GuardianLanguage
export interface Text {
  en: string
  ar: string
}
export const tx = (en: string, ar: string): Text => ({ en, ar })

/** Who a report runs for: the caller of a request, or a schedule's owner. */
export interface ReportViewer {
  tenantId: string
  userId: string
  scopes: ReadonlySet<PermissionScope>
  /** null = every branch. */
  branchIds: string[] | null
}

export async function viewerFromRequest(request: FastifyRequest): Promise<ReportViewer> {
  return {
    tenantId: request.auth!.tenantId!,
    userId: request.auth!.sub,
    scopes: await callerScopes(request),
    branchIds: await callerBranchIds(request),
  }
}

/** A member as they are right now, or null once they left the school. */
export async function viewerForMember(tenantId: string, userId: string): Promise<ReportViewer | null> {
  const m = await withoutTenant((db) => db.memberships.findOne({ _id: `${tenantId}:${userId}` }))
  if (!m) return null
  return { tenantId, userId, scopes: scopesFor(m.role, m.roleKey), branchIds: m.branchIds ?? null }
}

/** The branches a report covers: the one asked for (if the viewer may see
 * it), else all of the viewer's. `false` when the branch is not theirs. */
export function reportBranches(viewer: ReportViewer, branchId: string | null): string[] | null | false {
  if (branchId) return viewer.branchIds === null || viewer.branchIds.includes(branchId) ? [branchId] : false
  return viewer.branchIds
}

/** True when `wide` (a viewer's branches) covers everything in `narrow`. */
export function coversBranches(wide: string[] | null, narrow: string[] | null): boolean {
  if (wide === null) return true
  if (narrow === null) return false
  return narrow.every((b) => wide.includes(b))
}

export const inBranches = (branchIds: string[] | null) => (branchIds ? { branchId: { $in: branchIds } } : {})

export const EMPTY_FILTERS: ReportFilters = { branchId: null, academicYearId: null, gradeLevel: null, classId: null, status: null }

// ---------------------------------------------------------------- dates --

export const DAY_MS = 86_400_000
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

/** The dates a relative range covers on `today`. */
export function resolveRange(range: ReportRange, today: string, year: AcademicYearDoc | null): { from: string; to: string } {
  const month = today.slice(0, 7)
  switch (range) {
    case 'yesterday': {
      const d = addDays(today, -1)
      return { from: d, to: d }
    }
    case 'last_7_days':
      return { from: addDays(today, -7), to: addDays(today, -1) }
    case 'last_30_days':
      return { from: addDays(today, -30), to: addDays(today, -1) }
    case 'month_to_date':
      return { from: `${month}-01`, to: today }
    case 'previous_month': {
      const last = addDays(`${month}-01`, -1)
      return { from: `${last.slice(0, 7)}-01`, to: last }
    }
    case 'year_to_date':
      return { from: `${today.slice(0, 4)}-01-01`, to: today }
    case 'academic_year':
      return year ? { from: year.startDate, to: year.endDate } : { from: `${today.slice(0, 4)}-01-01`, to: today }
  }
}

// ---------------------------------------------------------- names/labels --

export const pickLang = (lang: Lang, en: string, ar: string | null | undefined) => (lang === 'ar' && ar?.trim()) || en

export const studentLabel = (
  s: { givenName: string; familyName: string; givenNameAr?: string | null; familyNameAr?: string | null },
  lang: Lang,
) => {
  const en = `${s.givenName} ${s.familyName}`.trim()
  const ar = `${s.givenNameAr ?? ''} ${s.familyNameAr ?? ''}`.trim()
  return pickLang(lang, en, ar)
}

/** Code → label for one settings list, in the report's language; an
 * unknown code shows as itself. */
export async function lookupLabels(ctx: TenantContext, kind: string, lang: Lang): Promise<(code: string | null) => string> {
  const rows = await ctx.lookups.find({ kind }).toArray()
  // A list nobody opened yet isn't seeded: its defaults still name the codes.
  const map = new Map((LOOKUP_KINDS[kind]?.defaults ?? []).map((d) => [d.code, pickLang(lang, d.label, d.labelAr)]))
  for (const r of rows) map.set(r.code, pickLang(lang, r.label, r.labelAr))
  return (code) => (code ? (map.get(code) ?? code) : '')
}

export async function branchNames(ctx: TenantContext): Promise<(id: string) => string> {
  const rows = await ctx.branches.find({}).toArray()
  const map = new Map(rows.map((b) => [b._id, b.name]))
  return (id) => map.get(id) ?? ''
}

export async function classNames(ctx: TenantContext): Promise<Map<string, { label: string; gradeLevel: string; capacity: number }>> {
  const rows = await ctx.classes.find({}).toArray()
  return new Map(rows.map((c) => [c._id, { label: `${c.gradeLevel} ${c.name}`.trim(), gradeLevel: c.gradeLevel, capacity: c.capacity }]))
}

/** A report's value labels (statuses and the like) in both languages. */
export const enumLabel = (labels: Record<string, Text>, lang: Lang) => (value: string | null | undefined) =>
  value ? (labels[value]?.[lang] ?? value) : ''
