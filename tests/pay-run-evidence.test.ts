import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataFile = join(tmpdir(), `kudiroll-evidence-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = dataFile
const store = await import('../src/server/account-store')
const { createPayRunEvidenceBundle } = await import('../src/server/pay-run-evidence')

test.after(async () => { await rm(dataFile, { force: true }) })

test('exports a sanitized private-payroll evidence bundle with explicit proof limits', async () => {
  const owner = '0xe01'
  const team = await store.createTeam(owner, { name: 'Confidential Operations' })
  const worker = await store.addWorker(owner, team.id, { name: 'Hidden Worker', walletAddress: '0xe02', defaultAmountUsdc: '1.25' })
  const run = await store.createPayRun(owner, { teamId: team.id, settlementMode: 'private', items: [{ workerId: worker.id, amountUsdc: '1.25' }] })
  const account = await store.getAccount(owner)
  const evidence = createPayRunEvidenceBundle(account, run, '2026-09-05T10:00:00.000Z', '0xabc')
  const serialized = JSON.stringify(evidence)

  assert.equal(evidence.payroll.route, 'strk20-private-transfer')
  assert.equal(evidence.transaction.poolInteractionVerified, false)
  assert.match(evidence.verification.limitation, /does not reveal or independently prove/i)
  assert.equal(evidence.audit.completeChainIntegrityVerified, true)
  assert.equal(evidence.integrity.signed, false)
  assert.equal(serialized.includes('Hidden Worker'), false)
  assert.equal(serialized.includes('Confidential Operations'), false)
  assert.equal(serialized.includes('0xe02'), false)
  assert.equal(serialized.includes('1.25'), false)
})

test('labels the compatibility payout as public and never as private evidence', async () => {
  const owner = '0xe11'
  const team = await store.createTeam(owner, { name: 'Public Team' })
  const worker = await store.addWorker(owner, team.id, { name: 'Public Worker', walletAddress: '0xe12', defaultAmountUsdc: '2' })
  const run = await store.createPayRun(owner, { teamId: team.id, settlementMode: 'public-wallet', items: [{ workerId: worker.id, amountUsdc: '2' }] })
  const evidence = createPayRunEvidenceBundle(await store.getAccount(owner), run, '2026-09-05T10:00:00.000Z', '0xabc')

  assert.equal(evidence.payroll.route, 'strk20-public-withdrawal')
  assert.equal(evidence.privacy.privateRoute, false)
  assert.match(evidence.verification.limitation, /compatibility route is public/i)
})

test('legacy runs use the same private-route default as the execution manifest', async () => {
  const owner = '0xe21'
  const team = await store.createTeam(owner, { name: 'Legacy Team' })
  const worker = await store.addWorker(owner, team.id, { name: 'Legacy Worker', walletAddress: '0xe22', defaultAmountUsdc: '1' })
  const run = await store.createPayRun(owner, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] })
  const legacy = { ...run, settlementMode: undefined } as unknown as typeof run
  const evidence = createPayRunEvidenceBundle(await store.getAccount(owner), legacy)
  assert.equal(evidence.payroll.settlementMode, 'private')
  assert.equal(evidence.payroll.route, 'strk20-private-transfer')
})


test('export uses recorded pool evidence and never infers it from prose or current configuration', async () => {
  const owner = '0xe31'
  const team = await store.createTeam(owner, { name: 'Evidence Review' })
  const worker = await store.addWorker(owner, team.id, { name: 'Private Worker', walletAddress: '0xe32', defaultAmountUsdc: '1' })
  const run = await store.createPayRun(owner, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] })
  await store.updatePayRun(owner, run.id, { status: 'prepared' })
  await store.updatePayRun(owner, run.id, { status: 'submitting', expectedPolicyVersion: 0 })
  await store.updatePayRun(owner, run.id, { status: 'submitted', transactionHash: '0xe33' })
  const historical = await store.recordPayRunFinality(owner, run.id, { status: 'finalized', acceptedBlockNumber: 42, message: 'An event from the configured STRK20 pool.' })
  assert.equal(createPayRunEvidenceBundle(await store.getAccount(owner), historical).transaction.poolInteractionVerified, false)
  const recorded = await store.recordPayRunFinality(owner, run.id, { status: 'finalized', acceptedBlockNumber: 42, verifiedPoolAddress: '0xabc', message: 'Receipt checked.' })
  const evidence = createPayRunEvidenceBundle(await store.getAccount(owner), recorded, '2026-09-05T10:00:00.000Z', '0xdef')
  assert.equal(evidence.transaction.poolInteractionVerified, true)
  assert.equal(evidence.transaction.verifiedPoolAddress, '0xabc')
  assert.equal(evidence.transaction.configuredPoolAddress, '0xdef')
})
