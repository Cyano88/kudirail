import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { StoreFile } from '../src/server/account-store'
import { pgImportAccountStore } from '../src/server/account-postgres-store'
import { databasePool } from '../src/server/database'

const source = resolve(process.env.KUDIROLL_DATA_FILE || '.data/kudiroll.json')
const parsed = JSON.parse(await readFile(source, 'utf8')) as StoreFile
if (parsed?.version !== 1 || !parsed.accounts || Array.isArray(parsed.accounts)) throw new Error('The KudiRoll account file is malformed; import aborted.')
try {
  const imported = await pgImportAccountStore(parsed)
  console.log(`Imported ${imported} encrypted KudiRoll account record(s).`)
} finally { await databasePool().end() }
