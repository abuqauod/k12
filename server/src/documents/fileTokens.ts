import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.js'

/**
 * Short-lived signed links for downloading one document version (SAMS 2.1).
 *
 * The roadmap planned to reuse `actionTokens`, but those are single-use
 * database rows. A preview can't work with single use: browsers fetch a
 * PDF in several range requests, and an image may be fetched again. So a
 * link is a signed token that expires after a few minutes instead. The
 * caller's permission and branch are checked when the link is created. The
 * token names one tenant and one document, so it can't be pointed at
 * anything else.
 *
 * The issuer differs from access tokens (auth/tokens.ts), so a file token
 * can never pass as a session, nor a session as a file token.
 */
const secret = new TextEncoder().encode(config.jwtSecret)
const ISSUER = 'timetable-studio/document-file'
export const FILE_LINK_TTL_SECONDS = 5 * 60

export interface FileLinkClaims {
  tenantId: string
  documentId: string
  /** Who created the link, for the audit trail of who opened what. */
  userId: string
  download: boolean
}

export async function signFileLink(claims: FileLinkClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + FILE_LINK_TTL_SECONDS * 1000)
  const token = await new SignJWT({ tid: claims.tenantId, doc: claims.documentId, dl: claims.download })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret)
  return { token, expiresAt }
}

export async function verifyFileLink(token: string): Promise<FileLinkClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER })
    if (typeof payload.tid !== 'string' || typeof payload.doc !== 'string' || typeof payload.sub !== 'string') {
      return null
    }
    return { tenantId: payload.tid, documentId: payload.doc, userId: payload.sub, download: payload.dl === true }
  } catch {
    return null
  }
}
