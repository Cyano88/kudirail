import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { databasePool, persistenceConfig } from '../src/server/database'

if (!persistenceConfig().databaseConfigured) throw new Error('Set KUDIROLL_DATABASE_URL or DATABASE_URL before running migrations.')
const pool = databasePool()
try {
  const directory = resolve('migrations')
  const migrations = (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()
  for (const migration of migrations) {
    await pool.query(await readFile(resolve(directory, migration), 'utf8'))
    console.log(`KudiRoll database migration ${migration} applied.`)
  }
} finally { await pool.end() }
