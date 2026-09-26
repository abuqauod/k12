import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { MongoServerError } from 'mongodb'
import { z } from 'zod'
import { config } from '../config.js'
import { withTenant, withoutTenant } from '../db.js'
import type { DocumentDoc, DocumentOwnerType, TenantContext } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  callerHasPermission,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { parentHiddenFromBranches } from '../parents/service.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { gridFsStore, sniffMime, type DocumentStore } from './store.js'
import { signFileLink, verifyFileLink } from './fileTokens.js'

/**
 * Documents (SAMS 2.1): files attached to a student, a parent, an
 * application (2.5), a scholarship or an expense (3.2, 3.5).
 *
 * Access follows the owner. Seeing an owner's documents needs the owner's
 * own read scope (`students.read` / `parents.read`) and its branch, checked
 * against the live record every time. Changing them needs a documents
 * scope on top: `documents.upload`, `documents.verify`, or
 * `documents.delete` (archive). Files are never served from a guessable
 * URL: `POST /documents/:id/link` checks access and returns a signed link
 * that expires in minutes (./fileTokens.ts).
 *
 * Uploads are the raw file bytes (`Content-Type: application/octet-stream`),
 * with the name and other details in the query string. That keeps the
 * server free of a multipart parser, and the upload limit applies to these
 * routes only.
 */

const store: DocumentStore = gridFsStore

const OWNER_READ_SCOPE: Record<DocumentOwnerType, PermissionScope> = {
  student: 'students.read',
  parent: 'parents.read',
  // SAMS 2.5: an applicant's documents; moved to the student on conversion.
  application: 'admissions.read',
  // SAMS 3.2 / 3.5: scholarship evidence, vendor invoices.
  scholarship: 'finance.read',
  expense: 'finance.read',
  // SAMS 4.3: staff files are personal data — HR only.
  employee: 'hr.read',
  // SAMS 5.1 / 5.4: asset papers, vehicle and driver documents.
  asset: 'ops.read',
  bus: 'transport.read',
  driver: 'transport.read',
}

/** Who may add files to an owner besides `documents.upload` holders: the
 * staff who raise that kind of record collect its papers. */
const OWNER_UPLOAD_SCOPE: Partial<Record<DocumentOwnerType, PermissionScope>> = {
  application: 'admissions.manage',
  scholarship: 'finance.scholarship.request',
  expense: 'finance.expense.create',
  employee: 'hr.employee.update',
  asset: 'ops.assets.manage',
  bus: 'transport.manage',
  driver: 'transport.manage',
}

/** Owners that are a single branch-scoped record. */
async function recordBranch(ctx: TenantContext, ownerType: DocumentOwnerType, ownerId: string) {
  const find = { _id: ownerId }
  const load: Record<Exclude<DocumentOwnerType, 'parent'>, () => Promise<{ branchId: string } | null>> = {
    student: () => ctx.students.findOne(find),
    application: () => ctx.applications.findOne(find),
    scholarship: () => ctx.scholarships.findOne(find),
    expense: () => ctx.expenses.findOne(find),
    employee: () => ctx.employees.findOne(find),
    asset: () => ctx.assets.findOne(find),
    bus: () => ctx.buses.findOne(find),
    driver: () => ctx.drivers.findOne(find),
  }
  if (ownerType === 'parent') return null
  const doc = await load[ownerType]()
  return doc ? { branchId: doc.branchId } : null
}

const ownerQuery = z.object({
  ownerType: z.enum(['student', 'parent', 'application', 'scholarship', 'expense', 'employee', 'asset', 'bus', 'driver']),
  ownerId: z.string().min(1).max(64),
})

const listQuery = ownerQuery.extend({
  includeArchived: z.enum(['0', '1']).optional(),
})

const uploadQuery = ownerQuery.extend({
  category: z.string().min(1).max(64),
  fileName: z.string().min(1).max(255),
  expiresAt: z.string().date().optional(),
})

const versionQuery = z.object({
  fileName: z.string().min(1).max(255),
  expiresAt: z.string().date().optional(),
})

const verifyBody = z.object({
  status: z.enum(['verified', 'rejected', 'unverified']),
  note: z.string().trim().max(500).optional(),
})

const linkBody = z
  .object({ download: z.boolean().default(false) })
  .default({})

/** Keeps the last path segment, drops control characters, caps the length. */
function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200)
  return cleaned || 'document'
}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000

const today = () => new Date().toISOString().slice(0, 10)

type Access = { ok: true; branchId: string | null } | { ok: false; status: number; error: string }

/**
 * May the caller see this owner's documents? Checks the owner's read scope
 * and branch. Parents have no branch of their own; they follow their
 * children's branches (SAMS 1.9).
 */
async function ownerAccess(
  request: FastifyRequest,
  tenantId: string,
  ownerType: DocumentOwnerType,
  ownerId: string,
): Promise<Access> {
  if (!(await callerHasPermission(request, OWNER_READ_SCOPE[ownerType]))) {
    return { ok: false, status: 403, error: 'FORBIDDEN' }
  }
  if (ownerType !== 'parent') {
    const owner = await withTenant(tenantId, (ctx) => recordBranch(ctx, ownerType, ownerId))
    if (!owner) return { ok: false, status: 404, error: 'OWNER_NOT_FOUND' }
    if (!(await callerCanUseBranch(request, owner.branchId))) {
      return { ok: false, status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return { ok: true, branchId: owner.branchId }
  }
  const allowed = await callerBranchIds(request)
  const found = await withTenant(tenantId, async (ctx) => {
    const parent = await ctx.parents.findOne({ _id: ownerId })
    if (!parent) return 'missing' as const
    if (allowed !== null && (await parentHiddenFromBranches(ctx, ownerId, allowed))) return 'hidden' as const
    return 'ok' as const
  })
  if (found === 'missing') return { ok: false, status: 404, error: 'OWNER_NOT_FOUND' }
  if (found === 'hidden') return { ok: false, status: 403, error: 'BRANCH_FORBIDDEN' }
  return { ok: true, branchId: null }
}

/** Passes with any one of the scopes; the handler narrows it further. */
function requireAnyPermission(scopes: PermissionScope[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    for (const scope of scopes) if (await callerHasPermission(request, scope)) return
    await reply.code(403).send({ error: 'FORBIDDEN', required: scopes[0] })
  }
}

/** Loads a document and checks the caller may see its owner. */
async function documentAccess(request: FastifyRequest, tenantId: string, id: string) {
  const doc = await withTenant(tenantId, (ctx) => ctx.documents.findOne({ _id: id }))
  if (!doc) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
  const access = await ownerAccess(request, tenantId, doc.ownerType, doc.ownerId)
  if (!access.ok) return access
  return { ok: true as const, doc }
}

/** Display names for the uploader / verifier ids on a page of documents. */
async function namesFor(docs: DocumentDoc[]): Promise<Map<string, string>> {
  const ids = [...new Set(docs.flatMap((d) => [d.uploadedBy, d.verification.by]).filter((v): v is string => !!v))]
  if (ids.length === 0) return new Map()
  const users = await withoutTenant((db) =>
    db.users.find({ _id: { $in: ids } }, { projection: { displayName: 1, email: 1 } }).toArray(),
  )
  return new Map(users.map((u) => [u._id, u.displayName || u.email]))
}

function toResponse(doc: DocumentDoc, names: Map<string, string>) {
  return {
    id: doc._id,
    ownerType: doc.ownerType,
    ownerId: doc.ownerId,
    branchId: doc.branchId,
    categoryCode: doc.categoryCode,
    seriesId: doc.seriesId,
    version: doc.version,
    isCurrent: doc.isCurrent,
    fileName: doc.fileName,
    mime: doc.mime,
    size: doc.size,
    expiresAt: doc.expiresAt,
    expired: doc.expiresAt !== null && doc.expiresAt < today(),
    verification: {
      status: doc.verification.status,
      by: doc.verification.by,
      byName: doc.verification.by ? (names.get(doc.verification.by) ?? null) : null,
      at: doc.verification.at?.toISOString() ?? null,
      note: doc.verification.note,
    },
    uploadedBy: doc.uploadedBy,
    uploadedByName: names.get(doc.uploadedBy) ?? null,
    createdAt: doc.createdAt.toISOString(),
    archivedAt: doc.archivedAt?.toISOString() ?? null,
  }
}

/** RFC 6266 header with an ASCII fallback for older clients. */
function contentDisposition(fileName: string, download: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export function registerDocumentRoutes(app: FastifyInstance): void {
  const signedIn = [authenticate, requireActiveSubscription]
  const scoped = (scope: PermissionScope) => ({ preHandler: [...signedIn, requirePermission(scope)] })

  app.get('/documents', { preHandler: signedIn }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { ownerType, ownerId, includeArchived } = parsed.data
    const tenantId = request.auth!.tenantId!
    const access = await ownerAccess(request, tenantId, ownerType, ownerId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const docs = await withTenant(tenantId, (ctx) =>
      ctx.documents
        .find({ ownerType, ownerId, isCurrent: true, ...(includeArchived === '1' ? {} : { archivedAt: null }) })
        .sort({ createdAt: -1 })
        .toArray(),
    )
    const names = await namesFor(docs)
    return reply.send({ documents: docs.map((d) => toResponse(d, names)) })
  })

  app.get('/documents/:id/versions', { preHandler: signedIn }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const access = await documentAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const docs = await withTenant(tenantId, (ctx) =>
      ctx.documents.find({ seriesId: access.doc.seriesId }).sort({ version: -1 }).toArray(),
    )
    const names = await namesFor(docs)
    return reply.send({ versions: docs.map((d) => toResponse(d, names)) })
  })

  // Uploads: raw bytes, parsed only inside this plugin so the rest of the
  // API keeps its JSON-only body handling and its smaller body limit.
  app.register(async (uploads) => {
    uploads.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: config.maxDocumentBytes },
      (_request, body, done) => done(null, body),
    )
    // The scope is checked per owner below: documents.upload in general, or
    // the owner kind's own scope (OWNER_UPLOAD_SCOPE — e.g. intake staff
    // collect an applicant's papers, SAMS 2.5).
    const uploadOptions = {
      preHandler: [
        ...signedIn,
        requireAnyPermission(['documents.upload', ...new Set(Object.values(OWNER_UPLOAD_SCOPE))]),
      ],
      bodyLimit: config.maxDocumentBytes,
    }
    const mayUpload = async (request: FastifyRequest, ownerType: DocumentOwnerType) => {
      if (await callerHasPermission(request, 'documents.upload')) return true
      const own = OWNER_UPLOAD_SCOPE[ownerType]
      return own !== undefined && (await callerHasPermission(request, own))
    }

    /** Checks the bytes; returns the detected type or an error reply body. */
    type FileCheck = { data: Buffer; mime: string } | { error: string; status: number }
    const readFile = (body: unknown): FileCheck => {
      if (!Buffer.isBuffer(body) || body.length === 0) return { error: 'EMPTY_FILE', status: 400 }
      const mime = sniffMime(body)
      if (!mime) return { error: 'UNSUPPORTED_FILE_TYPE', status: 415 }
      return { data: body, mime }
    }

    uploads.post('/documents', uploadOptions, async (request, reply) => {
      const parsed = uploadQuery.safeParse(request.query)
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
      const file = readFile(request.body)
      if ('error' in file) return reply.code(file.status).send({ error: file.error })
      const { ownerType, ownerId, category, expiresAt } = parsed.data
      if (!(await mayUpload(request, ownerType))) return reply.code(403).send({ error: 'FORBIDDEN' })
      const tenantId = request.auth!.tenantId!
      const access = await ownerAccess(request, tenantId, ownerType, ownerId)
      if (!access.ok) return reply.code(access.status).send({ error: access.error })

      await ensureDefaults(tenantId, 'documentCategory')
      const categoryOk = await withTenant(tenantId, async (ctx) =>
        (await activeCodes(ctx, 'documentCategory')).has(category),
      )
      if (!categoryOk) return reply.code(400).send({ error: 'INVALID_CATEGORY' })

      const fileName = cleanFileName(parsed.data.fileName)
      // GridFS writes can't join the transaction, so the bytes go first and
      // are removed again if the metadata insert fails.
      const stored = await store.put(tenantId, file.data, { fileName, mime: file.mime })
      try {
        const doc = await withTenant(tenantId, async (ctx) => {
          const now = new Date()
          const row: DocumentDoc = {
            _id: randomUUID(),
            tenantId,
            ownerType,
            ownerId,
            branchId: access.branchId,
            categoryCode: category,
            seriesId: randomUUID(),
            version: 1,
            isCurrent: true,
            fileId: stored.fileId,
            fileName,
            mime: file.mime,
            size: stored.size,
            sha256: stored.sha256,
            expiresAt: expiresAt ?? null,
            verification: { status: 'unverified', by: null, at: null, note: null },
            uploadedBy: request.auth!.sub,
            createdAt: now,
            archivedAt: null,
            archivedBy: null,
          }
          await ctx.documents.insertOne(row)
          await recordAudit(ctx.auditLog, {
            actorId: request.auth!.sub,
            action: 'document.upload',
            entity: ownerType,
            entityId: ownerId,
            branchId: access.branchId,
            before: null,
            after: { documentId: row._id, category, fileName, size: row.size, mime: row.mime },
          })
          return row
        })
        return reply.code(201).send(toResponse(doc, await namesFor([doc])))
      } catch (error) {
        await store.remove(tenantId, stored.fileId).catch(() => undefined)
        throw error
      }
    })

    /** A new version of an existing document. The old one stays in history. */
    uploads.post('/documents/:id/versions', uploadOptions, async (request, reply) => {
      const { id } = request.params as { id: string }
      const parsed = versionQuery.safeParse(request.query)
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
      const file = readFile(request.body)
      if ('error' in file) return reply.code(file.status).send({ error: file.error })
      const tenantId = request.auth!.tenantId!
      const access = await documentAccess(request, tenantId, id)
      if (!access.ok) return reply.code(access.status).send({ error: access.error })
      if (!(await mayUpload(request, access.doc.ownerType))) return reply.code(403).send({ error: 'FORBIDDEN' })
      if (access.doc.archivedAt) return reply.code(409).send({ error: 'ARCHIVED' })
      if (!access.doc.isCurrent) return reply.code(409).send({ error: 'NOT_CURRENT_VERSION' })

      const fileName = cleanFileName(parsed.data.fileName)
      const stored = await store.put(tenantId, file.data, { fileName, mime: file.mime })
      try {
        const doc = await withTenant(tenantId, async (ctx) => {
          // Compare-and-set: only the version that is still current may be
          // replaced, so two concurrent replacements can't both succeed.
          const previous = await ctx.documents.findOneAndUpdate(
            { _id: id, isCurrent: true, archivedAt: null },
            { $set: { isCurrent: false } },
            { returnDocument: 'before' },
          )
          if (!previous) return null
          const branch = await ownerBranch(ctx, previous)
          const row: DocumentDoc = {
            ...previous,
            _id: randomUUID(),
            branchId: branch,
            version: previous.version + 1,
            isCurrent: true,
            fileId: stored.fileId,
            fileName,
            mime: file.mime,
            size: stored.size,
            sha256: stored.sha256,
            // A new file means a new check: verification starts over.
            expiresAt: parsed.data.expiresAt ?? previous.expiresAt,
            verification: { status: 'unverified', by: null, at: null, note: null },
            uploadedBy: request.auth!.sub,
            createdAt: new Date(),
          }
          await ctx.documents.insertOne(row)
          await recordAudit(ctx.auditLog, {
            actorId: request.auth!.sub,
            action: 'document.newVersion',
            entity: previous.ownerType,
            entityId: previous.ownerId,
            branchId: branch,
            before: { documentId: previous._id, version: previous.version, fileName: previous.fileName },
            after: { documentId: row._id, version: row.version, fileName, size: row.size, mime: row.mime },
          })
          return row
        })
        if (!doc) {
          await store.remove(tenantId, stored.fileId).catch(() => undefined)
          return reply.code(409).send({ error: 'NOT_CURRENT_VERSION' })
        }
        return reply.code(201).send(toResponse(doc, await namesFor([doc])))
      } catch (error) {
        await store.remove(tenantId, stored.fileId).catch(() => undefined)
        if (isDuplicateKey(error)) return reply.code(409).send({ error: 'NOT_CURRENT_VERSION' })
        throw error
      }
    })
  })

  app.post('/documents/:id/verify', scoped('documents.verify'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = verifyBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const note = parsed.data.note || null
    if (parsed.data.status === 'rejected' && (!note || note.length < 3)) {
      return reply.code(400).send({ error: 'NOTE_REQUIRED' })
    }
    const tenantId = request.auth!.tenantId!
    const access = await documentAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (access.doc.archivedAt) return reply.code(409).send({ error: 'ARCHIVED' })
    if (!access.doc.isCurrent) return reply.code(409).send({ error: 'NOT_CURRENT_VERSION' })

    const updated = await withTenant(tenantId, async (ctx) => {
      const verification = {
        status: parsed.data.status,
        by: parsed.data.status === 'unverified' ? null : request.auth!.sub,
        at: parsed.data.status === 'unverified' ? null : new Date(),
        note,
      }
      const after = await ctx.documents.findOneAndUpdate(
        { _id: id, isCurrent: true, archivedAt: null },
        { $set: { verification } },
        { returnDocument: 'after' },
      )
      if (!after) return null
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'document.verify',
        entity: after.ownerType,
        entityId: after.ownerId,
        branchId: after.branchId,
        before: { documentId: id, status: access.doc.verification.status },
        after: { documentId: id, status: verification.status, note },
      })
      return after
    })
    if (!updated) return reply.code(409).send({ error: 'NOT_CURRENT_VERSION' })
    return reply.send(toResponse(updated, await namesFor([updated])))
  })

  /** Archives the whole document (every version). Nothing is deleted. */
  app.post('/documents/:id/archive', scoped('documents.delete'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
    const tenantId = request.auth!.tenantId!
    const access = await documentAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (access.doc.archivedAt) return reply.code(409).send({ error: 'ARCHIVED' })

    await withTenant(tenantId, async (ctx) => {
      const now = new Date()
      await ctx.documents.updateMany(
        { seriesId: access.doc.seriesId, archivedAt: null },
        { $set: { archivedAt: now, archivedBy: request.auth!.sub } },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'document.archive',
        entity: access.doc.ownerType,
        entityId: access.doc.ownerId,
        branchId: access.doc.branchId,
        before: { documentId: id, fileName: access.doc.fileName, category: access.doc.categoryCode },
        after: null,
      })
    })
    return reply.code(204).send()
  })

  /** A short-lived link to one version's file, for preview or download. */
  app.post('/documents/:id/link', { preHandler: signedIn }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = linkBody.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await documentAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    // Who opened which document is part of its history (medical records,
    // IDs), so each link is audited.
    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'document.open',
        entity: access.doc.ownerType,
        entityId: access.doc.ownerId,
        branchId: access.doc.branchId,
        meta: { documentId: id, version: access.doc.version, download: parsed.data.download },
      }),
    )
    const link = await signFileLink({
      tenantId,
      documentId: id,
      userId: request.auth!.sub,
      download: parsed.data.download,
    })
    return reply.send({ token: link.token, expiresAt: link.expiresAt.toISOString() })
  })

  /** The file itself. No session: the signed link is the credential. */
  // The token rides in the query string: Fastify caps path parameters at
  // 100 characters, shorter than a signed token.
  app.get('/documents/file', async (request, reply) => {
    const { token } = request.query as { token?: unknown }
    const claims = typeof token === 'string' ? await verifyFileLink(token) : null
    if (!claims) return reply.code(401).send({ error: 'INVALID_LINK' })
    const doc = await withTenant(claims.tenantId, (ctx) => ctx.documents.findOne({ _id: claims.documentId }))
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const file = await store.open(claims.tenantId, doc.fileId)
    if (!file) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply
      .header('Content-Type', doc.mime)
      .header('Content-Length', String(file.size))
      .header('Content-Disposition', contentDisposition(doc.fileName, claims.download))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300')
      .header('Referrer-Policy', 'no-referrer')
      .send(file.stream)
  })
}

/** The owner's current branch, for a new version's `branchId`. */
async function ownerBranch(ctx: TenantContext, doc: DocumentDoc): Promise<string | null> {
  if (doc.ownerType === 'parent') return null
  return (await recordBranch(ctx, doc.ownerType, doc.ownerId))?.branchId ?? doc.branchId
}
