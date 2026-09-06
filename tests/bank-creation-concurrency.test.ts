import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import express from 'express'
const file = join(tmpdir(), `bank-creation-${randomUUID()}.json`)
const authFile = `${file}.auth`
process.env.KUDIROLL_DATA_FILE = file
process.env.KUDIROLL_AUTH_FILE = authFile
process.env.NODE_ENV = 'test'
process.env.PAYCREST_API_KEY = 'synthetic-test-key'
process.env.PHASE0_LIVE_ORDER_ENABLED = 'true'
const store = await import('../src/server/account-store')
const auth = await import('../src/server/auth-store')
const { createPhase0Router } = await import('../src/server/phase0-router')
test.after(async () => { await Promise.all([rm(file, { force: true }), rm(authFile, { force: true })]) })

test('concurrent HTTP requests invoke provider creation once; a lost response keeps the durable lock', async () => {
  const owner = '0xbc01'
  const token = await auth.createAuthSession(owner, 'wallet', '')
  let posts = 0
  let unblock!: () => void
  let reached!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  const held = new Promise<void>(resolve => { unblock = resolve })
  const fetcher: typeof fetch = async (url) => {
    if (String(url).includes('verify-account')) return Response.json({ data: { accountName: 'Synthetic Recipient' } })
    posts++
    reached()
    await held
    throw new Error('Synthetic lost provider response')
  }
  const app = express(); app.use(express.json()); app.use('/api/phase0', createPhase0Router({ fetcher }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const send = (body: any = {}) => fetch(`${origin}/api/phase0/paycrest/order`, { method: 'POST', headers: { Cookie: `kudiroll_session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amountNgn: '100', institution: 'TEST', accountIdentifier: '0123456789', ...body }) })
  try {
    // Validation fails before provider order POST and safely releases its reservation.
    assert.equal((await send({ accountIdentifier: 'bad' })).status, 400)
    assert.equal((await store.getAccount(owner)).bankOrderAttempt, null)
    const first = send({ workspace: 'enterprise' })
    await started
    assert.equal((await send()).status, 409)
    unblock()
    assert.equal((await first).status, 502)
    assert.equal(posts, 1)
    const attempt = (await store.getAccount(owner)).bankOrderAttempt!
    assert.equal(attempt.workspace, 'enterprise')
    assert.equal((await send()).status, 409)
    assert.equal(posts, 1)
    const order = { id: 'synthetic-order', reference: attempt.reference, amountUsdc: '1', amountNgn: '100', receiveAddress: '0xbc02', refundAddress: owner, bankLast4: '6789', accountName: 'Synthetic Recipient', validUntil: new Date(Date.now() + 60000).toISOString() }
    await assert.rejects(store.recordBankPayoutOrder(owner, { ...order, reference: 'wrong' }), /original reference/)
    const recovered = await store.recordBankPayoutOrder(owner, order)
    assert.equal(recovered.workspace, 'enterprise')
    assert.equal((await store.getAccount(owner)).bankOrderAttempt, null)
    await assert.rejects(store.beginBankOrderCreation(owner, 'standard'), /existing bank order/)
  } finally { unblock(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
