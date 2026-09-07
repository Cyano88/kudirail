import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { decryptAccountRecord } from '../src/server/account-postgres-store'

// Credentials are inherited through the environment, never command arguments or logs.
const magic = Buffer.from('KUDIROLL-BACKUP-1\n')
let stage = 'configuration'
const limit = 128 * 1024 * 1024
const tables = ['kudiroll_accounts', 'kudiroll_auth_challenges', 'kudiroll_auth_sessions', 'kudiroll_schema_migrations']
function key() {
 const encoded = process.env.KUDI_BACKUP_KEY || ''
 const value = Buffer.from(encoded, 'base64url')
 assert.ok(value.length === 32 && value.toString('base64url') === encoded, 'A canonical 32-byte backup key is required')
 return value
}
export function seal(data: Buffer, secret: Buffer) {
 const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv)
 cipher.setAAD(magic)
 return Buffer.concat([magic, iv, cipher.update(data), cipher.final(), cipher.getAuthTag()])
}
export function unseal(data: Buffer, secret: Buffer) {
 assert.ok(data.subarray(0, magic.length).equals(magic))
 const decipher = createDecipheriv('aes-256-gcm', secret, data.subarray(magic.length, magic.length + 12))
 decipher.setAAD(magic); decipher.setAuthTag(data.subarray(-16))
 return Buffer.concat([decipher.update(data.subarray(magic.length + 12, -16)), decipher.final()])
}
export function restoreTarget(raw: string) {
 const url = new URL(raw)
 assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname))
 assert.match(url.pathname, /^\/kudiroll_recovery_[a-z0-9_]+$/)
 assert.equal(url.search, '')
 return url
}
function connection(url: URL) {
 assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
 assert.equal(url.search, '', 'Use explicit SSL settings; URL overrides are rejected')
 const local = ['127.0.0.1', 'localhost'].includes(url.hostname)
 return { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), ssl: local ? false as const : { rejectUnauthorized: true }, connectionTimeoutMillis: 10000 }
}
function utility(bin: string, args: string[], url: URL, input?: Buffer): Promise<Buffer> {
 const c = connection(url)
 return new Promise((resolve, reject) => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('PG')))
  const prefix: unknown = JSON.parse(process.env.PG_DUMP_BIN === bin ? (process.env.KUDI_PG_DUMP_PREFIX || '[]') : '[]')
  assert.ok(Array.isArray(prefix) && prefix.every(value => typeof value === 'string'))
  const child = spawn(bin, [...prefix, ...args], { windowsHide: true, env: { ...cleanEnv, ...(process.env.PGSSLROOTCERT ? { PGSSLROOTCERT: process.env.PGSSLROOTCERT } : {}), PGHOST: c.host, PGPORT: String(c.port), PGUSER: c.user, PGPASSWORD: c.password, PGDATABASE: c.database, PGSSLMODE: c.ssl ? 'verify-full' : 'disable', PGCONNECT_TIMEOUT: '10', PGOPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let size = 0; const chunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) child.kill(); else chunks.push(chunk) })
  child.stderr.resume() // May contain private values; never log it.
  child.on('error', () => reject(new Error('PostgreSQL utility could not start')))
  child.on('close', code => code === 0 && size <= limit ? resolve(Buffer.concat(chunks)) : reject(new Error('PostgreSQL utility failed; check version, TLS and access')))
  child.stdin.on('error', () => undefined); child.stdin.end(input)
 })
}
async function fingerprint(client: pg.Client) {
 const actual = (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.tablename)
 assert.deepEqual(actual, tables, 'Unexpected schema: review backup coverage before continuing')
 const fingerprints: Record<string, {count: number; sha256: string}> = {}
 for (const table of tables) {
  const rows = (await client.query(`select row_to_json(t)::text as value from public.${table} t`)).rows.map(r => r.value as string).sort()
  fingerprints[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
 }
 return fingerprints
}
async function checkAccounts(client: pg.Client) {
 for (const row of (await client.query('select wallet_address, record from kudiroll_accounts')).rows) decryptAccountRecord(row.wallet_address, row.record)
}
async function main() {
 const [mode, path] = process.argv.slice(2)
 assert.ok(path && ['backup', 'verify'].includes(mode))
 stage = 'backup-key-validation'
 const secret = key()
 let client: pg.Client | undefined
 try {
  if (mode === 'backup') {
   const source = new URL(process.env.KUDI_BACKUP_SOURCE_URL || '')
   stage = 'account-key-configuration'
   const accountKey = (process.env.KUDIROLL_DATA_ENCRYPTION_KEY || '').trim()
   process.env.KUDIROLL_DATA_ENCRYPTION_KEY = accountKey
   assert.ok(Buffer.from(accountKey, 'base64url').length === 32 && Buffer.from(accountKey, 'base64url').toString('base64url') === accountKey)
   stage = 'source-connection'
   client = new pg.Client(connection(source)); await client.connect()
   await client.query("set timezone = 'UTC'")
   await client.query('begin isolation level repeatable read read only')
   await client.query("set local statement_timeout = '60s'")
   const snapshot = (await client.query('select pg_export_snapshot() as id')).rows[0].id
   const version = (await client.query('show server_version')).rows[0].server_version
   stage = 'source-fingerprint'
   const expected = await fingerprint(client); stage = 'account-key-verification'; await checkAccounts(client)
   const startedAt = new Date().toISOString()
   stage = 'pg-dump'
   const dump = await utility(process.env.PG_DUMP_BIN || 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--lock-wait-timeout=10000', `--snapshot=${snapshot}`], source)
   await client.query('commit')
   const payload = Buffer.from(JSON.stringify({ version: 1, startedAt, serverVersion: version, expected, accountKey: process.env.KUDIROLL_DATA_ENCRYPTION_KEY, dump: dump.toString('base64') }))
   stage = 'encrypted-file-write'
   try { await writeFile(path, seal(payload, secret), { flag: 'wx', mode: 0o600 }) } finally { payload.fill(0); dump.fill(0) }
   console.log(JSON.stringify({ result: 'encrypted-backup-created', startedAt, serverVersion: version }))
  } else {
   stage = 'restore-target-validation'
   const target = restoreTarget(process.env.KUDI_BACKUP_TARGET_URL || '')
   stage = 'archive-authentication'
   const plaintext = unseal(await readFile(path), secret)
   let archive
   try { archive = JSON.parse(plaintext.toString('utf8')) } finally { plaintext.fill(0) }
   assert.equal(archive.version, 1)
   stage = 'restore-connection'
   client = new pg.Client(connection(target)); await client.connect()
   await client.query("set timezone = 'UTC'")
   stage = 'empty-target-check'
   const existing = await client.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'")
   assert.equal(existing.rows[0].count, 0, 'Restore requires a fresh empty database')
   const started = Date.now(), dump = Buffer.from(archive.dump, 'base64')
   stage = 'pg-restore'
   try { await utility(process.env.PG_RESTORE_BIN || 'pg_restore', ['--dbname', target.pathname.slice(1), '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], target, dump) } finally { dump.fill(0) }
   stage = 'restored-data-verification'
   assert.deepEqual(await fingerprint(client), archive.expected)
   process.env.KUDIROLL_DATA_ENCRYPTION_KEY = archive.accountKey
   await checkAccounts(client)
   await client.query('begin')
   stage = 'restored-session-revocation'
   await client.query('delete from kudiroll_auth_sessions'); await client.query('delete from kudiroll_auth_challenges')
   await client.query('commit')
   assert.equal(Number((await client.query('select count(*) as count from kudiroll_auth_sessions')).rows[0].count), 0)
   assert.equal(Number((await client.query('select count(*) as count from kudiroll_auth_challenges')).rows[0].count), 0)
   console.log(JSON.stringify({ result: 'restore-verified-sessions-revoked', backupStartedAt: archive.startedAt, restoreSeconds: (Date.now()-started)/1000, paymentsEnabled: false }))
  }
 } finally { secret.fill(0); if (client) await client.end() }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/manual-backup.ts')) main().catch(() => { console.error(JSON.stringify({ result: 'failed', stage, hint: 'Check access, TLS, tool version, key and empty local target. Production restore is prohibited.' })); process.exitCode = 1 })
