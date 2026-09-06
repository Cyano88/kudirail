import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const file = join(tmpdir(), `funding-recovery-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = file
const store = await import('../src/server/account-store')
test.after(async () => { await rm(file, { force: true }) })

test('only one concurrent funding attempt persists and survives account reload', async () => {
  const owner = '0xfb01'
  const results = await Promise.allSettled([store.beginTreasuryFunding(owner, { amountUsdc: '1' }), store.beginTreasuryFunding(owner, { amountUsdc: '2' })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const attempt = (await store.getAccount(owner)).fundingAttempt!
  assert.ok(attempt.id)
  await assert.rejects(store.recordTreasuryShield(owner, { amountUsdc: attempt.amountUsdc, transactionHash: '0xabc', attemptId: 'stale' }), /match the active attempt/)
  await assert.rejects(store.resolveTreasuryFunding(owner, { attemptId: attempt.id, confirmation: 'NO' }), /NO DEPOSIT IN READY/)
  assert.equal((await store.getAccount(owner)).fundingAttempt?.id, attempt.id)
  await store.recordTreasuryShield(owner, { amountUsdc: attempt.amountUsdc, transactionHash: '0xabc', attemptId: attempt.id })
  assert.equal((await store.getAccount(owner)).fundingAttempt, null)
  assert.equal((await store.recordTreasuryShield(owner, { amountUsdc: attempt.amountUsdc, transactionHash: '0x0abc', attemptId: attempt.id })).transactionHash, '0xabc')
  const next = await store.beginTreasuryFunding(owner, { amountUsdc: '1' })
  await assert.rejects(store.recordTreasuryShield(owner, { amountUsdc: next.amountUsdc, transactionHash: '0x0abc', attemptId: next.id }), /predates/)
  await assert.rejects(store.resolveTreasuryFunding(owner, { attemptId: attempt.id, confirmation: 'NO DEPOSIT IN READY' }), /changed/)
  await store.resolveTreasuryFunding(owner, { attemptId: next.id, confirmation: 'NO DEPOSIT IN READY' })
  assert.equal((await store.getAccount(owner)).fundingAttempt, null)
  assert.equal((await store.getAccount('0xfb02')).fundingAttempt, undefined)
})
