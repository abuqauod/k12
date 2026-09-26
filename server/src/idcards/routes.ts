import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { withoutTenant, withTenant } from '../db.js'
import type { DocumentOwnerType, TenantContext } from '../db.js'
import { callerBranchIds } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { scoped } from '../records.js'
import { gridFsStore } from '../documents/store.js'
import { code128Svg } from './code128.js'

/**
 * Backlog: printable ID cards for students and staff — the school, the
 * photo on file, the name in English and Arabic, the number (also as a
 * Code 128 barcode the library desk can scan), class or position, and how
 * long it is valid. A print page like the report exports: ten cards to an
 * A4 sheet, or one card per page for a card printer (CR80, 85.6 × 54 mm).
 */

const MAX_CARDS = 400
/** Photos larger than this are left out rather than bloating the page. */
const MAX_PHOTO = 1_500_000

const query = z.object({
  branchId: z.string().optional(),
  classId: z.string().optional(),
  ids: z.string().max(20_000).optional(),
  layout: z.enum(['sheet', 'card']).default('sheet'),
  lang: z.enum(['en', 'ar']).default('en'),
  autoprint: z.enum(['0', '1']).optional(),
})

interface Card {
  id: string
  name: string
  nameAr: string | null
  number: string
  line1: string
  line2: string
  validUntil: string | null
  photo: string | null
  initials: string
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The current photo document of each owner, as data URIs. */
async function photos(ctx: TenantContext, tenantId: string, ownerType: DocumentOwnerType, ids: string[]) {
  const docs = await ctx.documents
    .find({ ownerType, ownerId: { $in: ids }, categoryCode: 'photo', isCurrent: true, archivedAt: null })
    .toArray()
  const out = new Map<string, string>()
  for (const d of docs) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(d.mime) || d.size > MAX_PHOTO || out.has(d.ownerId)) continue
    const file = await gridFsStore.open(tenantId, d.fileId)
    if (!file) continue
    const chunks: Buffer[] = []
    for await (const c of file.stream) chunks.push(c as Buffer)
    out.set(d.ownerId, `data:${d.mime};base64,${Buffer.concat(chunks).toString('base64')}`)
  }
  return out
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')

const TEXT = {
  student: { en: 'Student', ar: 'طالب' },
  staff: { en: 'Staff', ar: 'موظف' },
  valid: { en: 'Valid until', ar: 'صالحة حتى' },
  none: { en: 'No one to print.', ar: 'لا يوجد من يُطبع له.' },
}

function page(
  cards: Card[],
  o: { school: string; schoolAr: string | null; phone: string | null; kind: 'student' | 'staff'; layout: 'sheet' | 'card'; lang: 'en' | 'ar'; autoPrint: boolean },
) {
  const L = (k: keyof typeof TEXT) => TEXT[k][o.lang]
  const card = (c: Card) => `<article class="card">
  <header><b>${html(o.school)}</b>${o.schoolAr ? `<b dir="rtl">${html(o.schoolAr)}</b>` : ''}</header>
  <div class="body">
    <div class="photo">${c.photo ? `<img src="${c.photo}" alt="">` : `<span>${html(c.initials)}</span>`}</div>
    <div class="info">
      <div class="kind">${L(o.kind)}</div>
      <div class="name">${html(c.name)}</div>
      ${c.nameAr ? `<div class="name" dir="rtl">${html(c.nameAr)}</div>` : ''}
      <div class="line">${html(c.line1)}</div>
      <div class="line">${html(c.line2)}</div>
      ${c.validUntil ? `<div class="line small">${L('valid')} ${html(c.validUntil)}</div>` : ''}
    </div>
  </div>
  <footer><div class="barcode">${code128Svg(c.number, 30)}</div><div class="number">${html(c.number)}${o.phone ? ` · ${html(o.phone)}` : ''}</div></footer>
</article>`
  const sheet = o.layout === 'sheet'
  return `<!doctype html>
<html lang="${o.lang}" dir="${o.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(o.school)} — ID</title>
<style>
  @page { size: ${sheet ? 'A4 portrait' : '85.6mm 54mm'}; margin: ${sheet ? '10mm' : '0'}; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 8pt/1.25 "Segoe UI", "Noto Sans", "Noto Naskh Arabic", Tahoma, Arial, sans-serif; color: #111; background: #fff; }
  .sheet { display: grid; grid-template-columns: repeat(2, 85.6mm); grid-auto-rows: 54mm; gap: 4mm 6mm; justify-content: center; }
  .card { width: 85.6mm; height: 54mm; border: 0.3mm solid #999; border-radius: 3mm; overflow: hidden; display: flex; flex-direction: column; break-inside: avoid; background: #fff; }
  .single .card { border: none; border-radius: 0; break-after: page; }
  header { background: #1f2a44; color: #fff; padding: 1.4mm 3mm; display: flex; justify-content: space-between; gap: 2mm; font-size: 7.5pt; }
  header b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .body { flex: 1; display: flex; gap: 3mm; padding: 2mm 3mm 0; min-height: 0; }
  .photo { width: 20mm; height: 25mm; flex: none; border-radius: 1.5mm; background: #e9edf5; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .photo img { width: 100%; height: 100%; object-fit: cover; }
  .photo span { font-size: 14pt; font-weight: 700; color: #1f2a44; }
  .info { min-width: 0; display: flex; flex-direction: column; gap: 0.6mm; }
  .kind { text-transform: uppercase; letter-spacing: 0.3mm; font-size: 6.5pt; color: #666; }
  .name { font-size: 10pt; font-weight: 700; line-height: 1.15; }
  .line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .small { font-size: 6.5pt; color: #555; }
  footer { padding: 0 3mm 1.5mm; text-align: center; }
  .barcode svg { width: 100%; height: 8mm; display: block; }
  .number { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 7pt; direction: ltr; }
  .empty { padding: 20mm; color: #666; }
  @media screen { body { background: #eef1f6; padding: 16px; } .sheet, .single { max-width: 190mm; margin: 0 auto; } .single .card { margin: 0 auto 6mm; border: 0.3mm solid #999; border-radius: 3mm; } }
</style>
</head>
<body>
${cards.length === 0 ? `<p class="empty">${L('none')}</p>` : `<main class="${sheet ? 'sheet' : 'single'}">${cards.map(card).join('\n')}</main>`}
${o.autoPrint ? '<script>window.addEventListener("load", function () { setTimeout(function () { window.print() }, 200) })</script>' : ''}
</body>
</html>`
}

async function schoolInfo(tenantId: string) {
  const t = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  return { school: t?.name ?? '', schoolAr: t?.profile?.nameAr ?? null, phone: t?.profile?.phone ?? null }
}

/** The branches to print for, or a refusal. */
async function branchesFor(request: FastifyRequest, branchId?: string) {
  const allowed = await callerBranchIds(request)
  if (branchId && allowed !== null && !allowed.includes(branchId)) return false
  return branchId ? [branchId] : allowed
}

export function registerIdCardRoutes(app: FastifyInstance): void {
  app.get('/id-cards/students', scoped('students.read'), async (request, reply) => {
    const q = query.safeParse(request.query)
    if (!q.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branchIds = await branchesFor(request, q.data.branchId)
    if (branchIds === false) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const ids = q.data.ids?.split(',').filter(Boolean)
    const tenantId = request.auth!.tenantId!
    const cards = await withTenant(tenantId, async (ctx) => {
      const students = await ctx.students
        .find({
          status: 'enrolled',
          ...(branchIds ? { branchId: { $in: branchIds } } : {}),
          ...(q.data.classId ? { classId: q.data.classId } : {}),
          ...(ids ? { _id: { $in: ids } } : {}),
        })
        .sort({ studentGroup: 1, familyName: 1, givenName: 1 })
        .limit(MAX_CARDS)
        .toArray()
      const [pics, branches, years] = await Promise.all([
        photos(ctx, tenantId, 'student', students.map((s) => s._id)),
        ctx.branches.find({}).toArray(),
        ctx.academicYears.find({}).toArray(),
      ])
      const branch = new Map(branches.map((b) => [b._id, b.name]))
      const year = new Map(years.map((y) => [y._id, y]))
      return students.map((s): Card => {
        const name = `${s.givenName} ${s.familyName}`.trim()
        const ar = `${s.givenNameAr ?? ''} ${s.familyNameAr ?? ''}`.trim()
        const y = year.get(s.academicYearId)
        return {
          id: s._id,
          name,
          nameAr: ar || null,
          number: s.studentNumber,
          line1: s.studentGroup,
          line2: [branch.get(s.branchId), y?.name].filter(Boolean).join(' · '),
          validUntil: y?.endDate ?? null,
          photo: pics.get(s._id) ?? null,
          initials: initials(name),
        }
      })
    })
    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'idcards.print',
        entity: 'student',
        entityId: ids?.length === 1 ? ids[0]! : 'batch',
        branchId: branchIds?.length === 1 ? branchIds[0] : null,
        meta: { cards: cards.length, layout: q.data.layout },
      }),
    )
    const info = await schoolInfo(tenantId)
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'private, no-store')
      .send(page(cards, { ...info, kind: 'student', layout: q.data.layout, lang: q.data.lang, autoPrint: q.data.autoprint === '1' }))
  })

  app.get('/id-cards/employees', scoped('hr.read'), async (request, reply) => {
    const q = query.safeParse(request.query)
    if (!q.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branchIds = await branchesFor(request, q.data.branchId)
    if (branchIds === false) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const ids = q.data.ids?.split(',').filter(Boolean)
    const tenantId = request.auth!.tenantId!
    const lang = q.data.lang
    const cards = await withTenant(tenantId, async (ctx) => {
      const employees = await ctx.employees
        .find({ status: 'active', ...(branchIds ? { branchId: { $in: branchIds } } : {}), ...(ids ? { _id: { $in: ids } } : {}) })
        .sort({ familyName: 1, givenName: 1 })
        .limit(MAX_CARDS)
        .toArray()
      const [pics, branches, lookups] = await Promise.all([
        photos(ctx, tenantId, 'employee', employees.map((e) => e._id)),
        ctx.branches.find({}).toArray(),
        ctx.lookups.find({ kind: { $in: ['department', 'position'] } }).toArray(),
      ])
      const branch = new Map(branches.map((b) => [b._id, b.name]))
      const label = (kind: string, code: string | null) => {
        const l = lookups.find((x) => x.kind === kind && x.code === code)
        return l ? (lang === 'ar' && l.labelAr) || l.label : (code ?? '')
      }
      return employees.map((e): Card => {
        const name = `${e.givenName} ${e.familyName}`.trim()
        return {
          id: e._id,
          name,
          nameAr: e.fullNameAr,
          number: e.employeeNumber,
          line1: [label('position', e.positionCode), label('department', e.departmentCode)].filter(Boolean).join(' · '),
          line2: branch.get(e.branchId) ?? '',
          validUntil: null,
          photo: pics.get(e._id) ?? null,
          initials: initials(name),
        }
      })
    })
    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'idcards.print',
        entity: 'employee',
        entityId: ids?.length === 1 ? ids[0]! : 'batch',
        branchId: branchIds?.length === 1 ? branchIds[0] : null,
        meta: { cards: cards.length, layout: q.data.layout },
      }),
    )
    const info = await schoolInfo(tenantId)
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'private, no-store')
      .send(page(cards, { ...info, kind: 'staff', layout: q.data.layout, lang, autoPrint: q.data.autoprint === '1' }))
  })
}
