import type { GuardianLanguage, MessageKind, MessageTemplateDoc, NotifyChannel, TenantContext } from '../db.js'

/**
 * SAMS 6.1: one template per message kind, in English and Arabic. A school
 * may edit them (Communication → Templates); a kind nobody edited uses the
 * defaults here. Absence notices keep their per-branch templates
 * (settings.ts), so `absence` has no entry.
 *
 * Tokens are `{name}`; an unknown token is left as written, so a typo shows
 * up in the message instead of vanishing.
 */

export type TemplateKind = Exclude<MessageKind, 'absence'>

export interface TemplateText {
  enabled: boolean
  subject: string
  body: string
  smsBody: string
  subjectAr: string
  bodyAr: string
  smsBodyAr: string
}

/** Which tokens each kind fills in — shown next to the editor. */
export const TEMPLATE_TOKENS: Record<TemplateKind, string[]> = {
  announcement: ['title', 'body', 'schoolName'],
  fee_reminder: ['parentName', 'studentName', 'invoiceNumber', 'amountDue', 'dueDate', 'schoolName'],
  payment_received: ['parentName', 'studentName', 'amount', 'receiptNumber', 'schoolName'],
  admission_decision: ['guardianName', 'applicantName', 'applicationNumber', 'decision', 'schoolName'],
  document_rejected: ['parentName', 'studentName', 'document', 'note', 'schoolName'],
  document_expiring: ['parentName', 'studentName', 'document', 'expiresAt', 'schoolName'],
  approval_decided: ['summary', 'outcome'],
  report_ready: ['report', 'period', 'rows', 'link', 'schoolName'],
  clinic_visit: ['parentName', 'studentName', 'time', 'complaint', 'outcome', 'treatment', 'schoolName'],
  incident: ['parentName', 'studentName', 'date', 'type', 'description', 'action', 'schoolName'],
  report_card: ['parentName', 'studentName', 'term', 'link', 'schoolName'],
}

export const TEMPLATE_KINDS = Object.keys(TEMPLATE_TOKENS) as TemplateKind[]

export const DEFAULT_TEMPLATES: Record<TemplateKind, TemplateText> = {
  announcement: {
    enabled: true,
    subject: '{title}',
    body: '{body}\n\n{schoolName}',
    smsBody: '{schoolName}: {title}',
    subjectAr: '{title}',
    bodyAr: '{body}\n\n{schoolName}',
    smsBodyAr: '{schoolName}: {title}',
  },
  fee_reminder: {
    enabled: true,
    subject: 'Fee reminder — {studentName}',
    body:
      'Dear {parentName},\n\n' +
      'This is a reminder that {amountDue} is due on {dueDate} for {studentName} (invoice {invoiceNumber}).\n\n' +
      'If you have already paid, please ignore this message.\n\n{schoolName}',
    smsBody: '{schoolName}: {amountDue} for {studentName} is due on {dueDate} (invoice {invoiceNumber}).',
    subjectAr: 'تذكير بالرسوم — {studentName}',
    bodyAr:
      'عزيزي {parentName}،\n\n' +
      'نذكّركم بأن مبلغ {amountDue} مستحق بتاريخ {dueDate} عن {studentName} (فاتورة {invoiceNumber}).\n\n' +
      'إذا كنتم قد دفعتم بالفعل، يُرجى تجاهل هذه الرسالة.\n\n{schoolName}',
    smsBodyAr: '{schoolName}: مبلغ {amountDue} عن {studentName} مستحق بتاريخ {dueDate} (فاتورة {invoiceNumber}).',
  },
  payment_received: {
    enabled: true,
    subject: 'Payment received — {studentName}',
    body:
      'Dear {parentName},\n\n' +
      'We have received {amount} for {studentName}. Your receipt number is {receiptNumber}.\n\n' +
      'Thank you,\n{schoolName}',
    smsBody: '{schoolName}: we received {amount} for {studentName}. Receipt {receiptNumber}.',
    subjectAr: 'تم استلام الدفعة — {studentName}',
    bodyAr:
      'عزيزي {parentName}،\n\n' +
      'استلمنا مبلغ {amount} عن {studentName}. رقم الإيصال {receiptNumber}.\n\n' +
      'شكرًا لكم،\n{schoolName}',
    smsBodyAr: '{schoolName}: استلمنا {amount} عن {studentName}. إيصال {receiptNumber}.',
  },
  admission_decision: {
    enabled: true,
    subject: 'Application {applicationNumber} — {decision}',
    body:
      'Dear {guardianName},\n\n' +
      'The application for {applicantName} ({applicationNumber}) has been {decision}.\n\n' +
      'Please contact the admissions office if you have any questions.\n\n{schoolName}',
    smsBody: '{schoolName}: the application for {applicantName} has been {decision}.',
    subjectAr: 'الطلب {applicationNumber} — {decision}',
    bodyAr:
      'عزيزي {guardianName}،\n\n' +
      'تم {decision} طلب التسجيل الخاص بـ {applicantName} ({applicationNumber}).\n\n' +
      'يُرجى التواصل مع مكتب القبول لأي استفسار.\n\n{schoolName}',
    smsBodyAr: '{schoolName}: تم {decision} طلب التسجيل الخاص بـ {applicantName}.',
  },
  document_rejected: {
    enabled: true,
    subject: 'Document needs replacing — {studentName}',
    body:
      'Dear {parentName},\n\n' +
      'We could not accept the {document} for {studentName}: {note}\n\n' +
      'Please provide a new copy to the school office.\n\n{schoolName}',
    smsBody: '{schoolName}: the {document} for {studentName} was not accepted. Please provide a new copy.',
    subjectAr: 'مستند بحاجة إلى استبدال — {studentName}',
    bodyAr:
      'عزيزي {parentName}،\n\n' +
      'لم نتمكن من قبول {document} الخاص بـ {studentName}: {note}\n\n' +
      'يُرجى تزويد إدارة المدرسة بنسخة جديدة.\n\n{schoolName}',
    smsBodyAr: '{schoolName}: لم يُقبل {document} الخاص بـ {studentName}. يُرجى تزويدنا بنسخة جديدة.',
  },
  document_expiring: {
    enabled: true,
    subject: 'Document expiring — {studentName}',
    body:
      'Dear {parentName},\n\n' +
      'The {document} we hold for {studentName} expires on {expiresAt}. Please provide an updated copy.\n\n{schoolName}',
    smsBody: '{schoolName}: the {document} for {studentName} expires on {expiresAt}. Please send a new copy.',
    subjectAr: 'مستند على وشك الانتهاء — {studentName}',
    bodyAr:
      'عزيزي {parentName}،\n\n' +
      'تنتهي صلاحية {document} الخاص بـ {studentName} بتاريخ {expiresAt}. يُرجى تزويدنا بنسخة محدّثة.\n\n{schoolName}',
    smsBodyAr: '{schoolName}: تنتهي صلاحية {document} الخاص بـ {studentName} بتاريخ {expiresAt}.',
  },
  approval_decided: {
    enabled: true,
    subject: 'Request {outcome}: {summary}',
    body: 'Your request "{summary}" was {outcome}.',
    smsBody: 'Your request "{summary}" was {outcome}.',
    subjectAr: 'الطلب {outcome}: {summary}',
    bodyAr: 'طلبك "{summary}" {outcome}.',
    smsBodyAr: 'طلبك "{summary}" {outcome}.',
  },
  report_ready: {
    enabled: true,
    subject: 'Report ready: {report}',
    body: 'Your scheduled report "{report}" ({period}, {rows} rows) is ready.\n\nDownload it here: {link}\n\n{schoolName}',
    smsBody: '{schoolName}: report "{report}" is ready.',
    subjectAr: 'التقرير جاهز: {report}',
    bodyAr: 'تقريرك المجدول "{report}" ({period}، {rows} صف) جاهز.\n\nيمكنك تنزيله من هنا: {link}\n\n{schoolName}',
    smsBodyAr: '{schoolName}: التقرير "{report}" جاهز.',
  },
  clinic_visit: {
    enabled: true,
    subject: 'Clinic visit — {studentName}',
    body:
      'Dear {parentName},\n\n' +
      '{studentName} visited the school clinic at {time} ({complaint}). Outcome: {outcome}.\n' +
      'Treatment: {treatment}\n\n' +
      'Please contact the school if you have any questions.\n\n{schoolName}',
    smsBody: '{schoolName}: {studentName} visited the clinic ({complaint}). Outcome: {outcome}.',
    subjectAr: 'زيارة العيادة — {studentName}',
    bodyAr:
      'عزيزي {parentName}،\n\n' +
      'راجع {studentName} عيادة المدرسة الساعة {time} ({complaint}). النتيجة: {outcome}.\n' +
      'الإجراء: {treatment}\n\n' +
      'يُرجى التواصل مع المدرسة لأي استفسار.\n\n{schoolName}',
    smsBodyAr: '{schoolName}: راجع {studentName} العيادة ({complaint}). النتيجة: {outcome}.',
  },
  incident: {
    enabled: true,
    subject: 'Behaviour report — {studentName}',
    body:
      'Dear {parentName},\n\n' +
      'We would like to inform you of an incident involving {studentName} on {date} ({type}).\n\n' +
      '{description}\n\n' +
      'Action taken: {action}\n\n' +
      'Please contact the school to discuss it.\n\n{schoolName}',
    smsBody: '{schoolName}: an incident involving {studentName} on {date} ({type}). Please contact the school.',
    subjectAr: 'تقرير سلوكي — {studentName}',
    bodyAr:
      'عزيزي {parentName}،\n\n' +
      'نود إعلامكم بحادثة تخص {studentName} بتاريخ {date} ({type}).\n\n' +
      '{description}\n\n' +
      'الإجراء المتخذ: {action}\n\n' +
      'يُرجى التواصل مع المدرسة لمناقشتها.\n\n{schoolName}',
    smsBodyAr: '{schoolName}: حادثة تخص {studentName} بتاريخ {date} ({type}). يُرجى التواصل مع المدرسة.',
  },
  report_card: {
    enabled: true,
    subject: 'Report card — {studentName}, {term}',
    body: 'Dear {parentName},\n\n{studentName}’s report card for {term} is ready in the parent portal:\n{link}\n\n{schoolName}',
    smsBody: '{schoolName}: {studentName}’s report card for {term} is in the parent portal.',
    subjectAr: 'الشهادة المدرسية — {studentName}، {term}',
    bodyAr: 'عزيزي {parentName}،\n\nشهادة {studentName} عن {term} متاحة الآن في بوابة أولياء الأمور:\n{link}\n\n{schoolName}',
    smsBodyAr: '{schoolName}: شهادة {studentName} عن {term} متاحة في بوابة أولياء الأمور.',
  },
}

export function fromDoc(kind: TemplateKind, doc: MessageTemplateDoc | null): TemplateText {
  const d = DEFAULT_TEMPLATES[kind]
  if (!doc) return { ...d }
  return {
    enabled: doc.enabled,
    subject: doc.subject,
    body: doc.body,
    smsBody: doc.smsBody,
    subjectAr: doc.subjectAr,
    bodyAr: doc.bodyAr,
    smsBodyAr: doc.smsBodyAr,
  }
}

export async function loadTemplate(ctx: TenantContext, tenantId: string, kind: TemplateKind): Promise<TemplateText> {
  return fromDoc(kind, await ctx.messageTemplates.findOne({ _id: `${tenantId}:${kind}` }))
}

export type Tokens = Record<string, string>

export function fill(template: string, tokens: Tokens): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => tokens[name] ?? match)
}

/** Subject and body for one channel and language; a blank Arabic text
 * falls back to the English. In-app uses the email subject and body. */
export function render(
  text: TemplateText,
  channel: NotifyChannel | 'in_app',
  language: GuardianLanguage,
  tokens: Tokens,
): { subject: string; body: string } {
  const ar = language === 'ar'
  const subject = (ar && text.subjectAr.trim()) || text.subject
  const body =
    channel === 'sms'
      ? (ar && text.smsBodyAr.trim()) || text.smsBody
      : (ar && text.bodyAr.trim()) || text.body
  return { subject: fill(subject, tokens), body: fill(body, tokens) }
}
