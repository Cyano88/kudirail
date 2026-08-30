import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'

function configuredSecret() {
  return process.env.PAYCREST_API_SECRET?.trim() || process.env.PAYCREST_WEBHOOK_SECRET?.trim() || ''
}

export function verifyPaycrestWebhook(body: Buffer, signature: string, secret = configuredSecret()) {
  const candidate = signature.trim().toLowerCase()
  if (!secret || !/^[0-9a-f]{64}$/.test(candidate)) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  const received = Buffer.from(candidate, 'hex')
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

export const paycrestWebhookHandler = createPaycrestWebhookHandler()
