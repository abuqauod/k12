import { z } from 'zod'
import type { InvoiceDoc, TenantContext } from '../db.js'
import { registerApprovalType } from '../approvals/registry.js'
import { computeLineNet, invoicePaidTotal, price, updateLineItem } from './service.js'

/**
 * First consumer of the shared approval engine (SAMS 1.10): a discount on an
 * existing invoice line. Someone who may edit lines but not grant discounts
 * (`finance.invoice.lineItems` without `finance.discount.approve`) requests
 * one; a holder of `finance.discount.approve` decides. On approval the
 * discount is applied through the normal line-item update, in the same
 * transaction as the decision.
 */

const payloadSchema = z.object({
  lineItemId: z.string().min(1),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.number().int().min(1) }),
  /** The line amount the requester saw — a changed line makes the request
   * stale rather than silently discounting a different amount. */
  expectedAmount: z.number().int().min(0),
})
type Payload = z.infer<typeof payloadSchema>

type Check = { ok: true; invoice: InvoiceDoc; label: string } | { ok: false; error: string }

async function check(
  ctx: TenantContext,
  invoiceId: string,
  payload: Payload,
  stage: 'request' | 'approve',
): Promise<Check> {
  const invoice = await ctx.invoices.findOne({ _id: invoiceId })
  if (!invoice) return { ok: false, error: 'UNKNOWN_INVOICE' }
  if (invoice.status === 'void') return { ok: false, error: 'INVOICE_VOID' }
  // Fully paid: any discount would push the total below what was paid.
  if (invoice.status === 'paid') return { ok: false, error: 'INVOICE_PAID' }
  const line = invoice.lineItems.find((l) => l.id === payload.lineItemId)
  if (!line) return { ok: false, error: 'UNKNOWN_LINE_ITEM' }
  if (line.amount !== payload.expectedAmount) return { ok: false, error: 'STALE_REQUEST' }
  // Requests are for undiscounted lines; one discounted since the request
  // is stale rather than silently overwritten.
  if (line.discount !== null) return { ok: false, error: stage === 'request' ? 'LINE_ALREADY_DISCOUNTED' : 'STALE_REQUEST' }
  const { type, value } = payload.discount
  if ((type === 'percent' && value > 100) || (type === 'amount' && value > line.amount)) {
    return { ok: false, error: 'DISCOUNT_OUT_OF_RANGE' }
  }
  return { ok: true, invoice, label: line.label }
}

registerApprovalType<Payload>({
  type: 'finance.lineDiscount',
  entity: 'invoice',
  requestScope: 'finance.invoice.lineItems',
  decideScope: 'finance.discount.approve',
  payloadSchema,
  async resolve(ctx, invoiceId, payload) {
    const checked = await check(ctx, invoiceId, payload, 'request')
    if (!checked.ok) return checked
    const { type, value } = payload.discount
    return {
      ok: true,
      branchId: checked.invoice.branchId,
      dedupeKey: `invoice:${invoiceId}:line:${payload.lineItemId}`,
      summary: `${checked.invoice.invoiceNumber} · ${checked.label} · −${value}${type === 'percent' ? '%' : ''}`,
    }
  },
  async onApproved(ctx, request, actorId) {
    const payload = request.payload as Payload
    const checked = await check(ctx, request.entityId, payload, 'approve')
    if (!checked.ok) return checked
    // The discounted total must not fall below what has already been paid.
    const lines = checked.invoice.lineItems.map((l) =>
      l.id === payload.lineItemId ? { ...l, netAmount: computeLineNet(l.amount, payload.discount) } : l,
    )
    const newTotal = price(lines, checked.invoice.adjustments).total
    if (newTotal < (await invoicePaidTotal(ctx, request.entityId))) return { ok: false, error: 'DISCOUNT_BELOW_PAID' }
    const updated = await updateLineItem(ctx, request.entityId, payload.lineItemId, {
      discount: payload.discount,
      actorId,
    })
    return updated.ok ? { ok: true } : { ok: false, error: updated.error }
  },
})
