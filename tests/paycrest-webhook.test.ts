import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import express from 'express'
import { createPaycrestWebhookHandler } from '../src/server/paycrest-webhook'

test('accepts only a correctly signed raw Paycrest webhook', async () => {
  const previous = process.env.PAYCREST_API_SECRET
  process.env.PAYCREST_API_SECRET = 'test-webhook-secret'
  const received: Record<string, unknown>[] = []
  const app = express()
  app.post('/webhook', express.raw({ type: 'application/json' }), createPaycrestWebhookHandler(async payload => { received.push(payload) }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  try {
    const port = (server.address() as { port: number }).port
    const body = Buffer.from(JSON.stringify({ event: 'payment_order.settled', data: { id: 'order-1' } }))
    const validSignature = createHmac('sha256', 'test-webhook-secret').update(body).digest('hex')
    const invalid = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paycrest-Signature': '0'.repeat(64) }, body })
    assert.equal(invalid.status, 401)
    assert.equal(received.length, 0)
    const valid = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paycrest-Signature': validSignature }, body })
    assert.equal(valid.status, 204)
    assert.equal(received.length, 1)
  } finally {
    if (previous === undefined) delete process.env.PAYCREST_API_SECRET
    else process.env.PAYCREST_API_SECRET = previous
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
