import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hash } from 'starknet'

const dataFile = join(tmpdir(), `kudirail-bank-payout-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = dataFile
process.env.PAYCREST_API_KEY = 'test-key'
const pool = `0x${'4'.repeat(64)}`
const receiveAddress = `0x${'6'.repeat(64)}`
const refundAddress = '0xabc'
const transactionHash = `0x${'5'.repeat(64)}`

const store = await import('../src/server/account-store')
const { reconcileBankPayout, receiptProvesPaycrestPayment } = await import('../src/server/bank-payout-reconciliation')
const { deriveBankPayoutDisplayStatus } = await import('../src/bank-payout')
const { persistPaycrestWebhook } = await import('../src/server/paycrest-webhook')

test.after(async () => { await rm(dataFile, { force: true }) })

async function savedOrder(id = 'order-12345678') {
  return store.recordBankPayoutOrder(refundAddress, {
    id, reference: `kudiroll-${id}`, status: 'initiated', amountNgn: '800', amountUsdc: '0.585222',
    receiveAddress, validUntil: new Date(Date.now() + 60_000).toISOString(), accountName: 'TEST RECIPIENT', bankLast4: '9696', institution: '999992',
  })
}

test('persists an immutable payout transaction and blocks duplicate orders', async () => {
  const payout = await savedOrder()
  assert.equal(payout.displayStatus, 'ready-to-pay')
  await assert.rejects(savedOrder('order-87654321'), /Resolve the existing bank payout/)
  await store.beginBankPayoutSubmission(refundAddress, payout.id)
  const submitted = await store.recordBankPayoutTransaction(refundAddress, payout.id, { transactionHash })
  assert.equal(submitted.transactionHash, transactionHash)
  assert.equal(submitted.displayStatus, 'payment-submitted')
  await assert.rejects(store.recordBankPayoutTransaction(refundAddress, payout.id, { transactionHash: '0x123' }), /different immutable transaction hash/)
  const restored = (await store.getAccount(refundAddress)).bankPayouts[0]
  assert.equal(restored.transactionHash, transactionHash)
})

test('requires the exact token, pool, recipient and amount in Starknet evidence', () => {
  const event = {
    from_address: '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
    keys: [hash.getSelectorFromName('Transfer'), pool, receiveAddress],
    data: ['0x8ee06', '0x0'],
  }
  assert.equal(receiptProvesPaycrestPayment([event], { poolAddress: pool, receiveAddress, amountUsdc: '0.585222' }), true)
  assert.equal(receiptProvesPaycrestPayment([event], { poolAddress: pool, receiveAddress, amountUsdc: '0.585223' }), false)
})

test('marks a finalized but Paycrest-expired payment for reconciliation', async () => {
  const fakeReceiptProvider = { getTransactionReceipt: async () => ({
    value: { block_number: 14092107, events: [{
      from_address: '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
      keys: [hash.getSelectorFromName('Transfer'), pool, receiveAddress], data: ['0x8ee06', '0x0'],
    }] },
    isError: () => false, isReverted: () => false,
  }) }
  const fakePaycrest = async () => new Response(JSON.stringify({ data: {
    id: 'order-12345678', status: 'expired', amount: '0.585222', amountPaid: '0', amountReturned: '0',
    source: { network: 'starknet', currency: 'USDC' }, destination: { amount: '800', currency: 'NGN', recipient: { accountIdentifier: '0000009696' } },
  } }), { status: 200 })
  const result = await reconcileBankPayout(refundAddress, 'order-12345678', { receiptProvider: fakeReceiptProvider, canonicalPoolAddress: pool, paycrestFetcher: fakePaycrest as typeof fetch })
  assert.equal(result.payout.chainStatus, 'succeeded')
  assert.equal(result.payout.providerStatus, 'expired')
  assert.equal(result.payout.displayStatus, 'reconciliation-required')
  assert.match(result.payout.reconciliationReason, /Starknet finalized/)
})

test('derives the requested customer-facing recovery states', () => {
  const base = { providerStatus: 'initiated', transactionHash, submissionState: 'submitted' as const, chainStatus: 'pending' as const, validUntil: new Date(Date.now() + 60_000).toISOString() }
  assert.equal(deriveBankPayoutDisplayStatus(base), 'payment-submitted')
  assert.equal(deriveBankPayoutDisplayStatus({ ...base, chainStatus: 'succeeded' }), 'awaiting-paycrest-detection')
  assert.equal(deriveBankPayoutDisplayStatus({ ...base, providerStatus: 'refunding' }), 'refunding')
  assert.equal(deriveBankPayoutDisplayStatus({ ...base, providerStatus: 'refunded' }), 'refunded')
  assert.equal(deriveBankPayoutDisplayStatus({ ...base, providerStatus: 'settled' }), 'completed')
  assert.equal(deriveBankPayoutDisplayStatus({ ...base, transactionHash: '', submissionState: 'not-started', providerStatus: 'validated' }), 'payment-submitted')
})

test('persists verified Paycrest webhook state into the durable payout record', async () => {
  await persistPaycrestWebhook({ event: 'payment_order.refunding', data: { id: 'order-12345678', status: 'refunding', amountPaid: '0.585222', timestamp: '2026-08-30T12:00:00.000Z' } })
  const payout = (await store.getAccount(refundAddress)).bankPayouts[0]
  assert.equal(payout.providerStatus, 'refunding')
  assert.equal(payout.providerAmountPaid, '0.585222')
  assert.equal(payout.displayStatus, 'refunding')
})
