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
  // Backlog: behaviour incidents — what happened, and what the school did.
  // SAMS 11.2: subjects a grade is assessed in.
  subject: {
    defaults: [
      { code: 'arabic', label: 'Arabic', labelAr: 'اللغة العربية' },
      { code: 'english', label: 'English', labelAr: 'اللغة الإنجليزية' },
      { code: 'math', label: 'Mathematics', labelAr: 'الرياضيات' },
      { code: 'science', label: 'Science', labelAr: 'العلوم' },
      { code: 'islamic', label: 'Islamic Education', labelAr: 'التربية الإسلامية' },
      { code: 'social', label: 'Social Studies', labelAr: 'الدراسات الاجتماعية' },
      { code: 'computer', label: 'Computer Science', labelAr: 'الحاسوب' },
      { code: 'art', label: 'Art', labelAr: 'التربية الفنية' },
      { code: 'pe', label: 'Physical Education', labelAr: 'التربية الرياضية' },
    ],
  },
  incidentType: {
    defaults: [
      { code: 'disruption', label: 'Classroom disruption', labelAr: 'إخلال بالنظام الصفي' },
      { code: 'bullying', label: 'Bullying', labelAr: 'تنمّر' },
      { code: 'fighting', label: 'Fighting', labelAr: 'شجار' },
      { code: 'disrespect', label: 'Disrespect', labelAr: 'عدم احترام' },
      { code: 'lateness', label: 'Repeated lateness', labelAr: 'تأخر متكرر' },
      { code: 'damage', label: 'Damage to property', labelAr: 'إتلاف ممتلكات' },
      { code: 'cheating', label: 'Cheating', labelAr: 'غش' },
      { code: 'uniform', label: 'Uniform', labelAr: 'الزي المدرسي' },
      { code: 'device', label: 'Phone or device misuse', labelAr: 'سوء استخدام الهاتف أو الأجهزة' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  disciplineAction: {
    defaults: [
      { code: 'verbal_warning', label: 'Verbal warning', labelAr: 'تنبيه شفهي' },
      { code: 'written_warning', label: 'Written warning', labelAr: 'إنذار كتابي' },
      { code: 'parent_meeting', label: 'Parent meeting', labelAr: 'اجتماع مع ولي الأمر' },
      { code: 'detention', label: 'Detention', labelAr: 'احتجاز بعد الدوام' },
      { code: 'counselling', label: 'Referred to counsellor', labelAr: 'إحالة إلى المرشد' },
      { code: 'suspension', label: 'Suspension', labelAr: 'فصل مؤقت' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  paymentMethod: {
    defaults: [
      { code: 'cash', label: 'Cash', labelAr: 'نقدًا' },
      { code: 'bank_transfer', label: 'Bank transfer', labelAr: 'تحويل بنكي' },
      { code: 'card', label: 'Card', labelAr: 'بطاقة' },
      { code: 'cheque', label: 'Cheque', labelAr: 'شيك' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
      // SAMS 11.1: paid by the family through the school's card gateway.
      { code: 'online', label: 'Online (card)', labelAr: 'دفع إلكتروني (بطاقة)' },
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
  withdrawalReason: {
    defaults: [
      { code: 'relocation', label: 'Moved away', labelAr: 'انتقال السكن' },
      { code: 'other_school', label: 'Moved to another school', labelAr: 'الانتقال إلى مدرسة أخرى' },
      { code: 'financial', label: 'Financial', labelAr: 'أسباب مالية' },
      { code: 'academic', label: 'Academic', labelAr: 'أسباب أكاديمية' },
      { code: 'health', label: 'Health', labelAr: 'أسباب صحية' },
      { code: 'family', label: 'Family circumstances', labelAr: 'ظروف عائلية' },
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
      // Scholarship evidence, vendor invoices (SAMS 3.2, 3.5).
      { code: 'financial', label: 'Financial document', labelAr: 'مستند مالي' },
      // Staff files (SAMS 4.3).
      { code: 'contract', label: 'Signed contract', labelAr: 'عقد موقّع' },
      { code: 'certificate', label: 'Qualification / certificate', labelAr: 'مؤهل / شهادة' },
      { code: 'license', label: 'Licence / permit', labelAr: 'رخصة / تصريح' },
      // Vehicles and assets (SAMS 5.1, 5.4).
      { code: 'registration', label: 'Vehicle registration', labelAr: 'رخصة المركبة' },
      { code: 'insurance', label: 'Insurance', labelAr: 'تأمين' },
      { code: 'warranty', label: 'Warranty / invoice', labelAr: 'كفالة / فاتورة شراء' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  // SAMS Phase 4.
  department: {
    defaults: [
      { code: 'administration', label: 'Administration', labelAr: 'الإدارة' },
      { code: 'teaching', label: 'Teaching', labelAr: 'الهيئة التدريسية' },
      { code: 'finance', label: 'Finance', labelAr: 'المالية' },
      { code: 'operations', label: 'Operations', labelAr: 'العمليات' },
      { code: 'transport', label: 'Transport', labelAr: 'النقل' },
    ],
  },
  position: {
    defaults: [
      { code: 'principal', label: 'Principal', labelAr: 'مدير المدرسة' },
      { code: 'teacher', label: 'Teacher', labelAr: 'معلم' },
      { code: 'accountant', label: 'Accountant', labelAr: 'محاسب' },
      { code: 'registrar', label: 'Registrar', labelAr: 'مسجل' },
      { code: 'driver', label: 'Driver', labelAr: 'سائق' },
      { code: 'custodian', label: 'Custodian', labelAr: 'عامل خدمات' },
    ],
  },
  contractType: {
    defaults: [
      { code: 'permanent', label: 'Permanent', labelAr: 'دائم' },
      { code: 'fixed_term', label: 'Fixed term', labelAr: 'محدد المدة' },
      { code: 'part_time', label: 'Part time', labelAr: 'دوام جزئي' },
      { code: 'probation', label: 'Probation', labelAr: 'فترة تجربة' },
    ],
  },
  // SAMS Phase 5.
  assetCategory: {
    defaults: [
      { code: 'it', label: 'IT equipment', labelAr: 'أجهزة تقنية' },
      { code: 'furniture', label: 'Furniture', labelAr: 'أثاث' },
      { code: 'lab', label: 'Lab equipment', labelAr: 'معدات مختبر' },
      { code: 'sports', label: 'Sports equipment', labelAr: 'معدات رياضية' },
      { code: 'vehicle', label: 'Vehicle', labelAr: 'مركبة' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  inventoryCategory: {
    defaults: [
      { code: 'stationery', label: 'Stationery', labelAr: 'قرطاسية' },
      { code: 'cleaning', label: 'Cleaning supplies', labelAr: 'مواد تنظيف' },
      { code: 'uniforms', label: 'Uniforms', labelAr: 'زي مدرسي' },
      { code: 'books', label: 'Textbooks', labelAr: 'كتب مدرسية' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  roomType: {
    defaults: [
      { code: 'classroom', label: 'Classroom', labelAr: 'صف دراسي' },
      { code: 'lab', label: 'Laboratory', labelAr: 'مختبر' },
      { code: 'office', label: 'Office', labelAr: 'مكتب' },
      { code: 'library', label: 'Library', labelAr: 'مكتبة' },
      { code: 'hall', label: 'Hall', labelAr: 'قاعة' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  bookCategory: {
    defaults: [
      { code: 'fiction', label: 'Fiction', labelAr: 'قصص وروايات' },
      { code: 'nonfiction', label: 'Non-fiction', labelAr: 'كتب معرفية' },
      { code: 'reference', label: 'Reference', labelAr: 'مراجع' },
      { code: 'arabic', label: 'Arabic literature', labelAr: 'أدب عربي' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  eventType: {
    defaults: [
      { code: 'trip', label: 'Field trip', labelAr: 'رحلة مدرسية' },
      { code: 'sports', label: 'Sports', labelAr: 'نشاط رياضي' },
      { code: 'club', label: 'Club / activity', labelAr: 'نادٍ / نشاط' },
      { code: 'ceremony', label: 'Ceremony', labelAr: 'حفل' },
      { code: 'other', label: 'Other', labelAr: 'أخرى' },
    ],
  },
  expenseCategory: {
    defaults: [
      { code: 'utilities', label: 'Utilities', labelAr: 'خدمات (كهرباء وماء)' },
      { code: 'maintenance', label: 'Maintenance', labelAr: 'صيانة' },
      { code: 'supplies', label: 'Supplies', labelAr: 'لوازم' },
      { code: 'transport', label: 'Transport', labelAr: 'نقل' },
      { code: 'rent', label: 'Rent', labelAr: 'إيجار' },
      { code: 'services', label: 'Services', labelAr: 'خدمات خارجية' },
      { code: 'events', label: 'Events and activities', labelAr: 'فعاليات وأنشطة' },
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
      // Every built-in present, not just as many rows: a school that added
      // its own entries still gets a built-in added later (SAMS 11.1 online).
      const codes = defaults.map((d) => d.code)
      if ((await ctx.lookups.countDocuments({ kind, code: { $in: codes } })) >= codes.length) return
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
