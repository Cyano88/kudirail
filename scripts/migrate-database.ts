import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { databasePool, persistenceConfig } from '../src/server/database'

if (!persistenceConfig().databaseConfigured) throw new Error('Set KUDIROLL_DATABASE_URL or DATABASE_URL before running migrations.')
const sql = await readFile(resolve('migrations/001_persistence.sql'), 'utf8')
const pool = databasePool()
try { await pool.query(sql); console.log('KudiRoll database migration 001 applied.') } finally { await pool.end() }
