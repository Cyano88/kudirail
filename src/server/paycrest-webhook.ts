import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { updateBankPayoutProvider } from './account-store'

function configuredSecret() {
  return process.env.PAYCREST_API_SECRET?.trim() || process.env.PAYCREST_WEBHOOK_SECRET?.trim() || ''
}

export function verifyPaycrestWebhook(body: Buffer, signature: string, secret = configuredSecret()) {
  const candidate = signature.trim().toLowerCase()
  if (!secret || !/^[0-9a-f]{64}$/.test(candidate)) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'utf8')
  const received = Buffer.from(candidate, 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function createPaycrestWebhookHandler(onEvent: (payload: Record<string, unknown>) => Promise<void> = async () => {}): RequestHandler {
  return async (req, res) => {
    const secret = configuredSecret()
    if (!secret) return res.status(503).json({ ok: false, error: 'Paycrest webhook verification is not configured.' })
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ ok: false, error: 'Paycrest webhook requires a raw JSON body.' })
    const signature = String(req.headers['x-paycrest-signature'] || '')
    if (!verifyPaycrestWebhook(req.body, signature, secret)) return res.status(401).json({ ok: false, error: 'Invalid Paycrest signature.' })
    let payload: unknown
    try { payload = JSON.parse(req.body.toString('utf8')) } catch { return res.status(400).json({ ok: false, error: 'Invalid Paycrest webhook JSON.' }) }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ ok: false, error: 'Invalid Paycrest webhook payload.' })
    try {
      await onEvent(payload as Record<string, unknown>)
      return res.status(204).end()
    } catch {
      return res.status(503).json({ ok: false, error: 'Paycrest webhook processing failed.' })
    }
  }
}

export async function persistPaycrestWebhook(payload: Record<string, unknown>) {
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data as Record<string, unknown> : payload
  const event = String(payload.event || '')
  const id = String(data.id || data.orderId || data.order_id || '').trim()
  if (!id) throw new Error('Paycrest webhook has no order id.')
  const eventStatus = event.split('.').pop() || ''
  await updateBankPayoutProvider(id, {
    status: data.status || eventStatus,
    amountPaid: data.amountPaid || data.amount_paid,
    amountReturned: data.amountReturned || data.amount_returned,
    txHash: data.txHash || data.tx_hash,
    updatedAt: data.updatedAt || data.updated_at || data.timestamp || payload.timestamp,
  })
}

export const paycrestWebhookHandler = createPaycrestWebhookHandler(persistPaycrestWebhook)
