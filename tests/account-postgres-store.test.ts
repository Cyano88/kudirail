import assert from 'node:assert/strict'
import test from 'node:test'
import type { AccountRecord } from '../src/server/account-store'

process.env.KUDIROLL_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url')
const encryption = await import('../src/server/account-postgres-store')
const account = { walletAddress: '0x123', profile: { businessName: 'Private payroll' }, teams: [{ name: 'Confidential team' }] } as AccountRecord

test('encrypts account records and binds ciphertext to its wallet tenant', () => {
  const envelope = encryption.encryptAccountRecord(account.walletAddress, account)
  assert.equal(JSON.stringify(envelope).includes('Private payroll'), false)
  assert.equal(JSON.stringify(envelope).includes('Confidential team'), false)
  assert.deepEqual(encryption.decryptAccountRecord(account.walletAddress, envelope), account)
  assert.throws(() => encryption.decryptAccountRecord('0x999', envelope))
})

test('rejects modified encrypted account records', () => {
  const envelope = encryption.encryptAccountRecord(account.walletAddress, account)
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
  ciphertext[0] ^= 1
  assert.throws(() => encryption.decryptAccountRecord(account.walletAddress, { ...envelope, ciphertext: ciphertext.toString('base64url') }))
})

test('requires a canonical 32-byte account encryption key', () => {
  const original = process.env.KUDIROLL_DATA_ENCRYPTION_KEY
  process.env.KUDIROLL_DATA_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64url')
  assert.throws(() => encryption.encryptAccountRecord(account.walletAddress, account), /32-byte/)
  process.env.KUDIROLL_DATA_ENCRYPTION_KEY = original
})
