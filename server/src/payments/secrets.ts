import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { config } from '../config.js'

/**
 * SAMS 11.1: gateway keys at rest. AES-256-GCM with a key from
 * `PAYMENTS_SECRET_KEY` (32 bytes, base64) or, when that is unset, one
 * derived from `JWT_SECRET` — so a database dump alone never yields a
 * school's merchant keys. Changing either key makes the stored secrets
 * unreadable: the school re-enters them in Settings → Online payments.
 */

function key(): Buffer {
  const given = process.env.PAYMENTS_SECRET_KEY
  if (given) {
    const raw = Buffer.from(given, 'base64')
    if (raw.length !== 32) throw new Error('PAYMENTS_SECRET_KEY must be 32 bytes, base64-encoded')
    return raw
  }
  return Buffer.from(hkdfSync('sha256', config.jwtSecret, 'sams-payments', 'gateway-secrets', 32))
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':')
}

/** Null when the value was sealed with another key or has been altered. */
export function openSecret(sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split(':')
  if (version !== 'v1' || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
