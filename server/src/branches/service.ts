import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import type { BranchDoc } from '../db.js'

/**
 * Branch *identity* — name, url-safe code, address/location, timezone,
 * active flag. Defining these is a vendor-provisioning concern, so the only
 * write surface is the platform console (`/admin/tenants/:id/branches`),
 * which calls straight into here with a tenant id from the URL. A tenant's
 * own users can read their branches (`GET /branches`) and run everything
 * *operational* about them — the school calendar, absence-notification
 * settings, staff assignment — but not create, rename, relocate or
 * deactivate one.
 */

export const BRANCH_CODE_RULE = /^[a-z0-9-]{2,32}$/

export interface BranchInput {
  name: string
  code: string
  address: string | null
  timezone: string
}

export function branchToResponse(doc: BranchDoc) {
  return {
    id: doc._id,
    name: doc.name,
    code: doc.code,
    address: doc.address,
    timezone: doc.timezone,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export async function listBranchesForTenant(tenantId: string): Promise<BranchDoc[]> {
  return withTenant(tenantId, (ctx) => ctx.branches.find().sort({ name: 1 }).toArray())
}

export type CreateBranchResult =
  | { ok: true; branch: BranchDoc }
  | { ok: false; error: 'BRANCH_CODE_TAKEN' }

export async function createBranchForTenant(
  tenantId: string,
  input: BranchInput,
): Promise<CreateBranchResult> {
  const now = new Date()
  return withTenant(tenantId, async (ctx) => {
    const clash = await ctx.branches.findOne({ code: input.code })
    if (clash) return { ok: false, error: 'BRANCH_CODE_TAKEN' }
    const branch: BranchDoc = {
      _id: randomUUID(),
      tenantId,
      name: input.name,
      code: input.code,
      address: input.address,
      timezone: input.timezone,
      active: true,
      createdAt: now,
      updatedAt: now,
    }
    await ctx.branches.insertOne(branch)
    // Seed a school calendar so the branch has a working week from day one;
    // the tenant edits it from Settings afterwards.
    await ctx.schoolCalendars.findOneAndUpdate(
      { _id: `${tenantId}:${branch._id}` },
      {
        $setOnInsert: {
          branchId: branch._id,
          workingDays: [0, 1, 2, 3, 4],
          holidays: [],
          updatedAt: now,
        },
      },
      { upsert: true },
    )
    return { ok: true, branch }
  })
}

export async function updateBranchForTenant(
  tenantId: string,
  branchId: string,
  patch: Partial<Omit<BranchInput, 'code'>> & { active?: boolean },
): Promise<BranchDoc | null> {
  return withTenant(tenantId, (ctx) =>
    ctx.branches.findOneAndUpdate(
      { _id: branchId },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: 'after' },
    ),
  )
}
