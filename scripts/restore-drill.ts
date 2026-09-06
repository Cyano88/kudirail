import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { databasePool, persistenceConfig } from '../src/server/database'
import * as store from '../src/server/account-store'
import * as auth from '../src/server/auth-store'
import { decryptAccountRecord } from '../src/server/account-postgres-store'

const mode = process.argv[2]
const target = new URL(process.env.KUDIROLL_DATABASE_URL || 'http://invalid')
const expectedDatabase = mode === 'seed' ? '/kudiroll_restore_source' : '/kudiroll_restore_target'
if (!['seed', 'verify'].includes(mode) || process.env.CI !== 'true' || process.env.NODE_ENV !== 'test' || target.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== expectedDatabase) throw new Error('Restore drill only runs against its explicitly named local CI databases.')
assert.equal(persistenceConfig().accountBackend, 'postgres')
assert.equal(persistenceConfig().authBackend, 'postgres')
const pool = databasePool()
const owner = '0xd701'
const other = '0xd702'
const expectedPath = 'output/restore-drill/expected.json'
try {
 if (mode === 'seed') {
  assert.equal(Number((await pool.query('select count(*) as count from kudiroll_accounts')).rows[0].count), 0)
  const personal = await store.createTeam(owner, { name: 'Synthetic personal', workspace: 'standard' })
  const enterprise = await store.createTeam(owner, { name: 'Synthetic enterprise', workspace: 'enterprise' })
  const p = await store.addWorker(owner, personal.id, { name: 'Synthetic Personal Worker', walletAddress: '0xd711', defaultAmountUsdc: '0.1' })
  const e = await store.addWorker(owner, enterprise.id, { name: 'Synthetic Enterprise Worker', walletAddress: '0xd712', defaultAmountUsdc: '0.2' })
  await store.createPayRun(owner, { teamId: personal.id, items: [{ workerId: p.id, amountUsdc: '0.1' }] })
  const run = await store.createPayRun(owner, { teamId: enterprise.id, workspace: 'enterprise', settlementMode: 'private', items: [{ workerId: e.id, amountUsdc: '0.2' }] })
  await store.updatePayRun(owner, run.id, { status: 'prepared' })
  await store.updatePayRun(owner, run.id, { status: 'submitting', expectedPolicyVersion: 0 })
  await store.updatePayRun(owner, run.id, { status: 'submitted', transactionHash: '0xd799' })
  await store.beginTreasuryFunding(owner, { amountUsdc: '1' })
  await store.beginBankOrderCreation(owner, 'enterprise')
  await store.createTeam(other, { name: 'Other synthetic tenant' })
  const token = await auth.createAuthSession(owner, 'passkey', 'synthetic-credential')
  const revoked = await auth.createAuthSession(owner, 'passkey', 'synthetic-revoked')
  await auth.deleteAuthSession(revoked)
  const accounts = [await store.getAccount(owner), await store.getAccount(other)]
  const rows = (await pool.query('select record from kudiroll_accounts')).rows
  assert.ok(!JSON.stringify(rows).includes('Synthetic Enterprise Worker'))
  const sessionRows = (await pool.query('select token_hash from kudiroll_auth_sessions')).rows
  assert.ok(!JSON.stringify(sessionRows).includes(token))
  await mkdir('output/restore-drill', { recursive: true })
  await writeFile(expectedPath, JSON.stringify({ accounts, token, revoked }), { mode: 0o600 })
  console.log('Synthetic PostgreSQL source seeded: two tenants, scoped teams, draft/history, pending recovery and hashed sessions.')
 } else {
  const expected = JSON.parse(await readFile(expectedPath, 'utf8'))
  assert.deepEqual([await store.getAccount(owner), await store.getAccount(other)], expected.accounts)
  assert.equal((await auth.getAuthSession(expected.token))?.address, owner)
  assert.equal(await auth.getAuthSession(expected.revoked), null)
  assert.ok(store.verifyTreasuryAuditChain((await store.getAccount(owner)).treasuryAudit))
  const row = (await pool.query('select record from kudiroll_accounts where wallet_address = $1', [owner])).rows[0]
  assert.throws(() => decryptAccountRecord(other, row.record))
  const key = process.env.KUDIROLL_DATA_ENCRYPTION_KEY
  try { process.env.KUDIROLL_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64url'); assert.throws(() => decryptAccountRecord(owner, row.record)) } finally { process.env.KUDIROLL_DATA_ENCRYPTION_KEY = key }
  await auth.deleteAuthSession(expected.token)
  assert.equal(await auth.getAuthSession(expected.token), null)
  const account = await store.getAccount(owner)
  const team = account.teams.find(item => item.workspace === 'enterprise')!
  const imported = await store.addWorkers(owner, team.id, [{ name: 'After Restore Worker', walletAddress: '0xd713', defaultAmountUsdc: '0.1' }])
  assert.equal(imported.length, 1)
  assert.equal((await store.getAccount(other)).teams.length, 1)
  console.log('PASS: dump/restore preserves encrypted accounts, workspace records, drafts, transaction history, audit integrity, recovery attempts and session revocation. Restored writes and tenant/key isolation verified.')
 }
} finally { await pool.end() }
