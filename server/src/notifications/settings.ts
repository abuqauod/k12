import type { NotificationSettingsDoc, NotifyChannel } from '../db.js'

/**
 * A branch with no settings row yet behaves as if it had these — notably
 * `absenceNotifyEnabled: false`, so nothing is sent until someone turns it
 * on. The templates use `{studentName} {date} {schoolName} {branchName}`.
 */
export const DEFAULT_NOTIFICATION_SETTINGS = {
  absenceNotifyEnabled: false,
  cutoffTime: '10:00',
  channels: ['email'] as NotifyChannel[],
  notifyOnUnmarked: true,
  // Sunday–Thursday: the working week where this is deployed.
  schoolDays: [0, 1, 2, 3, 4],
  emailSubject: 'Absence today — {studentName}',
  emailBody:
    'Dear parent/guardian,\n\n' +
    'Our records show that {studentName} was not present at {schoolName} ({branchName}) today, {date}, and we have not been told the reason.\n\n' +
    'If this absence is expected, please reply to let us know. If you believe {studentName} should be at school, please contact the office as soon as possible.\n\n' +
    'Thank you,\n{schoolName}',
  smsBody:
    '{schoolName}: {studentName} was marked absent today ({date}). Please contact the school if this is unexpected.',
} as const

export type EffectiveSettings = Omit<
  NotificationSettingsDoc,
  '_id' | 'tenantId' | 'branchId' | 'lastSweptDate' | 'updatedAt'
>

export function effectiveSettings(doc: NotificationSettingsDoc | null): EffectiveSettings {
  return {
    absenceNotifyEnabled: doc?.absenceNotifyEnabled ?? DEFAULT_NOTIFICATION_SETTINGS.absenceNotifyEnabled,
    cutoffTime: doc?.cutoffTime ?? DEFAULT_NOTIFICATION_SETTINGS.cutoffTime,
    channels: doc?.channels ?? [...DEFAULT_NOTIFICATION_SETTINGS.channels],
    notifyOnUnmarked: doc?.notifyOnUnmarked ?? DEFAULT_NOTIFICATION_SETTINGS.notifyOnUnmarked,
    schoolDays: doc?.schoolDays ?? [...DEFAULT_NOTIFICATION_SETTINGS.schoolDays],
    emailSubject: doc?.emailSubject ?? DEFAULT_NOTIFICATION_SETTINGS.emailSubject,
    emailBody: doc?.emailBody ?? DEFAULT_NOTIFICATION_SETTINGS.emailBody,
    smsBody: doc?.smsBody ?? DEFAULT_NOTIFICATION_SETTINGS.smsBody,
  }
}

export function renderTemplate(
  template: string,
  tokens: { studentName: string; date: string; schoolName: string; branchName: string },
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in tokens ? tokens[name as keyof typeof tokens] : match,
  )
}
