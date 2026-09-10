import { enqueueAbsenceNotifications, processQueue } from './queue.js'
import type { EnqueueOutcome } from './queue.js'

/**
 * The immediate path — the manual "notify now" button and the per-row
 * "notify this guardian" action. Enqueues the jobs, then gives the queue a
 * synchronous nudge so the caller usually sees them delivered by the time
 * the request returns, without the request ever *waiting* on a slow
 * provider (the nudge is bounded and the scheduled worker mops up anything
 * left).
 */
export interface RunOutcome extends EnqueueOutcome {
  delivered: number
  retried: number
  dead: number
}

export async function runAbsenceNotifications(params: {
  tenantId: string
  branchId: string
  date: string
  actorId: string | null
  studentId?: string
}): Promise<RunOutcome> {
  const enqueued = await enqueueAbsenceNotifications({
    ...params,
    trigger: 'manual',
    respectEnabledFlag: false,
  })
  const processed = await processQueue(Math.max(25, enqueued.enqueued + enqueued.alreadyQueued))
  return {
    ...enqueued,
    delivered: processed.sent,
    retried: processed.retried,
    dead: processed.dead,
  }
}
