import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataFile = join(tmpdir(), `kudiroll-rail-http-${randomUUID()}.json`)
const authFile = join(tmpdir(), `kudiroll-rail-http-auth-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = dataFile
process.env.KUDIROLL_AUTH_FILE = authFile
process.env.NODE_ENV = 'test'

const express = (await import('express')).default
const store = await import('../src/server/account-store')
const auth = await import('../src/server/auth-store')
const { createRailRouter } = await import('../src/server/rail-router')

test.after(async () => { await Promise.all([rm(dataFile, { force: true }), rm(authFile, { force: true })]) })

test('authenticated HTTP rail contract creates and replays a private-payroll intent', async () => {
  const address = '0xc01'
  const team = await store.createTeam(address, { name: 'HTTP contract team' })
  const worker = await store.addWorker(address, team.id, { name: 'Hidden Worker Name', walletAddress: '0xc02', defaultAmountUsdc: '1.75' })
  const token = await auth.createAuthSession(address, 'passkey', 'contract-test-passkey')
  const app = express()
  app.use(express.json())
  app.use('/api/v1', createRailRouter())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  try {
    const port = (server.address() as { port: number }).port
    const capabilities = await fetch(`http://127.0.0.1:${port}/api/v1`)
    assert.equal(capabilities.status, 200)
    const capabilityBody = await capabilities.json()
    assert.equal(capabilityBody.custody, 'client')
    assert.equal(capabilityBody.payRunManifestVersion, '2')
    assert.deepEqual(capabilityBody.settlementModes, ['public-wallet', 'private'])
    const request = { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1.75' }] }
    const send = () => fetch(`http://127.0.0.1:${port}/api/v1/pay-runs`, {
      method: 'POST',
      headers: { Cookie: `kudiroll_session=${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-contract-key-0001' },
      body: JSON.stringify(request),
    })
    const firstResponse = await send()
    assert.equal(firstResponse.status, 201)
    const first = await firstResponse.json()
    assert.equal(first.executionManifest.signing.serverCanSubmit, false)
    assert.equal(JSON.stringify(first.executionManifest).includes('Hidden Worker Name'), false)
    const replay = await (await send()).json()
    assert.equal(replay.payRun.id, first.payRun.id)
    assert.equal((await store.getAccount(address)).payRuns.length, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
