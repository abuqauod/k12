import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request facts the audit log records (SAMS 1.12) without threading the
 * request object through every service call. Set by a global preHandler in
 * server.ts — preHandler, not onRequest, because the string JSON body
 * parser can drop an AsyncLocalStorage context set earlier. Everything the
 * route runs afterwards, transactions included, sees it. Background jobs
 * (the absence sweep) run outside any request and simply get nothing.
 */
export interface RequestContext {
  ip: string | null
  userAgent: string | null
  /** Set by a route that requires one (setAuditReason); recorded on every
   * audit row that request writes. */
  reason?: string | null
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext(context: RequestContext, fn: () => void): void {
  storage.run(context, fn)
}

/** Attaches the caller's stated reason to the audit rows this request writes. */
export function setAuditReason(reason: string): void {
  const store = storage.getStore()
  if (store) store.reason = reason
}

/** A sensitive action's reason from the request body: 3–500 characters
 * after trimming, else null (the route answers 400 REASON_REQUIRED). */
export function readReason(body: unknown): string | null {
  const raw = (body as { reason?: unknown } | null)?.reason
  if (typeof raw !== 'string') return null
  const reason = raw.trim()
  return reason.length >= 3 && reason.length <= 500 ? reason : null
}

export function currentRequestContext(): RequestContext {
  return storage.getStore() ?? { ip: null, userAgent: null }
}
