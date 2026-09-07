import { createHash, randomBytes } from 'node:crypto'

/** `sk_live_` makes a leaked key grep-able and visually distinct from a JWT. */
export function generateApiKey(): { key: string; hash: string; preview: string } {
  const key = `sk_live_${randomBytes(24).toString('base64url')}`
  return { key, hash: hashApiKey(key), preview: `${key.slice(0, 12)}…` }
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
