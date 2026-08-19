import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTreasuryReadiness, SHIELD_MATURITY_BLOCKS } from '../src/treasury-readiness'

const shield = { transactionHash: '0x123', amountUsdc: '1', submittedAt: '2026-08-15T00:00:00.000Z' }
const checkedAt = '2026-08-15T00:01:00.000Z'

test('requires ten blocks after the accepted shield block', () => {
  const maturing = deriveTreasuryReadiness(shield, { outcome: 'succeeded', acceptedBlockNumber: 100, currentBlockNumber: 109 }, checkedAt)
  assert.equal(maturing.status, 'maturing')
  assert.equal(maturing.blocksRemaining, 1)
  const ready = deriveTreasuryReadiness(shield, { outcome: 'succeeded', acceptedBlockNumber: 100, currentBlockNumber: 110 }, checkedAt)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.confirmations, SHIELD_MATURITY_BLOCKS)
})

test('keeps submitted, reverted, and unknown finality states distinct', () => {
  assert.equal(deriveTreasuryReadiness(shield, { outcome: 'pending' }, checkedAt).status, 'submitted')
  assert.equal(deriveTreasuryReadiness(shield, { outcome: 'reverted' }, checkedAt).status, 'reverted')
  assert.equal(deriveTreasuryReadiness(shield, { outcome: 'unknown' }, checkedAt).status, 'unknown')
})

test('represents an account with no tracked shield without inventing chain evidence', () => {
  const result = deriveTreasuryReadiness(null, { outcome: 'pending' }, checkedAt)
  assert.equal(result.status, 'none')
  assert.equal(result.shield, null)
})
