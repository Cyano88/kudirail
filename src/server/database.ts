import pg from 'pg'

const { Pool } = pg

export type PersistenceConfig = { databaseConfigured: boolean; authBackend: 'file' | 'postgres'; accountBackend: 'file' | 'postgres'; accountEncryptionConfigured: boolean }

export function resolvePersistenceConfig(env: NodeJS.ProcessEnv = process.env): PersistenceConfig {
  const databaseConfigured = Boolean((env.KUDIROLL_DATABASE_URL || env.DATABASE_URL)?.trim())
  const authBackend = (env.KUDIROLL_AUTH_BACKEND || 'file').trim().toLowerCase()
  const accountBackend = (env.KUDIROLL_ACCOUNT_BACKEND || 'file').trim().toLowerCase()
  const accountEncryptionConfigured = Boolean(env.KUDIROLL_DATA_ENCRYPTION_KEY?.trim())
  if (authBackend !== 'file' && authBackend !== 'postgres') throw new Error('KUDIROLL_AUTH_BACKEND must be file or postgres.')
  if (accountBackend !== 'file' && accountBackend !== 'postgres') throw new Error('KUDIROLL_ACCOUNT_BACKEND must be file or postgres.')
  if ((authBackend === 'postgres' || accountBackend === 'postgres') && !databaseConfigured) throw new Error('A PostgreSQL backend requires KUDIROLL_DATABASE_URL or DATABASE_URL.')
  if (accountBackend === 'postgres' && !accountEncryptionConfigured) throw new Error('KUDIROLL_ACCOUNT_BACKEND=postgres requires KUDIROLL_DATA_ENCRYPTION_KEY.')
  return { databaseConfigured, authBackend, accountBackend, accountEncryptionConfigured }
}

export function persistenceConfig() { return resolvePersistenceConfig() }
let pool: pg.Pool | null = null

export function databasePool() {
  if (!persistenceConfig().databaseConfigured) throw new Error('PostgreSQL is not configured.')
  if (!pool) {
    const poolSize = Number(process.env.KUDIROLL_DATABASE_POOL_SIZE || 5)
    if (!Number.isSafeInteger(poolSize) || poolSize < 1 || poolSize > 20) throw new Error('KUDIROLL_DATABASE_POOL_SIZE must be an integer from 1 to 20.')
    pool = new Pool({ connectionString: (process.env.KUDIROLL_DATABASE_URL || process.env.DATABASE_URL)?.trim(), max: poolSize, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, application_name: 'kudiroll' })
    pool.on('error', error => console.error('PostgreSQL idle client error', { name: error.name }))
  }
  return pool
}

export async function databaseReadiness() {
  if (!persistenceConfig().databaseConfigured) return { configured: false, reachable: false, schemaVersion: null }
  try {
    const schema = await databasePool().query(`select to_regclass('public.kudiroll_schema_migrations') as table_name`)
    if (!schema.rows[0].table_name) return { configured: true, reachable: true, schemaVersion: null }
    const version = await databasePool().query('select max(version) as version from kudiroll_schema_migrations')
    return { configured: true, reachable: true, schemaVersion: version.rows[0].version === null ? null : Number(version.rows[0].version) }
  } catch { return { configured: true, reachable: false, schemaVersion: null } }
}
