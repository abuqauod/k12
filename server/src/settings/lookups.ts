import { randomUUID } from 'node:crypto'
import { MongoServerError } from 'mongodb'
import { withTenant } from '../db.js'
import type { TenantContext } from '../db.js'

/**
 * SAMS 1.11: the closed registry of settings lists. Each kind lives in the
 * shared `lookups` collection; a later phase adds a kind here (leave types,
 * expense categories, …) rather than a new settings model. Defaults are
 * seeded lazily per tenant the first time a kind is read, so existing
 * schools need no migration.
 */

interface Default {
  code: string
  label: string
  labelAr: string
}

export const LOOKUP_KINDS: Record<string, { defaults: Default[] }> = {
  paymentMethod: {
    defaults: [
      { code: 'cash', label: 'Cash', labelAr: 'نقدًا' },
      { code: 'bank_transfer', label: 'Bank transfer', labelAr: 'تحويل بنكي' },
      { code: 'card', label: 'Card', labelAr: 'بطاقة' },
      { code: 'cheque', label: 'Cheque', labelAr: 'شيك' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  admissionSource: {
    defaults: [
      { code: 'walk_in', label: 'Walk-in', labelAr: 'زيارة مباشرة' },
      { code: 'referral', label: 'Referral', labelAr: 'توصية' },
      { code: 'sibling', label: 'Sibling already enrolled', labelAr: 'أخ أو أخت مسجل' },
      { code: 'website', label: 'Website / social media', labelAr: 'الموقع / وسائل التواصل' },
      { code: 'transfer', label: 'Transfer from another school', labelAr: 'انتقال من مدرسة أخرى' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  documentCategory: {
    defaults: [
      { code: 'birth_certificate', label: 'Birth certificate', labelAr: 'شهادة الميلاد' },
      { code: 'id_copy', label: 'ID / passport copy', labelAr: 'صورة الهوية / جواز السفر' },
      { code: 'previous_report', label: 'Previous school report', labelAr: 'تقرير المدرسة السابقة' },
      { code: 'medical', label: 'Medical record', labelAr: 'سجل طبي' },
      { code: 'photo', label: 'Photo', labelAr: 'صورة شخصية' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
}

export const isLookupKind = (kind: string): boolean => Object.hasOwn(LOOKUP_KINDS, kind)

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000

/**
 * Inserts any missing default for `kind`. Idempotent (`$setOnInsert`), and
 * run in its own transaction so a concurrent first read that seeds the same
 * codes (unique index → E11000) is simply "already seeded".
 */
export async function ensureDefaults(tenantId: string, kind: string): Promise<void> {
  const defaults = LOOKUP_KINDS[kind]?.defaults ?? []
  try {
    await withTenant(tenantId, async (ctx) => {
      if ((await ctx.lookups.countDocuments({ kind })) >= defaults.length) return
      const now = new Date()
      for (const [order, d] of defaults.entries()) {
        await ctx.lookups.findOneAndUpdate(
          { kind, code: d.code },
          {
            $setOnInsert: {
              _id: randomUUID(),
              label: d.label,
              labelAr: d.labelAr,
              active: true,
              order,
              builtIn: true,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true },
        )
      }
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
  }
}

/** Codes currently offered for new records of `kind`. */
export async function activeCodes(ctx: TenantContext, kind: string): Promise<Set<string>> {
  const rows = await ctx.lookups.find({ kind, active: true }).toArray()
  return new Set(rows.map((r) => r.code))
}
