import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPhase0PaycrestOrder,
  listPaycrestOrders,
  paycrestConfiguration,
} from '../src/server/paycrest'

const addressA = `0x${'a'.repeat(64)}`
const addressB = `0x${'b'.repeat(64)}`

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

test('only reports live Paycrest orders when both the key and gate are configured', () => {
  const previous = { PAYCREST_API_KEY: process.env.PAYCREST_API_KEY, PHASE0_LIVE_ORDER_ENABLED: process.env.PHASE0_LIVE_ORDER_ENABLED }
  try {
    delete process.env.PAYCREST_API_KEY
    process.env.PHASE0_LIVE_ORDER_ENABLED = 'true'
    assert.deepEqual(paycrestConfiguration(), { apiConfigured: false, liveOrdersRequested: true, liveOrdersEnabled: false, maximumNgn: 5000 })
    process.env.PAYCREST_API_KEY = 'test-key'
    assert.equal(paycrestConfiguration().liveOrdersEnabled, true)
  } finally {
    restoreEnvironment(previous)
  }
})

test('normalizes the session address before filtering Paycrest order history', async () => {
  const previous = { PAYCREST_API_KEY: process.env.PAYCREST_API_KEY }
  process.env.PAYCREST_API_KEY = 'test-key'
  const fakeFetch = async () => new Response(JSON.stringify({ data: { items: [{
    id: 'order-1', reference: 'kudiroll-live-1', amount: '1', rate: '1000',
    source: { currency: 'USDC', network: 'starknet', refundAddress: addressA },
    destination: { currency: 'NGN', recipient: { accountIdentifier: '0123456789' } },
  }] } }), { status: 200 })
  try {
    const orders = await listPaycrestOrders(`0x${'a'.repeat(64).toUpperCase()}`, fakeFetch as typeof fetch)
    assert.equal(orders.length, 1)
    assert.equal(orders[0].bankLast4, '6789')
  } finally {
    restoreEnvironment(previous)
  }
})

test('creates only a future Starknet order with an exact USDC amount', async () => {
  const previous = {
    PAYCREST_API_KEY: process.env.PAYCREST_API_KEY,
    PHASE0_LIVE_ORDER_ENABLED: process.env.PHASE0_LIVE_ORDER_ENABLED,
    PHASE0_MAX_NGN: process.env.PHASE0_MAX_NGN,
  }
  process.env.PAYCREST_API_KEY = 'test-key'
  process.env.PHASE0_LIVE_ORDER_ENABLED = 'true'
  process.env.PHASE0_MAX_NGN = '3000'
  const calls: Array<{ url: string; body: any }> = []
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.endsWith('/v2/verify-account')) return new Response(JSON.stringify({ data: { accountName: 'TEST RECIPIENT' } }), { status: 200 })
    return new Response(JSON.stringify({ data: {
      id: 'order-1', status: 'initiated', amountToPay: '0.750001',
      providerAccount: { network: 'starknet', receiveAddress: addressB, validUntil: new Date(Date.now() + 60_000).toISOString() },
    } }), { status: 200 })
  }
  try {
    const order = await createPhase0PaycrestOrder({
      amountNgn: '1000', institution: '058', accountIdentifier: '0123456789',
      refundAddress: '0xabc',
    }, fakeFetch as typeof fetch)
    assert.equal(order.amountUsdc, '0.750001')
    assert.equal(order.receiveAddress, addressB)
    assert.equal(calls[1].body.source.refundAddress, `0x${'0'.repeat(61)}abc`)
  } finally {
    restoreEnvironment(previous)
  }
})

test('rejects a Paycrest provider account on the wrong network', async () => {
  const previous = { PAYCREST_API_KEY: process.env.PAYCREST_API_KEY, PHASE0_LIVE_ORDER_ENABLED: process.env.PHASE0_LIVE_ORDER_ENABLED }
  process.env.PAYCREST_API_KEY = 'test-key'
  process.env.PHASE0_LIVE_ORDER_ENABLED = 'true'
  const fakeFetch = async (input: string | URL | Request) => String(input).endsWith('/v2/verify-account')
    ? new Response(JSON.stringify({ data: { accountName: 'TEST RECIPIENT' } }), { status: 200 })
    : new Response(JSON.stringify({ data: {
      id: 'order-1', amountToPay: '1', providerAccount: { network: 'base', receiveAddress: addressB, validUntil: new Date(Date.now() + 60_000).toISOString() },
    } }), { status: 200 })
  try {
    await assert.rejects(createPhase0PaycrestOrder({
      amountNgn: '1000', institution: '058', accountIdentifier: '0123456789', refundAddress: addressA,
    }, fakeFetch as typeof fetch), /wrong network/)
  } finally {
    restoreEnvironment(previous)
  }
})
