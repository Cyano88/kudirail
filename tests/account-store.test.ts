import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataFile = join(tmpdir(), `kudiroll-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = dataFile
const store = await import('../src/server/account-store')
const owner = '0x123'
const PRF_ONE = Buffer.alloc(32, 1).toString('base64url')
const PRF_TWO = Buffer.alloc(32, 2).toString('base64url')
const PRF_THREE = Buffer.alloc(32, 3).toString('base64url')

test.after(async () => { await rm(dataFile, { force: true }) })

test('persists teams, workers, and immutable pay-run snapshots per wallet account', async () => {
  const team = await store.createTeam(owner, { name: 'Lagos operations', description: 'Weekly team' })
  const worker = await store.addWorker(owner, team.id, { name: 'Ada Okafor', walletAddress: '0x456', defaultAmountUsdc: '1.25' })
  const run = await store.createPayRun(owner, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1.5' }] })
  await store.removeWorker(owner, team.id, worker.id)
  const account = await store.getAccount(owner)
  assert.equal(account.teams[0].workers.length, 0)
  assert.equal(account.payRuns[0].items[0].workerName, 'Ada Okafor')
  assert.equal(account.payRuns[0].totalUsdc, '1.5')
  assert.equal(run.status, 'draft')
})

test('keeps different wallet accounts isolated', async () => {
  await store.createTeam('0x999', { name: 'Another company' })
  assert.equal((await store.getAccount(owner)).teams.some(team => team.name === 'Another company'), false)
})

test('rejects duplicate workers in the same pay run', async () => {
  const team = await store.createTeam(owner, { name: 'Abuja support' })
  const worker = await store.addWorker(owner, team.id, { name: 'Musa Bello', walletAddress: '0x789', defaultAmountUsdc: '2' })
  await assert.rejects(
    store.createPayRun(owner, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }, { workerId: worker.id, amountUsdc: '1' }] }),
    /only once/,
  )
})

test('replays identical pay-run creation idempotently and rejects payload drift', async () => {
  const address = '0x1de'
  const team = await store.createTeam(address, { name: 'Idempotent team' })
  const worker = await store.addWorker(address, team.id, { name: 'Stable Worker', walletAddress: '0x1df', defaultAmountUsdc: '3' })
  const request = { teamId: team.id, clientReference: 'payroll-august', items: [{ workerId: worker.id, amountUsdc: '3' }] }
  const first = await store.createPayRun(address, request, 'idempotency-key-0001')
  const replay = await store.createPayRun(address, request, 'idempotency-key-0001')
  assert.equal(replay.id, first.id)
  assert.equal((await store.getAccount(address)).payRuns.length, 1)
  await assert.rejects(store.createPayRun(address, { ...request, items: [{ workerId: worker.id, amountUsdc: '4' }] }, 'idempotency-key-0001'), /different pay run/)
  assert.equal('idempotencyKeyHash' in store.publicPayRun(first), false)
  assert.equal('requestHash' in store.publicPayRun(first), false)
})

test('builds deterministic public-wallet and private manifests without worker names', async () => {
  const { createPayRunExecutionManifest } = await import('../src/server/pay-run-manifest')
  const address = '0x2de'
  const team = await store.createTeam(address, { name: 'Manifest team' })
  const worker = await store.addWorker(address, team.id, { name: 'Private Name', walletAddress: '0x2df', defaultAmountUsdc: '2.5' })
  const run = await store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '2.5' }] }, 'idempotency-key-0002')
  const first = createPayRunExecutionManifest(run)
  const second = createPayRunExecutionManifest(run)
  assert.equal(first.snapshotHash, second.snapshotHash)
  assert.equal(first.signing.authority, 'client')
  assert.equal(first.signing.serverCanSubmit, false)
  assert.equal(first.settlementMode, 'public-wallet')
  assert.deepEqual(first.actions, [{ kind: 'public-withdrawal', workerId: worker.id, recipient: '0x2df', amountUsdc: '2.5' }])
  assert.equal(JSON.stringify(first).includes('Private Name'), false)
  const privateRun = await store.createPayRun(address, { teamId: team.id, settlementMode: 'private', items: [{ workerId: worker.id, amountUsdc: '1' }] })
  const privateManifest = createPayRunExecutionManifest(privateRun)
  assert.equal(privateManifest.settlementMode, 'private')
  assert.equal(privateManifest.actions[0].kind, 'private-transfer')
})

test('enforces pay-run preparation before submission and locks submitted records', async () => {
  const team = await store.createTeam(owner, { name: 'Port Harcourt logistics' })
  const worker = await store.addWorker(owner, team.id, { name: 'Chidi Eze', walletAddress: '0x987', defaultAmountUsdc: '1' })
  const run = await store.createPayRun(owner, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] })
  await assert.rejects(
    store.updatePayRun(owner, run.id, { status: 'submitted', transactionHash: '0x123' }),
    /cannot move directly/,
  )
  await store.updatePayRun(owner, run.id, { status: 'prepared' })
  await store.updatePayRun(owner, run.id, { status: 'submitting' })
  const submitted = await store.updatePayRun(owner, run.id, { status: 'submitted', transactionHash: '0x123' })
  assert.equal(submitted.status, 'submitted')
  const finalized = await store.recordPayRunFinality(owner, run.id, { status: 'finalized', acceptedBlockNumber: 1234, message: 'Verified pool receipt.' })
  assert.equal(finalized.acceptedBlockNumber, 1234)
  await assert.rejects(store.updatePayRun(owner, run.id, { status: 'failed' }), /cannot move directly/)
  await assert.rejects(store.recordPayRunFinality(owner, run.id, { status: 'unknown', message: 'No downgrade.' }), /cannot be recorded/)
})

test('keeps unknown wallet outcomes recoverable while preventing reused transaction hashes', async () => {
  const team = await store.createTeam(owner, { name: 'Late wallet recovery' })
  const firstWorker = await store.addWorker(owner, team.id, { name: 'First Worker', walletAddress: '0x1111', defaultAmountUsdc: '1' })
  const secondWorker = await store.addWorker(owner, team.id, { name: 'Second Worker', walletAddress: '0x2222', defaultAmountUsdc: '1' })
  const first = await store.createPayRun(owner, { teamId: team.id, items: [{ workerId: firstWorker.id, amountUsdc: '1' }] })
  const second = await store.createPayRun(owner, { teamId: team.id, items: [{ workerId: secondWorker.id, amountUsdc: '1' }] })
  await store.updatePayRun(owner, first.id, { status: 'prepared' })
  await store.updatePayRun(owner, first.id, { status: 'submitting' })
  await store.updatePayRun(owner, first.id, { status: 'unknown' })
  assert.equal((await store.updatePayRun(owner, first.id, { status: 'submitted', transactionHash: '0x456' })).status, 'submitted')
  await store.recordPayRunFinality(owner, first.id, { status: 'unknown', message: 'Receipt is not final yet.' })
  assert.equal((await store.updatePayRun(owner, first.id, { status: 'unknown', transactionHash: '0x456' })).transactionHash, '0x456')
  await assert.rejects(store.updatePayRun(owner, first.id, { status: 'submitted', transactionHash: '0x457' }), /cannot change its recovered transaction hash/)
  await store.updatePayRun(owner, second.id, { status: 'prepared' })
  await store.updatePayRun(owner, second.id, { status: 'submitting' })
  await assert.rejects(store.updatePayRun(owner, second.id, { status: 'submitted', transactionHash: '0x456' }), /already attached/)
  await store.updatePayRun(owner, second.id, { status: 'failed' })
})

test('blocks new payroll while an outcome is unknown and requires explicit recovery confirmation', async () => {
  const address = '0x5151'
  const team = await store.createTeam(address, { name: 'Recovery lock team' })
  const worker = await store.addWorker(address, team.id, { name: 'Recovery Worker', walletAddress: '0x6161', defaultAmountUsdc: '1' })
  const run = await store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] })
  await store.updatePayRun(address, run.id, { status: 'prepared' })
  await store.updatePayRun(address, run.id, { status: 'submitting' })
  await store.updatePayRun(address, run.id, { status: 'unknown' })
  await assert.rejects(store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] }), /Resolve the existing unknown/)
  await assert.rejects(store.resolveUnknownPayRun(address, run.id, 'NO'), /NO TRANSACTION IN READY/)
  assert.equal((await store.resolveUnknownPayRun(address, run.id, 'NO TRANSACTION IN READY')).status, 'failed')
  assert.equal((await store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] })).status, 'draft')
})

test('persists a business profile and deletes only the wallet account record', async () => {
  const address = '0xabc'
  await store.createTeam(address, { name: 'Field operations' })
  const profile = await store.updateBusinessProfile(address, {
    ownerName: 'Amina Bello',
    businessName: 'Bello Foods',
    jobTitle: 'Owner',
    email: 'AMINA@EXAMPLE.COM',
    phone: '+234 800 000 0000',
  })
  assert.equal(profile.email, 'amina@example.com')
  assert.equal((await store.getAccount(address)).profile.businessName, 'Bello Foods')
  assert.deepEqual(await store.deleteAccount(address), { teams: 1, payRuns: 0 })
  const recreated = await store.getAccount(address)
  assert.equal(recreated.profile.ownerName, '')
  assert.equal(recreated.teams.length, 0)
})

test('persists organization payroll controls and enforces pause and maximum pay-run size', async () => {
  const address = '0x7788'
  const team = await store.createTeam(address, { name: 'Controlled payroll' })
  const worker = await store.addWorker(address, team.id, { name: 'Worker One', walletAddress: '0x8899', defaultAmountUsdc: '1' })
  const policy = await store.updatePayrollPolicy(address, { reserveUsdc: '5', maxPayRunUsdc: '2', payoutsPaused: false })
  assert.deepEqual({ reserveUsdc: policy.reserveUsdc, maxPayRunUsdc: policy.maxPayRunUsdc, payoutsPaused: policy.payoutsPaused }, { reserveUsdc: '5', maxPayRunUsdc: '2', payoutsPaused: false })
  await assert.rejects(store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '2.1' }] }), /organization limit/)
  const saved = await store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '2' }] })
  assert.equal(saved.totalUsdc, '2')
  await store.updatePayrollPolicy(address, { reserveUsdc: '5', maxPayRunUsdc: '2', payoutsPaused: true })
  await assert.rejects(store.createPayRun(address, { teamId: team.id, items: [{ workerId: worker.id, amountUsdc: '1' }] }), /payouts are paused/)
  await assert.rejects(store.updatePayRun(address, saved.id, { status: 'prepared' }), /payouts are paused/)
})

test('verifies only the saved business email and clears verification after an address change', async () => {
  const address = '0xe11a1'
  await assert.rejects(store.markBusinessEmailVerified(address, 'wrong@example.com'), /no longer matches/)
  await store.updateBusinessProfile(address, { ownerName: 'Email Owner', businessName: 'Email Company', email: 'owner@example.com' })
  assert.ok((await store.markBusinessEmailVerified(address, 'owner@example.com')).emailVerifiedAt)
  await store.updateBusinessProfile(address, { ownerName: 'Email Owner', businessName: 'Email Company', email: 'new@example.com' })
  assert.equal((await store.getAccount(address)).profile.emailVerifiedAt, '')
})

test('uses only a unique verified email as an account locator', async () => {
  const address = '0xe11a2'
  await store.linkVerifiedBusinessEmail(address, 'LOGIN@EXAMPLE.COM')
  assert.equal((await store.findVerifiedAccountByEmail('login@example.com'))?.walletAddress, address)
  await assert.rejects(store.linkVerifiedBusinessEmail('0xe11a3', 'login@example.com'), /already linked/)
  await store.updateBusinessProfile(address, { ownerName: 'Email Owner', businessName: 'Email Company', email: 'changed@example.com' })
  assert.equal(await store.findVerifiedAccountByEmail('changed@example.com'), null)
})

test('persists only public shield evidence and deduplicates a transaction hash', async () => {
  const first = await store.recordTreasuryShield(owner, { transactionHash: '0xabc123', amountUsdc: '1.25' })
  const duplicate = await store.recordTreasuryShield(owner, { transactionHash: '0xABC123', amountUsdc: '9' })
  const account = await store.getAccount(owner)
  assert.equal(duplicate.transactionHash, first.transactionHash)
  assert.equal(account.treasuryShields.length, 1)
  assert.deepEqual(Object.keys(account.treasuryShields[0]).sort(), ['amountUsdc', 'submittedAt', 'transactionHash'])
})

test('stores passkey public credentials without exposing verification material in account views', async () => {
  const address = '0xdef'
  await store.savePasskey(address, {
    credentialId: 'credential_123',
    publicKey: 'public_key_123',
    counter: 4,
    transports: ['internal'],
    deviceType: 'multiDevice',
    backedUp: true,
  })
  const match = await store.findPasskey('credential_123')
  assert.equal(match?.walletAddress, address)
  assert.equal(match?.passkey.publicKey, 'public_key_123')
  const view = store.publicAccount(await store.getAccount(address))
  assert.equal(view.passkeys[0].backedUp, true)
  assert.equal(view.passkeys[0].prfCapable, false)
  assert.equal('publicKey' in view.passkeys[0], false)
  await store.updatePasskeyPrf(address, 'credential_123', PRF_ONE)
  assert.equal(store.publicAccount(await store.getAccount(address)).passkeys[0].prfCapable, true)
  await store.updatePasskeyCounter(address, 'credential_123', 5)
  await assert.rejects(store.updatePasskeyCounter(address, 'credential_123', 4), /rollback/)
  await assert.rejects(store.savePasskey('0xbeef', { credentialId: 'credential_123', publicKey: 'other_key', counter: 0 }), /another KudiRoll account/)
})

test('keeps two recovery passkeys after a credential revocation', async () => {
  const address = '0xaaa'
  for (const [suffix, prfInput] of [['one', PRF_ONE], ['two', PRF_TWO], ['three', PRF_THREE]]) await store.savePasskey(address, { credentialId: `credential_${suffix}`, publicKey: `public_${suffix}`, counter: 0, prfCapable: true, prfInput })
  assert.equal(store.publicAccount(await store.getAccount(address)).recoveryReady, true)
  await store.removePasskey(address, 'credential_one')
  assert.equal((await store.getAccount(address)).passkeys.length, 2)
  await assert.rejects(store.removePasskey(address, 'credential_two'), /Add a third passkey/)
})

test('never revokes one of only two PRF-capable recovery credentials', async () => {
  const address = '0xaab'
  await store.savePasskey(address, { credentialId: 'protected_one', publicKey: 'protected_public_one', counter: 0, prfCapable: true, prfInput: PRF_ONE })
  await store.savePasskey(address, { credentialId: 'protected_two', publicKey: 'protected_public_two', counter: 0, prfCapable: true, prfInput: PRF_TWO })
  await store.savePasskey(address, { credentialId: 'signin_only', publicKey: 'signin_public', counter: 0 })
  await assert.rejects(store.removePasskey(address, 'protected_one'), /another PRF-capable/)
  await store.removePasskey(address, 'signin_only')
  assert.equal(store.publicAccount(await store.getAccount(address)).recoveryReady, true)
})

test('persists only a validated encrypted wallet envelope', async () => {
  const address = '0xcafe'
  await store.savePasskey(address, { credentialId: 'vault_credential_one', publicKey: 'vault_public_one', counter: 0, prfCapable: true, prfInput: PRF_ONE })
  await store.savePasskey(address, { credentialId: 'vault_credential_two', publicKey: 'vault_public_two', counter: 0, prfCapable: true, prfInput: PRF_TWO })
  const metadata = await store.saveEncryptedWalletBackup(address, {
    version: 2,
    kdf: 'HKDF-SHA-256',
    cipher: 'AES-256-GCM',
    accountAddress: address,
    signerProvider: 'argent-web-wallet',
    payloadIv: 'iv_123',
    ciphertext: 'ciphertext_123',
    keySlots: [
      { credentialId: 'vault_credential_one', prfInput: PRF_ONE, salt: 'salt_one', iv: 'iv_one', wrappedKey: 'wrapped_one' },
      { credentialId: 'vault_credential_two', prfInput: PRF_TWO, salt: 'salt_two', iv: 'iv_two', wrappedKey: 'wrapped_two' },
    ],
  })
  assert.equal(metadata.available, true)
  const backup = await store.getEncryptedWalletBackup(address)
  assert.equal(backup?.ciphertext, 'ciphertext_123')
  assert.deepEqual(Object.keys(store.publicAccount(await store.getAccount(address)).encryptedWalletBackup || {}).sort(), ['available', 'updatedAt'])
  await store.savePasskey(address, { credentialId: 'vault_credential_three', publicKey: 'vault_public_three', counter: 0, prfCapable: true, prfInput: PRF_THREE })
  await assert.rejects(store.removePasskey(address, 'vault_credential_one'), /encrypted wallet vault/)
  await store.saveEncryptedWalletBackup(address, {
    ...backup,
    keySlots: [
      ...(backup?.keySlots || []),
      { credentialId: 'vault_credential_three', prfInput: PRF_THREE, salt: 'salt_three', iv: 'iv_three', wrappedKey: 'wrapped_three' },
    ],
  })
  await store.removePasskey(address, 'vault_credential_one')
  assert.deepEqual((await store.getEncryptedWalletBackup(address))?.keySlots.map(slot => slot.credentialId).sort(), ['vault_credential_three', 'vault_credential_two'])
  await assert.rejects(store.saveEncryptedWalletBackup(address, { version: 1, kdf: 'password', cipher: 'AES-256-GCM' }), /unsupported/)
})
