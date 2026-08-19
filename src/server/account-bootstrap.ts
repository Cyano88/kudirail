import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { StoreFile } from './account-store'
import { pgInitializeAccountStore } from './account-postgres-store'
import { persistenceConfig } from './database'

export async function bootstrapAccountStore() {
  if (persistenceConfig().accountBackend !== 'postgres' || process.env.KUDIROLL_IMPORT_FILE_ON_EMPTY !== 'true') return null
  const source = resolve(process.env.KUDIROLL_DATA_FILE || '.data/kudiroll.json')
  let parsed: StoreFile
  try {
    parsed = JSON.parse(await readFile(source, 'utf8')) as StoreFile
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    parsed = { version: 1, accounts: {} }
  }
  if (parsed?.version !== 1 || !parsed.accounts || Array.isArray(parsed.accounts)) throw new Error('The KudiRoll account file is malformed; startup import aborted.')
  const result = await pgInitializeAccountStore(parsed)
  console.log('KudiRoll PostgreSQL account store ready', result)
  return result
}
