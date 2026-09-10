import type { GuardianLanguage, NotificationSettingsDoc, NotifyChannel } from '../db.js'

/**
 * A branch with no settings row yet behaves as if it had these — notably
 * `absenceNotifyEnabled: false`, so nothing is sent until someone turns it
 * on. Templates use `{studentName} {date} {schoolName} {branchName}`; the
 * Arabic set is used for a guardian whose `preferredLanguage` is 'ar', and
 * falls back to the English text when left blank.
 */
export const DEFAULT_NOTIFICATION_SETTINGS = {
  absenceNotifyEnabled: false,
  cutoffTime: '10:00',
  channels: ['email'] as NotifyChannel[],
  notifyOnUnmarked: true,
  emailSubject: 'Absence today — {studentName}',
  emailBody:
    'Dear parent/guardian,\n\n' +
    'Our records show that {studentName} was not present at {schoolName} ({branchName}) today, {date}, and we have not been told the reason.\n\n' +
    'If this absence is expected, please reply to let us know. If you believe {studentName} should be at school, please contact the office as soon as possible.\n\n' +
    'Thank you,\n{schoolName}',
  smsBody:
    '{schoolName}: {studentName} was marked absent today ({date}). Please contact the school if this is unexpected.',
  emailSubjectAr: 'غياب اليوم — {studentName}',
  emailBodyAr:
    'عزيزي ولي الأمر،\n\n' +
    'تشير سجلاتنا إلى أن {studentName} لم يكن حاضرًا في {schoolName} ({branchName}) اليوم، {date}، ولم يتم إبلاغنا بالسبب.\n\n' +
    'إذا كان هذا الغياب متوقعًا، يُرجى الرد لإبلاغنا. وإذا كنت تعتقد أن {studentName} يجب أن يكون في المدرسة، يُرجى الاتصال بالإدارة في أقرب وقت.\n\n' +
    'شكرًا لكم،\n{schoolName}',
  smsBodyAr:
    '{schoolName}: تم تسجيل غياب {studentName} اليوم ({date}). يُرجى الاتصال بالمدرسة إذا كان ذلك غير متوقع.',
} as const

export interface EffectiveSettings {
  absenceNotifyEnabled: boolean
  cutoffTime: string
  channels: NotifyChannel[]
  notifyOnUnmarked: boolean
  emailSubject: string
  emailBody: string
  smsBody: string
  emailSubjectAr: string
  emailBodyAr: string
  smsBodyAr: string
}

export function effectiveSettings(doc: NotificationSettingsDoc | null): EffectiveSettings {
  const d = DEFAULT_NOTIFICATION_SETTINGS
  return {
    absenceNotifyEnabled: doc?.absenceNotifyEnabled ?? d.absenceNotifyEnabled,
    cutoffTime: doc?.cutoffTime ?? d.cutoffTime,
    channels: doc?.channels ?? [...d.channels],
    notifyOnUnmarked: doc?.notifyOnUnmarked ?? d.notifyOnUnmarked,
    emailSubject: doc?.emailSubject ?? d.emailSubject,
    emailBody: doc?.emailBody ?? d.emailBody,
    smsBody: doc?.smsBody ?? d.smsBody,
    emailSubjectAr: doc?.emailSubjectAr ?? d.emailSubjectAr,
    emailBodyAr: doc?.emailBodyAr ?? d.emailBodyAr,
    smsBodyAr: doc?.smsBodyAr ?? d.smsBodyAr,
  }
}

export interface RenderedMessage {
  subject: string
  body: string
}

/** Pick the subject + body for one channel in one language, English as the
 * fallback when an Arabic template is blank. */
export function renderMessage(
  settings: EffectiveSettings,
  channel: NotifyChannel,
  language: GuardianLanguage,
  tokens: { studentName: string; date: string; schoolName: string; branchName: string },
): RenderedMessage {
  const ar = language === 'ar'
  const subjectTpl = (ar && settings.emailSubjectAr.trim()) || settings.emailSubject
  const bodyTpl =
    channel === 'email'
      ? (ar && settings.emailBodyAr.trim()) || settings.emailBody
      : (ar && settings.smsBodyAr.trim()) || settings.smsBody
  return { subject: fill(subjectTpl, tokens), body: fill(bodyTpl, tokens) }
}

function fill(
  template: string,
  tokens: { studentName: string; date: string; schoolName: string; branchName: string },
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in tokens ? tokens[name as keyof typeof tokens] : match,
  )
}
