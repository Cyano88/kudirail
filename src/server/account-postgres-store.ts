import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AccountRecord, StoreFile } from './account-store'
import { databasePool } from './database'

type EncryptedAccountRecord = { version: 1; algorithm: 'aes-256-gcm'; iv: string; ciphertext: string; tag: string }
const ACCOUNT_STORE_LOCK = '539018884441091'

function encryptionKey() {
  const encoded = process.env.KUDIROLL_DATA_ENCRYPTION_KEY?.trim() || ''
  const key = Buffer.from(encoded, 'base64url')
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) throw new Error('KUDIROLL_DATA_ENCRYPTION_KEY must be a canonical base64url-encoded 32-byte key.')
  return key
}

export function encryptAccountRecord(walletAddress: string, account: AccountRecord): EncryptedAccountRecord {
  const key = encryptionKey()
  try {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(walletAddress, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(account), 'utf8'), cipher.final()])
    return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
  } finally { key.fill(0) }
}

export function decryptAccountRecord(walletAddress: string, envelope: unknown): AccountRecord {
  const value = envelope as Partial<EncryptedAccountRecord>
  if (value?.version !== 1 || value.algorithm !== 'aes-256-gcm' || !value.iv || !value.ciphertext || !value.tag) throw new Error('Stored KudiRoll account envelope is malformed.')
  const key = encryptionKey()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64url'))
    decipher.setAAD(Buffer.from(walletAddress, 'utf8'))
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()])
    try {
      const account = JSON.parse(plaintext.toString('utf8')) as AccountRecord
      if (account.walletAddress !== walletAddress) throw new Error('Stored KudiRoll account belongs to a different wallet.')
      return account
    } finally { plaintext.fill(0) }
  } finally { key.fill(0) }
}

async function readWith(client: Pick<PoolClient, 'query'>): Promise<StoreFile> {
  const result = await client.query('select wallet_address, record from kudiroll_accounts order by wallet_address')
  const accounts: Record<string, AccountRecord> = {}
  for (const row of result.rows) accounts[row.wallet_address] = decryptAccountRecord(row.wallet_address, row.record)
  return { version: 1, accounts }
}

export async function pgReadAccountStore() { return readWith(databasePool()) }

async function writeWith(client: PoolClient, before: Map<string, string>, store: StoreFile) {
  const after = new Set(Object.keys(store.accounts))
  const removed = [...before.keys()].filter(walletAddress => !after.has(walletAddress))
  if (removed.length) await client.query('delete from kudiroll_accounts where wallet_address = any($1::text[])', [removed])
  for (const [walletAddress, account] of Object.entries(store.accounts)) {
    if (account.walletAddress !== walletAddress) throw new Error('KudiRoll account key mismatch rejected.')
    if (before.get(walletAddress) === JSON.stringify(account)) continue
    await client.query(
      `insert into kudiroll_accounts (wallet_address, record, created_at, updated_at) values ($1, $2::jsonb, $3, $4)
       on conflict (wallet_address) do update set record = excluded.record, updated_at = excluded.updated_at`,
      [walletAddress, JSON.stringify(encryptAccountRecord(walletAddress, account)), account.createdAt, account.updatedAt],
    )
  }
}

export async function pgMutateAccountStore<T>(operation: (store: StoreFile) => T | Promise<T>) {
  const client = await databasePool().connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1)', [ACCOUNT_STORE_LOCK])
    const store = await readWith(client)
    const before = new Map(Object.entries(store.accounts).map(([walletAddress, account]) => [walletAddress, JSON.stringify(account)]))
    const result = await operation(store)
    await writeWith(client, before, store)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function pgImportAccountStore(store: StoreFile) {
  const client = await databasePool().connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1)', [ACCOUNT_STORE_LOCK])
    const count = Number((await client.query('select count(*) as count from kudiroll_accounts')).rows[0].count)
    if (count !== 0) throw new Error('PostgreSQL account store is not empty; import aborted.')
    await writeWith(client, new Map(), store)
    await client.query('commit')
    return Object.keys(store.accounts).length
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function pgInitializeAccountStore(store: StoreFile) {
  const client = await databasePool().connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1)', [ACCOUNT_STORE_LOCK])
    const count = Number((await client.query('select count(*) as count from kudiroll_accounts')).rows[0].count)
    if (count === 0) {
      await writeWith(client, new Map(), store)
      await client.query('commit')
      return { imported: Object.keys(store.accounts).length, existing: 0 }
    }
    await readWith(client)
    await client.query('commit')
    return { imported: 0, existing: count }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally { client.release() }
}
