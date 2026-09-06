import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inPaymentWorkspace, paymentWorkspace } from '../src/payment-workspace'

const file = join(tmpdir(), `enterprise-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = file
const store = await import('../src/server/account-store')
const { createPayRunExecutionManifest } = await import('../src/server/pay-run-manifest')
test.after(async () => { await rm(file, { force: true }) })

test('legacy records remain standard; unknown scopes fail closed', () => {
  assert.equal(inPaymentWorkspace({}, 'standard'), true)
  assert.equal(inPaymentWorkspace({}, 'enterprise'), false)
  assert.throws(() => paymentWorkspace('other'), /Unknown payment workspace/)
})

test('same team name can exist independently; edits cannot move teams between workspaces', async () => {
  const owner = '0xe01'
  const ordinary = await store.createTeam(owner, { name: 'Operations' })
  const enterprise = await store.createTeam(owner, { name: 'Operations', workspace: 'enterprise' })
  assert.notEqual(ordinary.id, enterprise.id)
  await store.updateTeam(owner, enterprise.id, { name: 'Operations', workspace: 'standard' })
  assert.equal((await store.getAccount(owner)).teams.find(t => t.id === enterprise.id)?.workspace, 'enterprise')
  await assert.rejects(store.createTeam(owner, { name: 'Operations', workspace: 'enterprise' }), /already exists/)
  await assert.rejects(store.createTeam(owner, { name: 'Invalid', workspace: 'other' }), /Unknown payment workspace/)
})

test('Enterprise is private-only, cannot borrow standard teams, and stays wallet-isolated', async () => {
  const owner = '0xe02'
  const team = await store.createTeam(owner, { name: 'Enterprise team', workspace: 'enterprise' })
  const worker = await store.addWorker(owner, team.id, { name: 'Recipient', walletAddress: '0xe03', defaultAmountUsdc: '1' })
  const input = { teamId: team.id, workspace: 'enterprise', settlementMode: 'private', items: [{ workerId: worker.id, amountUsdc: '1' }] }
  await assert.rejects(store.createPayRun(owner, { ...input, settlementMode: 'public-wallet' }), /requires private transfers/)
  await assert.rejects(store.createPayRun(owner, { ...input, workspace: 'standard' }), /different workspace/)
  await assert.rejects(store.createPayRun('0xe04', input), /Select a saved team/)
  const standard = await store.createTeam(owner, { name: 'Ordinary team' })
  await assert.rejects(store.createPayRun(owner, { ...input, teamId: standard.id }), /different workspace/)
  const run = await store.createPayRun(owner, input, 'enterprise-scope-idempotency')
  assert.equal(run.workspace, 'enterprise')
  const { createPayRunEvidenceBundle } = await import('../src/server/pay-run-evidence')
  assert.equal(createPayRunEvidenceBundle(await store.getAccount(owner), run).payroll.workspace, 'enterprise')
  const manifest = createPayRunExecutionManifest(run)
  assert.equal(manifest.workspace, 'enterprise')
  assert.equal(manifest.actions.every(a => a.kind === 'private-transfer'), true)
  assert.equal((await store.createPayRun(owner, input, 'enterprise-scope-idempotency')).id, run.id)
  await assert.rejects(store.createPayRun(owner, { ...input, workspace: 'standard' }, 'enterprise-scope-idempotency'), /different pay run/)
  assert.notEqual(manifest.snapshotHash, createPayRunExecutionManifest({ ...run, workspace: 'standard' }).snapshotHash)
  const { workspace: ignored, ...legacy } = run
  assert.equal(createPayRunExecutionManifest(legacy).snapshotHash, createPayRunExecutionManifest({ ...run, workspace: 'standard' }).snapshotHash)
})

test('unknown Enterprise submissions still block new payroll in the standard workspace', async () => {
  const owner = '0xe05'
  const team = await store.createTeam(owner, { name: 'Private team', workspace: 'enterprise' })
  const worker = await store.addWorker(owner, team.id, { name: 'Recipient', walletAddress: '0xe06', defaultAmountUsdc: '1' })
  const run = await store.createPayRun(owner, { workspace: 'enterprise', teamId: team.id, settlementMode: 'private', items: [{ workerId: worker.id, amountUsdc: '1' }] })
  await store.updatePayRun(owner, run.id, { status: 'prepared' })
  await store.updatePayRun(owner, run.id, { status: 'submitting', expectedPolicyVersion: 0 })
  await store.updatePayRun(owner, run.id, { status: 'unknown' })
  const ordinary = await store.createTeam(owner, { name: 'Standard team' })
  await assert.rejects(store.createPayRun(owner, { teamId: ordinary.id, items: [] }), /unknown payroll submission/)
})


test('bank orders retain their workspace on replay and block another workspace until resolved', async () => {
  const owner = '0xe07'
  const order = { id: 'enterprise-bank-order-1', reference: 'enterprise-fixture', amountNgn: '1000', amountUsdc: '1', receiveAddress: '0xe08', accountName: 'Synthetic Account', bankLast4: '1234', validUntil: new Date(Date.now() + 3600000).toISOString(), workspace: 'enterprise' }
  const first = await store.recordBankPayoutOrder(owner, order)
  assert.equal(first.workspace, 'enterprise')
  const replay = await store.recordBankPayoutOrder(owner, { ...order, workspace: 'standard' })
  assert.equal(replay.workspace, 'enterprise')
  assert.equal((await store.getAccount('0xe09')).bankPayouts.length, 0)
  await assert.rejects(store.recordBankPayoutOrder(owner, { ...order, id: 'standard-bank-order-2', workspace: 'standard' }), /Resolve the existing bank payout/)
  await assert.rejects(store.assertCanCreateBankPayout(owner), /Resolve the existing bank payout/)
})


test('pre-existing drafts cannot bypass an unresolved submission across workspaces', async () => {
  const owner = '0xea01'
  const team = await store.createTeam(owner, { name: 'Concurrent drafts' })
  const worker = await store.addWorker(owner, team.id, { name: 'Recipient', walletAddress: '0xea02', defaultAmountUsdc: '1' })
  const input = { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] }
  const first = await store.createPayRun(owner, input)
  const second = await store.createPayRun(owner, input)
  await store.updatePayRun(owner, first.id, { status: 'prepared' })
  await store.updatePayRun(owner, second.id, { status: 'prepared' })
  await store.updatePayRun(owner, first.id, { status: 'submitting', expectedPolicyVersion: 0 })
  await assert.rejects(store.updatePayRun(owner, second.id, { status: 'submitting', expectedPolicyVersion: 0 }), /unknown payroll submission/)
  await store.updatePayRun(owner, first.id, { status: 'submitted', transactionHash: '0xabc' })
  await store.updatePayRun(owner, second.id, { status: 'submitting', expectedPolicyVersion: 0 })
  await assert.rejects(store.updatePayRun(owner, second.id, { status: 'submitted', transactionHash: '0x0abc' }), /already attached/)
})
