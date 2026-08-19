import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePersistenceConfig } from '../src/server/database'

test('file persistence remains the safe default', () => {
  assert.deepEqual(resolvePersistenceConfig({}), { databaseConfigured: false, authBackend: 'file', accountBackend: 'file', accountEncryptionConfigured: false })
})

test('postgres authentication requires an explicit database URL', () => {
  assert.throws(() => resolvePersistenceConfig({ KUDIROLL_AUTH_BACKEND: 'postgres' }), /requires/)
  assert.deepEqual(resolvePersistenceConfig({ KUDIROLL_AUTH_BACKEND: 'postgres', DATABASE_URL: 'postgres://redacted' }), { databaseConfigured: true, authBackend: 'postgres', accountBackend: 'file', accountEncryptionConfigured: false })
})

test('unknown authentication backends fail closed', () => {
  assert.throws(() => resolvePersistenceConfig({ KUDIROLL_AUTH_BACKEND: 'memory' }), /file or postgres/)
})

test('postgres account persistence requires database and encryption configuration', () => {
  assert.throws(() => resolvePersistenceConfig({ KUDIROLL_ACCOUNT_BACKEND: 'postgres', DATABASE_URL: 'postgres://redacted' }), /ENCRYPTION_KEY/)
  const configured = resolvePersistenceConfig({ KUDIROLL_ACCOUNT_BACKEND: 'postgres', DATABASE_URL: 'postgres://redacted', KUDIROLL_DATA_ENCRYPTION_KEY: 'configured-outside-source' })
  assert.equal(configured.accountBackend, 'postgres')
  assert.equal(configured.accountEncryptionConfigured, true)
})
