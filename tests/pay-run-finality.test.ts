import assert from 'node:assert/strict'
import test from 'node:test'
import { receiptTouchesPool, sameStarknetFelt } from '../src/pay-run-finality'

test('matches configured STRK20 pool events by felt value, not string padding', () => {
  assert.equal(sameStarknetFelt('0x01', '0x1'), true)
  assert.equal(receiptTouchesPool([{ from_address: '0xabc' }, { from_address: '0x01' }], '0x1'), true)
  assert.equal(receiptTouchesPool([{ from_address: '0xabc' }], '0x1'), false)
  assert.equal(receiptTouchesPool([{ from_address: 'malformed' }], '0x1'), false)
})
