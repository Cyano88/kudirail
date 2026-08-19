import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataFile = join(tmpdir(), `kudiroll-finality-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = dataFile
const store = await import('../src/server/account-store')
const { verifyPayRunFinality } = await import('../src/server/pay-run-finality-service')

test.after(async () => { await rm(dataFile, { force: true }) })

async function submittedRun(address: string, suffix: string) {
  const team = await store.createTeam(address, { name: `Finality ${suffix}` })
  const worker = await store.addWorker(address, team.id, { name: `Worker ${suffix}`, walletAddress: `0x${suffix}1`, defaultAmountUsdc: '1' })
  const run = await store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] })
  await store.updatePayRun(address, run.id, { status: 'prepared' })
  await store.updatePayRun(address, run.id, { status: 'submitting' })
  return store.updatePayRun(address, run.id, { status: 'submitted', transactionHash: `0x${suffix}2` })
}

test('finality service verifies a successful receipt only when the configured pool emitted an event', async () => {
  const address = '0xfa1'
  const run = await submittedRun(address, 'a1')
  const result = await verifyPayRunFinality(address, run.id, {
    poolAddress: '0xabc',
    provider: { getTransactionReceipt: async () => ({ value: { block_number: 77, events: [{ from_address: '0x0abc' }] }, isError: () => false, isReverted: () => false }) },
  })
  assert.equal(result.payRun?.status, 'finalized')
  assert.equal(result.payRun?.acceptedBlockNumber, 77)
})

test('finality service keeps an unavailable transaction pending without mutating the pay run', async () => {
  const address = '0xfa2'
  const run = await submittedRun(address, 'b1')
  const result = await verifyPayRunFinality(address, run.id, {
    poolAddress: '0xabc',
    provider: { getTransactionReceipt: async () => { throw new Error('Transaction hash not found code 29') } },
  })
  assert.equal(result.pending, true)
  assert.equal((await store.getAccount(address)).payRuns[0].status, 'submitted')
})
