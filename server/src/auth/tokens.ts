import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.js'

const secret = new TextEncoder().encode(config.jwtSecret)

export type Role = 'owner' | 'admin' | 'scheduler' | 'viewer'

export interface AccessClaims {
  sub: string
  email: string
  /**
   * Absent for a platform-admin session, which by definition has no single
   * school's context — `/admin/*` routes take a tenant id as a parameter
   * instead of reading it from the token.
   */
  tenantId?: string
  role?: Role
  /** The vendor's own operator flag — see `UserDoc.platformAdmin`. */
  platformAdmin?: boolean
}

/**
 * Short-lived bearer token. The tenant is a claim, not a request parameter, so
 * a caller cannot ask for another school's data by changing a URL.
 */
export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    tenantId: claims.tenantId,
    role: claims.role,
    email: claims.email,
    platformAdmin: claims.platformAdmin || undefined,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('timetable-studio')
    .setExpirationTime(config.accessTokenTtl)
    .sign(secret)
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: 'timetable-studio' })
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Malformed token payload')
  }
  if (payload.tenantId !== undefined && typeof payload.tenantId !== 'string') {
    throw new Error('Malformed token payload')
  }
  if (payload.role !== undefined && typeof payload.role !== 'string') {
    throw new Error('Malformed token payload')
  }
  return {
    sub: payload.sub,
    email: payload.email,
    tenantId: payload.tenantId as string | undefined,
    role: payload.role as Role | undefined,
    platformAdmin: payload.platformAdmin === true,
  }
}

/**
 * Refresh tokens are opaque random strings. Only their SHA-256 is stored, so a
 * dump of the database does not yield usable sessions.
 */
export function createRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url')
  return { token, hash: hashRefreshToken(token) }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
