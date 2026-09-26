import 'dotenv/config'

// Loads `.env` from the current working directory if one exists — harmless in
// Docker (compose already sets real env vars, and dotenv never overwrites an
// existing `process.env` entry) and useful on shared hosting, where an SSH
// terminal or cron job may not inherit the panel's configured environment.

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * MongoDB connection string, e.g. from Atlas:
   * mongodb+srv://user:pass@cluster.mongodb.net/timetable?retryWrites=true
   * The database name in the path is the one the app uses — MongoClient
   * connects to the cluster, `.db()` (no argument) picks it from here.
   */
  databaseUrl: required(
    'DATABASE_URL',
    // Local-only default — never a real host/credential. Set DATABASE_URL in
    // the environment (or .env) for anything that isn't your own machine.
    'mongodb://localhost:27017/timetable',
  ),
  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me-in-production'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 30),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5183')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  /** Largest accepted dataset document. A big school is well under this. */
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 8 * 1024 * 1024),
  /** Largest accepted uploaded document (SAMS 2.1). */
  maxDocumentBytes: Number(process.env.MAX_DOCUMENT_BYTES ?? 10 * 1024 * 1024),
  /**
   * Set this when the app is reachable under a path, not its own
   * subdomain — e.g. Hostinger's Node.js Selector mounting the app at
   * `heymueen.com/api` rather than `api.heymueen.com`. Passenger (and
   * similar) forward the full path *including* that prefix to the app; it
   * doesn't get stripped, so every route needs to expect it. Leave unset
   * for a dedicated subdomain or bare host:port, where there's no prefix
   * to strip in the first place.
   */
  routePrefix: (process.env.ROUTE_PREFIX ?? '').replace(/\/+$/, ''),
  /**
   * Where invite and password-reset links point — the frontend, not this API.
   * Defaults to the first configured CORS origin, since that's almost always
   * the intended frontend anyway.
   */
  appUrl: (process.env.APP_URL ?? process.env.CORS_ORIGINS?.split(',')[0] ?? 'http://localhost:5183').replace(/\/+$/, ''),
  /**
   * SMTP is optional: invite and password-reset emails simply can't be sent
   * without it (the route returns a clear error rather than pretending to
   * succeed), and queued family/staff emails end up in the delivery log as
   * EMAIL_NOT_CONFIGURED. Everything else works regardless.
   *
   * `SMTP_USER`/`SMTP_PASS` may be left out for a relay that needs no login
   * (a local Postfix, an office relay, a mail catcher in development); then
   * `SMTP_FROM` is required.
   */
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        // Port 465 is implicit TLS; anything else (587, 25) starts plain and
        // upgrades via STARTTLS, which nodemailer does on its own.
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT ?? 587) === 465,
        user: process.env.SMTP_USER || null,
        pass: process.env.SMTP_USER ? required('SMTP_PASS') : null,
        from: process.env.SMTP_FROM ?? required('SMTP_USER'),
      }
    : null,
  /**
   * SMS is optional too; without it SMS jobs die as SMS_NOT_CONFIGURED.
   *  - `twilio`: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM (a
   *    number or messaging-service SID starting "MG");
   *  - `webhook`: any HTTP SMS gateway — SMS_WEBHOOK_URL receives a JSON
   *    POST `{ to, body, from }`, with `Authorization: Bearer SMS_WEBHOOK_TOKEN`
   *    when set; a 2xx is a send;
   *  - `log`: development only — prints the message instead of sending it.
   */
  sms: smsConfig(),
}

type SmsConfig =
  | { provider: 'twilio'; accountSid: string; authToken: string; from: string }
  | { provider: 'webhook'; url: string; token: string | null; from: string | null }
  | { provider: 'log' }
  | null

function smsConfig(): SmsConfig {
  const provider = (process.env.SMS_PROVIDER ?? '').trim().toLowerCase()
  if (!provider) return null
  if (provider === 'twilio') {
    return {
      provider,
      accountSid: required('TWILIO_ACCOUNT_SID'),
      authToken: required('TWILIO_AUTH_TOKEN'),
      from: required('TWILIO_FROM'),
    }
  }
  if (provider === 'webhook') {
    return {
      provider,
      url: required('SMS_WEBHOOK_URL'),
      token: process.env.SMS_WEBHOOK_TOKEN || null,
      from: process.env.SMS_FROM || null,
    }
  }
  if (provider === 'log') {
    if (process.env.NODE_ENV === 'production') throw new Error('SMS_PROVIDER=log is for development only')
    return { provider }
  }
  throw new Error(`Unknown SMS_PROVIDER "${provider}" (use twilio, webhook or log)`)
}

export const isProduction = process.env.NODE_ENV === 'production'
