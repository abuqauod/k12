import nodemailer from 'nodemailer'
import { config } from './config.js'

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null

function getTransporter() {
  if (!config.smtp) return null
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  })
  return transporter
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('SMTP is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)')
    this.name = 'EmailNotConfiguredError'
  }
}

async function send(to: string, subject: string, html: string): Promise<void> {
  const client = getTransporter()
  if (!client || !config.smtp) throw new EmailNotConfiguredError()
  await client.sendMail({ from: config.smtp.from, to, subject, html })
}

/** Simple, dependency-free templating — this is not marketing email. */
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="font-family: sans-serif; color: #1a1a1a; max-width: 480px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 16px;">${title}</h2>
  ${bodyHtml}
  <p style="margin-top: 32px; color: #888; font-size: 12px;">K-12 Timetable Studio</p>
</body></html>`
}

function button(href: string, label: string): string {
  return `<p><a href="${href}" style="display:inline-block;background:#1a56db;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">${label}</a></p>
  <p style="color:#888;font-size:12px;">If the button doesn't work, copy this link: ${href}</p>`
}

export async function sendInviteEmail(params: {
  to: string
  tenantName: string
  inviterName: string
  token: string
}): Promise<void> {
  const link = `${config.appUrl}/accept-invite?token=${encodeURIComponent(params.token)}`
  await send(
    params.to,
    `You've been invited to ${params.tenantName}`,
    layout(
      `Join ${params.tenantName}`,
      `<p>${params.inviterName} invited you to join <b>${params.tenantName}</b> on K-12 Timetable Studio.</p>` +
        button(link, 'Accept invite & set your password') +
        `<p>This link expires in 7 days.</p>`,
    ),
  )
}

export async function sendAccessGrantedEmail(params: {
  to: string
  tenantName: string
  inviterName: string
}): Promise<void> {
  await send(
    params.to,
    `You now have access to ${params.tenantName}`,
    layout(
      `You're in at ${params.tenantName}`,
      `<p>${params.inviterName} added your existing account to <b>${params.tenantName}</b> on K-12 Timetable Studio.</p>` +
        `<p>Sign in as usual — if you belong to more than one school, you'll get to pick which one.</p>`,
    ),
  )
}

export async function sendPasswordResetEmail(params: { to: string; token: string }): Promise<void> {
  const link = `${config.appUrl}/reset-password?token=${encodeURIComponent(params.token)}`
  await send(
    params.to,
    'Reset your password',
    layout(
      'Reset your password',
      `<p>Someone requested a password reset for this account. If that wasn't you, ignore this email.</p>` +
        button(link, 'Reset password') +
        `<p>This link expires in 1 hour.</p>`,
    ),
  )
}

/** Escape the few characters that would let template text break out of the
 * HTML body it's dropped into. The template is school-authored, not
 * attacker-controlled, but it reaches a parent's inbox — belt and braces. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A plain, school-composed message (currently the unexplained-absence
 * notice). `body` is treated as text: newlines become paragraph breaks, and
 * it's HTML-escaped before it goes into the same `layout` every other mail
 * here uses. Throws `EmailNotConfiguredError` if SMTP isn't set up, same as
 * the rest.
 */
export async function sendPlainEmail(params: {
  to: string
  subject: string
  body: string
}): Promise<void> {
  const paragraphs = params.body
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  await send(params.to, params.subject, layout(escapeHtml(params.subject), paragraphs))
}
