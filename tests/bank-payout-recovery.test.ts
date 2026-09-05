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
    value: { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L1', block_number: 14092107, events: [{
      from_address: '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
      keys: [hash.getSelectorFromName('Transfer'), pool, receiveAddress], data: ['0x8ee06', '0x0'],
    }] },
    isError: () => false, isReverted: () => false,
  }), getBlockWithTxHashes: async () => ({ block_number: 14092107, timestamp: Math.floor(Date.now() / 1000) }) }
  const fakePaycrest = async () => new Response(JSON.stringify({ data: {
    id: 'order-12345678', status: 'expired', amount: '0.585222', amountPaid: '0', amountReturned: '0',
    source: { network: 'starknet', currency: 'USDC' }, destination: { amount: '800', currency: 'NGN', recipient: { accountIdentifier: '0000009696' } },
  } }), { status: 200 })
  const result = await reconcileBankPayout(refundAddress, 'order-12345678', { receiptProvider: fakeReceiptProvider, canonicalPoolAddress: pool, paycrestFetcher: fakePaycrest as typeof fetch })
  assert.equal(result.payout.chainStatus, 'succeeded')
  assert.equal(result.payout.providerStatus, 'expired')
  assert.equal(result.payout.displayStatus, 'reconciliation-required')
  assert.equal(result.payout.paidBeforeExpiry, true)
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

for (const scenario of [
  { name: 'unaccepted receipt', pending: true, timestamp: 1_700_000_000, expected: null },
  { name: 'on-time payment', timestamp: 1_700_000_000, expected: true },
  { name: 'payment at expiry', timestamp: 1_700_000_060, expected: true },
  { name: 'late payment', timestamp: 1_700_000_061, expected: false },
  { name: 'reverted transaction', timestamp: 1_700_000_000, reverted: true, expected: null },
  { name: 'wrong payment amount', timestamp: 1_700_000_000, wrongAmount: true, expected: null },
  { name: 'missing block timestamp', timestamp: undefined, expected: null },
  { name: 'null block timestamp', timestamp: null, expected: null },
  { name: 'out-of-range block timestamp', timestamp: Number.MAX_SAFE_INTEGER, expected: null },
  { name: 'block provider outage', timestamp: undefined, outage: true, expected: null },
]) {
  test(`payment timing evidence handles ${scenario.name}`, async () => {
    const address = `0x${randomUUID().replaceAll('-', '')}`
    const id = randomUUID()
    await store.recordBankPayoutOrder(address, {
      id, reference: `test-${id}`, status: 'initiated', amountNgn: '800', amountUsdc: '0.585222',
      receiveAddress, validUntil: new Date(1_700_000_060_000).toISOString(),
      accountName: 'TEST', bankLast4: '0000', institution: 'test',
    })
    await store.recordBankPayoutTransaction(address, id, { transactionHash: address })
    const result = await reconcileBankPayout(address, id, {
      canonicalPoolAddress: pool,
      paycrestFetcher: (async () => { throw new Error('Provider unavailable') }) as typeof fetch,
      receiptProvider: {
        getTransactionReceipt: async () => ({
          value: { execution_status: 'SUCCEEDED', finality_status: scenario.pending ? 'PRE_CONFIRMED' : 'ACCEPTED_ON_L2', block_number: 123, events: [{
            from_address: '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
            keys: [hash.getSelectorFromName('Transfer'), pool, receiveAddress],
            data: [scenario.wrongAmount ? '0x1' : '0x8ee06', '0x0'],
          }] },
          isError: () => false,
          isReverted: () => Boolean(scenario.reverted),
        }),
        getBlockWithTxHashes: async () => {
          if (scenario.outage) throw new Error('Block unavailable')
          return { block_number: 123, timestamp: scenario.timestamp }
        },
      },
    })
    assert.equal(result.payout.paidBeforeExpiry, scenario.expected)
    assert.equal(result.payout.chainStatus, scenario.pending ? 'not-checked' : scenario.reverted ? 'reverted' : scenario.wrongAmount ? 'unknown' : 'succeeded')
    const restored = (await store.getAccount(address)).bankPayouts[0]
    assert.equal(restored.paidBeforeExpiry, scenario.expected)
    if (scenario.timestamp === undefined || scenario.timestamp === null || scenario.timestamp === Number.MAX_SAFE_INTEGER) {
      assert.equal(restored.acceptedBlockTimestamp, '')
    }
  })
}


test('temporary RPC failures retain previously verified payment evidence', async () => {
  const payout = (await store.getAccount(refundAddress)).bankPayouts[0]
  const before = { block: payout.acceptedBlockNumber, time: payout.acceptedBlockTimestamp, paid: payout.paidBeforeExpiry }
  assert.equal(payout.chainStatus, 'succeeded')
  const absent = await reconcileBankPayout(refundAddress, payout.id, {
    paycrestFetcher: (async () => { throw new Error('Offline') }) as typeof fetch,
    receiptProvider: { getTransactionReceipt: async () => { throw new Error('Transaction hash not found code 29') } },
  })
  assert.equal(absent.chainPending, true)
  assert.equal(absent.payout.chainStatus, 'succeeded')
  const refreshed = await store.recordBankPayoutChainEvidence(refundAddress, payout.id, {
    status: 'succeeded', acceptedBlockNumber: before.block, message: 'Exact payment verified; block timestamp temporarily unavailable.',
  })
  assert.equal(refreshed.acceptedBlockTimestamp, before.time)
  assert.equal(refreshed.paidBeforeExpiry, before.paid)
})
