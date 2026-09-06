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
    const stale = await fetch(`http://127.0.0.1:${port}/api/v1/pay-runs`, {
      method: 'POST', headers: { Cookie: `kudiroll_session=${token}`, 'Content-Type': 'application/json', 'X-KudiRoll-Account': '0xc99' }, body: JSON.stringify(request),
    })
    assert.equal(stale.status, 409)
    assert.equal((await store.getAccount(address)).payRuns.length, 0)
    const firstResponse = await send()
    assert.equal(firstResponse.status, 201)
    const first = await firstResponse.json()
    assert.equal(first.executionManifest.signing.serverCanSubmit, false)
    assert.equal(JSON.stringify(first.executionManifest).includes('Hidden Worker Name'), false)
    const evidenceResponse = await fetch(`http://127.0.0.1:${port}/api/v1/pay-runs/${first.payRun.id}/evidence`, { headers: { Cookie: `kudiroll_session=${token}` } })
    assert.equal(evidenceResponse.status, 200)
    assert.match(evidenceResponse.headers.get('content-disposition') || '', /attachment/)
    const evidence = await evidenceResponse.json()
    assert.equal(evidence.payroll.route, 'strk20-public-withdrawal')
    assert.equal(JSON.stringify(evidence).includes('Hidden Worker Name'), false)
    assert.equal(JSON.stringify(evidence).includes('0xc02'), false)
    const evidenceUrl = `http://127.0.0.1:${port}/api/v1/pay-runs/${first.payRun.id}/evidence`
    assert.equal((await fetch(evidenceUrl)).status, 401)
    const otherToken = await auth.createAuthSession('0xc99', 'passkey', 'other-account')
    assert.equal((await fetch(evidenceUrl, { headers: { Cookie: `kudiroll_session=${otherToken}` } })).status, 404)
    assert.match(evidenceResponse.headers.get('cache-control') || '', /no-store/)
    const replay = await (await send()).json()
    assert.equal(replay.payRun.id, first.payRun.id)
    assert.equal((await store.getAccount(address)).payRuns.length, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})


test('funding recovery requires authentication and the matching attempt', async () => {
  const { createAccountRouter } = await import('../src/server/account-router')
  const owner = '0xf901'
  const token = await auth.createAuthSession(owner, 'wallet', '')
  const app = express(); app.use(express.json()); app.use('/api/account', createAccountRouter())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const post = (path: string, body: any, authenticated = true) => fetch(`${origin}/api/account${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `kudiroll_session=${token}`, 'X-KudiRoll-Account': owner } : {}) }, body: JSON.stringify(body) })
  try {
    const begun = await post('/treasury/funding-attempt', { amountUsdc: '1' })
    assert.equal(begun.status, 201)
    const { attempt } = await begun.json()
    const recovery = { attemptId: attempt.id, confirmation: 'NO DEPOSIT IN READY' }
    assert.equal((await post('/treasury/funding-attempt/resolve', recovery, false)).status, 401)
    assert.equal((await store.getAccount(owner)).fundingAttempt?.id, attempt.id)
    assert.equal((await post('/treasury/funding-attempt/resolve', { ...recovery, attemptId: 'stale' })).status, 409)
    assert.equal((await post('/treasury/funding-attempt/resolve', recovery)).status, 200)
    assert.equal((await store.getAccount(owner)).fundingAttempt, null)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
