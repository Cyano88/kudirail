import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { seal, unseal, restoreTarget } from '../scripts/manual-backup'
test('encrypted backups reject tampering and wrong recovery keys', () => {
 const key = randomBytes(32), data = Buffer.from('synthetic backup contents')
 const encrypted = seal(data, key)
 assert.ok(!encrypted.includes(data)); assert.deepEqual(unseal(encrypted, key), data)
 assert.throws(() => unseal(encrypted, randomBytes(32)))
 encrypted[encrypted.length - 20] ^= 1
 assert.throws(() => unseal(encrypted, key))
})
test('restore refuses remote, production-named and option-overridden targets', () => {
 assert.equal(restoreTarget('postgresql://x:y@127.0.0.1:55439/kudiroll_recovery_test').hostname, '127.0.0.1')
 for (const url of ['postgresql://x:y@db.example/kudiroll_recovery_test', 'postgresql://x:y@127.0.0.1/production', 'postgresql://x:y@localhost/kudiroll_recovery_test?host=remote', 'https://localhost/kudiroll_recovery_test']) assert.throws(() => restoreTarget(url))
})
