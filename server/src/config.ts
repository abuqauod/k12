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
  /**
   * Where invite and password-reset links point — the frontend, not this API.
   * Defaults to the first configured CORS origin, since that's almost always
   * the intended frontend anyway.
   */
  appUrl: (process.env.APP_URL ?? process.env.CORS_ORIGINS?.split(',')[0] ?? 'http://localhost:5183').replace(/\/+$/, ''),
  /**
   * SMTP is optional: invite and password-reset emails simply can't be sent
   * without it (the route returns a clear error rather than pretending to
   * succeed). Everything else works regardless.
   */
  smtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        // Port 465 is implicit TLS; anything else (587, 25) starts plain and
        // upgrades via STARTTLS, which nodemailer does on its own.
        secure: Number(process.env.SMTP_PORT ?? 587) === 465,
        user: required('SMTP_USER'),
        pass: required('SMTP_PASS'),
        from: process.env.SMTP_FROM ?? required('SMTP_USER'),
      }
    : null,
}

export const isProduction = process.env.NODE_ENV === 'production'
