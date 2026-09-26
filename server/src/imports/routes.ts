import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { TenantContext } from '../db.js'
import { config } from '../config.js'
import { callerBranchIds, callerHasPermission } from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'
import { authenticate, requireActiveSubscription } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { ensureDefaults } from '../settings/lookups.js'
import { csvField, headerKey, parseCsv } from './csv.js'

/**
 * Backlog: bulk import from a spreadsheet (CSV). Students (with an
 * optional parent per row) and employees.
 *
 *  1. `GET /imports/:kind/template` — the columns, as a CSV to fill in.
 *  2. `POST /imports/:kind/preview` — every row checked against the school's
 *     data (classes, settings lists, numbers already used, duplicates in
 *     the file) without writing anything.
 *  3. `POST /imports/:kind/commit` — each valid row is created through the
 *     app's own create endpoints, as the caller: the same validation,
 *     permissions, branch rules, enrollment and audit as creating it by
 *     hand. Rows with problems are skipped and reported by line.
 *
 * Headers are matched loosely (case, spaces, underscores) and in English
 * or Arabic, so a school's own export usually works as it is.
 */

type Kind = 'students' | 'employees'
const MAX_ROWS = 2000

interface ColumnSpec {
  key: string
  required?: boolean
  headers: string[]
  example: string
}

const COLUMNS: Record<Kind, ColumnSpec[]> = {
  students: [
    { key: 'studentNumber', headers: ['student_number', 'student no', 'number', 'رقم الطالب'], example: '' },
    { key: 'givenName', required: true, headers: ['given_name', 'first_name', 'first name', 'الاسم الأول', 'الاسم'], example: 'Layla' },
    { key: 'familyName', required: true, headers: ['family_name', 'last_name', 'surname', 'اسم العائلة'], example: 'Haddad' },
    { key: 'givenNameAr', headers: ['given_name_ar', 'first_name_ar', 'الاسم الأول بالعربية'], example: 'ليلى' },
    { key: 'familyNameAr', headers: ['family_name_ar', 'last_name_ar', 'اسم العائلة بالعربية'], example: 'حداد' },
    { key: 'class', required: true, headers: ['class', 'homeroom', 'section', 'الصف', 'الشعبة'], example: 'Grade 4 A' },
    { key: 'dob', headers: ['dob', 'date_of_birth', 'birth_date', 'تاريخ الميلاد'], example: '2016-03-14' },
    { key: 'gender', headers: ['gender', 'sex', 'الجنس'], example: 'female' },
    { key: 'admissionDate', headers: ['admission_date', 'admitted', 'تاريخ القبول'], example: '2026-09-01' },
    { key: 'nationality', headers: ['nationality', 'الجنسية'], example: 'Jordanian' },
    { key: 'nationalId', headers: ['national_id', 'id_number', 'الرقم الوطني'], example: '' },
    { key: 'address', headers: ['address', 'العنوان'], example: 'Amman' },
    { key: 'primaryPhone', headers: ['phone', 'primary_phone', 'الهاتف'], example: '0791234567' },
    { key: 'parentName', headers: ['parent_name', 'guardian_name', 'اسم ولي الأمر'], example: 'Omar Haddad' },
    { key: 'parentPhone', headers: ['parent_phone', 'guardian_phone', 'هاتف ولي الأمر'], example: '0797654321' },
    { key: 'parentEmail', headers: ['parent_email', 'guardian_email', 'بريد ولي الأمر'], example: 'omar@example.com' },
    { key: 'parentRelationship', headers: ['parent_relationship', 'relationship', 'صلة القرابة'], example: 'Father' },
  ],
  employees: [
    { key: 'givenName', required: true, headers: ['given_name', 'first_name', 'first name', 'الاسم الأول', 'الاسم'], example: 'Rana' },
    { key: 'familyName', required: true, headers: ['family_name', 'last_name', 'surname', 'اسم العائلة'], example: 'Khalil' },
    { key: 'fullNameAr', headers: ['full_name_ar', 'name_ar', 'الاسم بالعربية'], example: 'رنا خليل' },
    { key: 'hireDate', required: true, headers: ['hire_date', 'start_date', 'hired', 'تاريخ التعيين'], example: '2024-08-15' },
    { key: 'branch', headers: ['branch', 'campus', 'الفرع'], example: '' },
    { key: 'department', headers: ['department', 'القسم'], example: 'Teaching' },
    { key: 'position', headers: ['position', 'job_title', 'title', 'الوظيفة'], example: 'Teacher' },
    { key: 'gender', headers: ['gender', 'sex', 'الجنس'], example: 'female' },
    { key: 'dob', headers: ['dob', 'date_of_birth', 'birth_date', 'تاريخ الميلاد'], example: '1990-05-02' },
    { key: 'nationality', headers: ['nationality', 'الجنسية'], example: '' },
    { key: 'nationalId', headers: ['national_id', 'id_number', 'الرقم الوطني'], example: '' },
    { key: 'phone', headers: ['phone', 'mobile', 'الهاتف'], example: '0790000000' },
    { key: 'email', headers: ['email', 'البريد الإلكتروني'], example: 'rana@example.com' },
  ],
}

const SCOPE: Record<Kind, PermissionScope> = { students: 'students.create', employees: 'hr.employee.update' }

const body = z.object({
  csv: z.string().min(1).max(5_000_000),
  branchId: z.string().min(1),
})

const isKind = (k: string): k is Kind => k === 'students' || k === 'employees'
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\-_/]+/g, '')
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').replace(/^(00|962)/, '').replace(/^0+/, '')

/** "2016-03-14", "14/03/2016" or "14-3-2016" → ISO; null if not a date. */
export function parseDate(v: string): string | null {
  const s = v.trim()
  let y: number, m: number, d: number
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])]
  else if ((hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])]
  else return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const t = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null
}

function parseGender(v: string): 'male' | 'female' | null | undefined {
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (['m', 'male', 'boy', 'ذكر', 'ولد'].includes(s)) return 'male'
  if (['f', 'female', 'girl', 'أنثى', 'انثى', 'بنت'].includes(s)) return 'female'
  return undefined
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface ParsedRow {
  line: number
  values: Record<string, string>
  errors: string[]
  /** The request body the row turns into, when it has no errors. */
  payload?: Record<string, unknown>
  parent?: { fullName: string; primaryPhone: string; email: string | null; relationshipType: string } | null
}

/** Maps the header row onto the kind's columns. */
function mapHeaders(kind: Kind, header: string[]) {
  const byAlias = new Map<string, string>()
  for (const c of COLUMNS[kind]) for (const h of [c.key, ...c.headers]) byAlias.set(headerKey(h), c.key)
  const map = header.map((h) => byAlias.get(headerKey(h)) ?? null)
  const missing = COLUMNS[kind].filter((c) => c.required && !map.includes(c.key)).map((c) => c.key)
  const unknown = header.filter((_, i) => map[i] === null && header[i]!.trim() !== '')
  return { map, missing, unknown }
}

async function checkStudents(ctx: TenantContext, branchId: string, rows: ParsedRow[]) {
  const classes = await ctx.classes.find({ branchId, active: true }).toArray()
  const byLabel = new Map(classes.map((c) => [norm(`${c.gradeLevel} ${c.name}`), c._id]))
  const numbers = rows.map((r) => r.values.studentNumber?.trim()).filter(Boolean) as string[]
  const taken = new Set((await ctx.students.find({ studentNumber: { $in: numbers } }).toArray()).map((s) => s.studentNumber))
  const seen = new Set<string>()
  for (const r of rows) {
    const v = r.values
    const e = r.errors
    if (!v.givenName?.trim()) e.push('GIVEN_NAME_REQUIRED')
    if (!v.familyName?.trim()) e.push('FAMILY_NAME_REQUIRED')
    const classId = v.class?.trim() ? byLabel.get(norm(v.class)) : undefined
    if (!v.class?.trim()) e.push('CLASS_REQUIRED')
    else if (!classId) e.push('UNKNOWN_CLASS')
    const number = v.studentNumber?.trim()
    if (number) {
      if (taken.has(number)) e.push('STUDENT_NUMBER_TAKEN')
      if (seen.has(number)) e.push('DUPLICATE_IN_FILE')
      seen.add(number)
    }
    const dob = v.dob?.trim() ? parseDate(v.dob) : null
    if (v.dob?.trim() && !dob) e.push('BAD_DOB')
    const admissionDate = v.admissionDate?.trim() ? parseDate(v.admissionDate) : null
    if (v.admissionDate?.trim() && !admissionDate) e.push('BAD_ADMISSION_DATE')
    const gender = parseGender(v.gender ?? '')
    if (gender === undefined) e.push('BAD_GENDER')
    const hasParent = [v.parentName, v.parentPhone, v.parentEmail].some((x) => x?.trim())
    if (hasParent) {
      if (!v.parentName?.trim()) e.push('PARENT_NAME_REQUIRED')
      if ((v.parentPhone ?? '').replace(/\D/g, '').length < 5) e.push('PARENT_PHONE_REQUIRED')
      if (v.parentEmail?.trim() && !EMAIL.test(v.parentEmail.trim())) e.push('BAD_PARENT_EMAIL')
    }
    if (e.length) continue
    const t = (k: string) => v[k]?.trim() || null
    r.payload = {
      ...(number ? { studentNumber: number } : {}),
      givenName: v.givenName!.trim(),
      familyName: v.familyName!.trim(),
      givenNameAr: t('givenNameAr'),
      familyNameAr: t('familyNameAr'),
      classId,
      dob,
      gender: gender ?? null,
      admissionDate,
      nationality: t('nationality'),
      nationalId: t('nationalId'),
      address: t('address'),
      primaryPhone: v.primaryPhone?.trim() || v.parentPhone?.trim() || '',
    }
    r.parent = hasParent
      ? {
          fullName: v.parentName!.trim(),
          primaryPhone: v.parentPhone!.trim(),
          email: t('parentEmail'),
          relationshipType: t('parentRelationship') ?? 'Guardian',
        }
      : null
  }
}

async function checkEmployees(ctx: TenantContext, tenantId: string, branchId: string, allowed: string[] | null, rows: ParsedRow[]) {
  await ensureDefaults(tenantId, 'department')
  await ensureDefaults(tenantId, 'position')
  const lookups = await ctx.lookups.find({ kind: { $in: ['department', 'position'] }, active: true }).toArray()
  const code = (kind: string, v: string) => {
    const n = norm(v)
    return lookups.find((l) => l.kind === kind && (norm(l.code) === n || norm(l.label) === n || (l.labelAr && norm(l.labelAr) === n)))?.code
  }
  const branches = await ctx.branches.find({}).toArray()
  const branchOf = (v: string) => branches.find((b) => norm(b.name) === norm(v) || norm(b.code) === norm(v) || b._id === v.trim())?._id
  for (const r of rows) {
    const v = r.values
    const e = r.errors
    if (!v.givenName?.trim()) e.push('GIVEN_NAME_REQUIRED')
    if (!v.familyName?.trim()) e.push('FAMILY_NAME_REQUIRED')
    const hireDate = v.hireDate?.trim() ? parseDate(v.hireDate) : null
    if (!hireDate) e.push(v.hireDate?.trim() ? 'BAD_HIRE_DATE' : 'HIRE_DATE_REQUIRED')
    const dob = v.dob?.trim() ? parseDate(v.dob) : null
    if (v.dob?.trim() && !dob) e.push('BAD_DOB')
    const gender = parseGender(v.gender ?? '')
    if (gender === undefined) e.push('BAD_GENDER')
    const rowBranch = v.branch?.trim() ? branchOf(v.branch) : branchId
    if (!rowBranch) e.push('UNKNOWN_BRANCH')
    else if (allowed !== null && !allowed.includes(rowBranch)) e.push('BRANCH_FORBIDDEN')
    const dept = v.department?.trim() ? code('department', v.department) : null
    if (v.department?.trim() && !dept) e.push('UNKNOWN_DEPARTMENT')
    const pos = v.position?.trim() ? code('position', v.position) : null
    if (v.position?.trim() && !pos) e.push('UNKNOWN_POSITION')
    if (v.email?.trim() && !EMAIL.test(v.email.trim())) e.push('BAD_EMAIL')
    if (e.length) continue
    const t = (k: string) => v[k]?.trim() || null
    r.payload = {
      branchId: rowBranch,
      hireDate,
      givenName: v.givenName!.trim(),
      familyName: v.familyName!.trim(),
      fullNameAr: t('fullNameAr'),
      gender: gender ?? null,
      dob,
      nationality: t('nationality'),
      nationalId: t('nationalId'),
      phone: t('phone'),
      email: t('email'),
      departmentCode: dept,
      positionCode: pos,
    }
  }
}

async function prepare(request: FastifyRequest, kind: Kind, csv: string, branchId: string) {
  const table = parseCsv(csv)
  if (table.length < 2) return { error: 'EMPTY_FILE' as const }
  if (table.length - 1 > MAX_ROWS) return { error: 'TOO_MANY_ROWS' as const, max: MAX_ROWS }
  const { map, missing, unknown } = mapHeaders(kind, table[0]!)
  if (missing.length) return { error: 'MISSING_COLUMNS' as const, missing }
  const rows: ParsedRow[] = table.slice(1).map((cells, i) => {
    const values: Record<string, string> = {}
    map.forEach((key, j) => {
      if (key) values[key] = (cells[j] ?? '').trim()
    })
    return { line: i + 2, values, errors: [] }
  })
  const tenantId = request.auth!.tenantId!
  const allowed = await callerBranchIds(request)
  await withTenant(tenantId, (ctx) =>
    kind === 'students' ? checkStudents(ctx, branchId, rows) : checkEmployees(ctx, tenantId, branchId, allowed, rows),
  )
  return { rows, unknown, columns: map.filter(Boolean) as string[] }
}

/** Calls one of the app's own routes as the caller. */
async function internal(app: FastifyInstance, request: FastifyRequest, method: 'POST', url: string, payload: unknown) {
  const res = await app.inject({
    method,
    url: config.routePrefix + url,
    headers: { authorization: request.headers.authorization ?? '' },
    payload: payload as object,
  })
  let json: Record<string, unknown> = {}
  try {
    json = res.json()
  } catch {
    // an empty or non-JSON reply
  }
  return { status: res.statusCode, body: json }
}

export function registerImportRoutes(app: FastifyInstance): void {
  const signedIn = { preHandler: [authenticate, requireActiveSubscription] }
  const allowedKind = async (request: FastifyRequest, kind: string) =>
    isKind(kind) && (await callerHasPermission(request, SCOPE[kind]))

  app.get('/imports/:kind/template', signedIn, async (request, reply) => {
    const { kind } = request.params as { kind: string }
    if (!(await allowedKind(request, kind))) return reply.code(isKind(kind) ? 403 : 404).send({ error: isKind(kind) ? 'FORBIDDEN' : 'NOT_FOUND' })
    const cols = COLUMNS[kind as Kind]
    const csv = '﻿' + [cols.map((c) => c.headers[0]).join(','), cols.map((c) => csvField(c.example)).join(',')].join('\r\n') + '\r\n'
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${kind}-import-template.csv"`)
      .send(csv)
  })

  app.post('/imports/:kind/preview', signedIn, async (request, reply) => {
    const { kind } = request.params as { kind: string }
    if (!(await allowedKind(request, kind))) return reply.code(isKind(kind) ? 403 : 404).send({ error: isKind(kind) ? 'FORBIDDEN' : 'NOT_FOUND' })
    const parsed = body.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const allowed = await callerBranchIds(request)
    if (allowed !== null && !allowed.includes(parsed.data.branchId)) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const out = await prepare(request, kind as Kind, parsed.data.csv, parsed.data.branchId)
    if ('error' in out) return reply.code(400).send(out)
    return reply.send({
      columns: out.columns,
      unknownColumns: out.unknown,
      total: out.rows.length,
      valid: out.rows.filter((r) => r.errors.length === 0).length,
      rows: out.rows.map((r) => ({ line: r.line, values: r.values, errors: r.errors })),
    })
  })

  app.post('/imports/:kind/commit', signedIn, async (request, reply) => {
    const { kind } = request.params as { kind: string }
    if (!(await allowedKind(request, kind))) return reply.code(isKind(kind) ? 403 : 404).send({ error: isKind(kind) ? 'FORBIDDEN' : 'NOT_FOUND' })
    const parsed = body.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const allowed = await callerBranchIds(request)
    if (allowed !== null && !allowed.includes(parsed.data.branchId)) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const out = await prepare(request, kind as Kind, parsed.data.csv, parsed.data.branchId)
    if ('error' in out) return reply.code(400).send(out)
    const tenantId = request.auth!.tenantId!
    const canParents = await callerHasPermission(request, 'parents.write')

    // Parents already on file, by phone or email, so a sibling's family is
    // linked rather than created twice.
    const parents =
      kind === 'students' ? await withTenant(tenantId, (ctx) => ctx.parents.find({ status: { $ne: 'archived' } }).toArray()) : []
    const byPhone = new Map(parents.filter((p) => digits(p.primaryPhone)).map((p) => [digits(p.primaryPhone), p._id]))
    const byEmail = new Map(parents.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p._id]))

    const created: { line: number; id: string; number: string | null }[] = []
    const failed: { line: number; errors: string[] }[] = out.rows.filter((r) => r.errors.length).map((r) => ({ line: r.line, errors: r.errors }))
    const warnings: { line: number; warning: string }[] = []
    let parentsCreated = 0
    let parentsLinked = 0
    const mayCharge = await callerHasPermission(request, 'parents.manage')
    for (const r of out.rows) {
      if (r.errors.length || !r.payload) continue
      const url = kind === 'students' ? '/students' : '/hr/employees'
      const res = await internal(app, request, 'POST', url, r.payload)
      if (res.status !== 201) {
        failed.push({ line: r.line, errors: [String(res.body.error ?? `HTTP_${res.status}`)] })
        continue
      }
      const id = String((res.body as { id?: string; employee?: { id: string } }).id ?? (res.body as { employee?: { id: string } }).employee?.id ?? '')
      const number = String(res.body.studentNumber ?? res.body.employeeNumber ?? '') || null
      created.push({ line: r.line, id, number })
      if (kind !== 'students' || !r.parent) continue
      if (!canParents) {
        warnings.push({ line: r.line, warning: 'PARENT_NOT_ALLOWED' })
        continue
      }
      let parentId = byPhone.get(digits(r.parent.primaryPhone)) ?? (r.parent.email ? byEmail.get(r.parent.email.toLowerCase()) : undefined)
      if (!parentId) {
        const p = await internal(app, request, 'POST', '/parents', {
          fullName: r.parent.fullName,
          primaryPhone: r.parent.primaryPhone,
          email: r.parent.email,
        })
        if (p.status !== 201) {
          warnings.push({ line: r.line, warning: `PARENT_${String(p.body.error ?? p.status)}` })
          continue
        }
        parentId = String((p.body as { parent: { id: string } }).parent.id)
        byPhone.set(digits(r.parent.primaryPhone), parentId)
        if (r.parent.email) byEmail.set(r.parent.email.toLowerCase(), parentId)
        parentsCreated++
      } else parentsLinked++
      const link = await internal(app, request, 'POST', `/parents/${parentId}/links`, {
        studentId: id,
        relationshipType: r.parent.relationshipType,
        primaryContact: true,
        // The one guardian a row names is the family's contact for fees too:
        // without it nobody sees or pays the bills in the portal (pilot).
        // Only when the importer may set that flag; otherwise it stays off.
        financialResponsibility: mayCharge,
        communicationPermissions: { email: !!r.parent.email, sms: true },
      })
      if (link.status !== 201) warnings.push({ line: r.line, warning: `LINK_${String(link.body.error ?? link.status)}` })
    }

    // The student create reply carries only the id: read the numbers given.
    if (kind === 'students' && created.length) {
      const numbers = new Map(
        (await withTenant(tenantId, (ctx) => ctx.students.find({ _id: { $in: created.map((c) => c.id) } }).toArray())).map((s) => [
          s._id,
          s.studentNumber,
        ]),
      )
      for (const c of created) c.number = numbers.get(c.id) ?? null
    }

    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'import.commit',
        entity: 'import',
        entityId: kind,
        branchId: parsed.data.branchId,
        meta: { rows: out.rows.length, created: created.length, failed: failed.length, parentsCreated, parentsLinked },
      }),
    )
    return reply.send({ created, failed: failed.sort((a, b) => a.line - b.line), warnings, parentsCreated, parentsLinked })
  })
}
