/**
 * SAMS 8.1 — what a production start checks before it listens. Fatal
 * problems stop the process (a default JWT secret signs tokens anyone with
 * this repository could forge); warnings are logged once and the server
 * starts. Pure over `env` so the rules are testable.
 */

export interface Preflight {
  fatal: string[]
  warnings: string[]
  /** One line per optional channel: on or off, and through what. */
  channels: string[]
}

const DEFAULT_JWT = 'dev-only-secret-change-me-in-production'
const isLocal = (url: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/i.test(url)

export function preflight(env: NodeJS.ProcessEnv): Preflight {
  const fatal: string[] = []
  const warnings: string[] = []

  const jwt = env.JWT_SECRET ?? ''
  if (!jwt || jwt === DEFAULT_JWT) fatal.push('JWT_SECRET is not set (or is the development default)')
  else if (jwt.length < 32) fatal.push('JWT_SECRET is shorter than 32 characters')

  const db = env.DATABASE_URL ?? ''
  if (!db) fatal.push('DATABASE_URL is not set')
  else if (db.includes(':mongo_root_password@')) fatal.push('DATABASE_URL uses the default MongoDB password (set MONGO_ROOT_PASSWORD)')

  const appUrl = env.APP_URL ?? env.CORS_ORIGINS?.split(',')[0] ?? ''
  if (!appUrl || isLocal(appUrl)) warnings.push('APP_URL is local: links in emails (invites, resets, reports) will not open for recipients')
  else if (!appUrl.startsWith('https://')) warnings.push('APP_URL is not https')

  const origins = (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)
  if (origins.length === 0) warnings.push('CORS_ORIGINS is not set: the school app cannot call this API from its own domain')
  else if (origins.some(isLocal)) warnings.push('CORS_ORIGINS includes a local address')

  if (!env.BACKUP_DIR && !env.BACKUP_S3_BUCKET) warnings.push('No backups configured (BACKUP_DIR or BACKUP_S3_BUCKET; see scripts/backup.sh)')

  const channels = [
    env.SMTP_HOST ? `email: on (${env.SMTP_HOST})` : 'email: off — invites, resets and family emails will not be sent',
    env.SMS_PROVIDER ? `sms: on (${env.SMS_PROVIDER})` : 'sms: off',
    env.ERROR_REPORTING_DSN ? 'error reporting: on' : 'error reporting: off (logs only)',
  ]
  return { fatal, warnings, channels }
}
