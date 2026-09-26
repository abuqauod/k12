import type { CommunicationSettingsDoc, TenantContext } from '../db.js'

/** A tenant with no row yet behaves as if it had these: nothing automatic
 * is sent until someone turns it on. */
export const DEFAULT_COMMUNICATION_SETTINGS = {
  feeReminders: { auto: false, daysBefore: 3, repeatDays: 7 },
  documentExpiry: { auto: false, daysBefore: 30 },
  portalDocumentCategories: ['birth_certificate', 'photo', 'previous_report'],
}

export type EffectiveCommunicationSettings = typeof DEFAULT_COMMUNICATION_SETTINGS & { lastRunDate: string | null }

export function effectiveCommunication(doc: CommunicationSettingsDoc | null): EffectiveCommunicationSettings {
  const d = DEFAULT_COMMUNICATION_SETTINGS
  return {
    feeReminders: { ...d.feeReminders, ...(doc?.feeReminders ?? {}) },
    documentExpiry: { ...d.documentExpiry, ...(doc?.documentExpiry ?? {}) },
    portalDocumentCategories: doc?.portalDocumentCategories ?? [...d.portalDocumentCategories],
    lastRunDate: doc?.lastRunDate ?? null,
  }
}

export async function loadCommunication(ctx: TenantContext, tenantId: string): Promise<EffectiveCommunicationSettings> {
  return effectiveCommunication(await ctx.communicationSettings.findOne({ _id: tenantId }))
}
