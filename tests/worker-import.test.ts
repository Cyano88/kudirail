import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { canonicalWorkerAddress, validateWorkerRows } from '../src/worker-import'
const file = join(tmpdir(), `worker-import-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = file
process.env.KUDIRAIL_DATA_FILE = file
const store = await import('../src/server/account-store')
test.after(async () => { await rm(file, { force: true }) })
const worker = (walletAddress: string) => ({ name: 'Test Worker', walletAddress, defaultAmountUsdc: '1.25' })
test('wallet identity handles padding and case; invalid address bounds and amounts are rejected', () => {
 assert.equal(canonicalWorkerAddress('0x000AbC'), '0xabc')
 assert.throws(() => canonicalWorkerAddress('0x0'))
 assert.throws(() => canonicalWorkerAddress('0x' + 'f'.repeat(64)))
 assert.equal(validateWorkerRows([worker('0xabc'), worker('0x00ABC')])[1].length, 1)
 assert.ok(validateWorkerRows([{ ...worker('0xabc'), defaultAmountUsdc: '1.1234567' }])[0].length)
})
test('bulk save is atomic, team scoped, and concurrent or padded duplicates cannot add workers twice', async () => {
 const owner = '0xc501'
 const team = await store.createTeam(owner, { name: 'CSV team', workspace: 'enterprise' })
 await assert.rejects(store.addWorkers(owner, team.id, [worker('0xabc'), worker('0x0abc')]), /already/)
 assert.equal((await store.getAccount(owner)).teams[0].workers.length, 0)
 await assert.rejects(store.addWorkers(owner, team.id, [worker('0xabc'), { ...worker('0xdef'), defaultAmountUsdc: '0' }]), /positive/)
 assert.equal((await store.getAccount(owner)).teams[0].workers.length, 0)
 await assert.rejects(store.addWorkers('0xc502', team.id, [worker('0xabc')]), /Team not found/)
 const outcomes = await Promise.allSettled([store.addWorkers(owner, team.id, [worker('0xabc')]), store.addWorkers(owner, team.id, [worker('0x00abc')])])
 assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
 await assert.rejects(store.addWorker(owner, team.id, worker('0x000abc')), /already/)
 const saved = (await store.getAccount(owner)).teams[0]
 assert.equal(saved.workers.length, 1)
 assert.equal(saved.workspace, 'enterprise')
 const personal = await store.createTeam(owner, { name: 'CSV team' })
 await store.addWorkers(owner, personal.id, [worker('0xabc')])
 await assert.rejects(store.addWorkers(owner, personal.id, Array.from({ length: 101 }, () => worker('0xdef'))), /100/)
})
