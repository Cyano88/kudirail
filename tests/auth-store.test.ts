import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const authFile = join(tmpdir(), `kudiroll-auth-${randomUUID()}.json`)
process.env.KUDIROLL_AUTH_FILE = authFile
const auth = await import('../src/server/auth-store')

test.after(async () => { await rm(authFile, { force: true }) })

test('persists only a hash of a session token and survives a store read', async () => {
  const token = await auth.createAuthSession('0x123', 'passkey', 'credential_a')
  const raw = await readFile(authFile, 'utf8')
  assert.equal(raw.includes(token), false)
  assert.deepEqual(await auth.getAuthSession(token), {
    address: '0x123',
    method: 'passkey',
    credentialId: 'credential_a',
    authenticatedAt: (await auth.getAuthSession(token))?.authenticatedAt,
    expiresAt: (await auth.getAuthSession(token))?.expiresAt,
  })
})

test('consumes a hashed challenge exactly once and rejects expiry', async () => {
  const key = 'browser_request_secret'
  await auth.saveAuthChallenge(key, { purpose: 'passkey-signin', challenge: 'challenge_123', address: '', targetCredentialId: '', expiresAt: Date.now() + 60_000 })
  assert.equal((await readFile(authFile, 'utf8')).includes(key), false)
  assert.equal((await auth.consumeAuthChallenge(key, 'passkey-signin')).challenge, 'challenge_123')
  await assert.rejects(auth.consumeAuthChallenge(key, 'passkey-signin'), /expired/)
  await auth.saveAuthChallenge('expired_key', { purpose: 'passkey-signin', challenge: 'old', address: '', targetCredentialId: '', expiresAt: Date.now() - 1 })
  await assert.rejects(auth.consumeAuthChallenge('expired_key', 'passkey-signin'), /expired/)
})

test('invalidates sessions created by a revoked credential', async () => {
  const revoked = await auth.createAuthSession('0xabc', 'passkey', 'credential_old')
  const retained = await auth.createAuthSession('0xabc', 'passkey', 'credential_new')
  await auth.deleteAuthSessionsForCredential('0xabc', 'credential_old')
  assert.equal(await auth.getAuthSession(revoked), null)
  assert.equal((await auth.getAuthSession(retained))?.credentialId, 'credential_new')
})

test('persists email sessions without storing the email as credential material', async () => {
  const token = await auth.createAuthSession('0xe01', 'email')
  const session = await auth.getAuthSession(token)
  assert.equal(session?.method, 'email')
  assert.equal(session?.credentialId, '')
})
