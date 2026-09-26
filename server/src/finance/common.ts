import type { TenantContext } from '../db.js'
import { money } from '../records.js'

/** Finance's view of the shared record plumbing (../records.ts). */
export {
  Abort as FinanceAbort,
  branchFilter,
  isFailure,
  money,
  scoped,
  sendFailure,
  todayIso,
  transact,
  type Failure,
} from '../records.js'

/** "10%" or the amount, for approval summaries. */
export const describeValue = (type: 'amount' | 'percent', value: number) =>
  type === 'percent' ? `${value}%` : money(value)

export async function studentName(ctx: TenantContext, studentId: string): Promise<string> {
  const s = await ctx.students.findOne({ _id: studentId })
  return s ? `${s.givenName} ${s.familyName}`.trim() : studentId
}
