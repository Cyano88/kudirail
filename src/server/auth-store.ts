import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { persistenceConfig } from './database'
import { pgAuthStoreCounts, pgConsumeAuthChallenge, pgCreateAuthSession, pgDeleteAuthSession, pgDeleteAuthSessionsForAddress, pgDeleteAuthSessionsForCredential, pgGetAuthSession, pgSaveAuthChallenge } from './auth-postgres-store'

export type AuthMethod = 'wallet' | 'passkey'
export type AuthSession = {
  address: string
  expiresAt: number
  authenticatedAt: number
  method: AuthMethod
  credentialId: string
}

export type AuthChallenge = {
  purpose: 'wallet-signin' | 'passkey-register' | 'passkey-signin' | 'passkey-prf' | 'passkey-revoke' | 'email-verify'
  challenge: string
  address: string
  targetCredentialId: string
  prfInput?: string
  expiresAt: number
}

type StoredSession = AuthSession & { tokenHash: string }
type StoredChallenge = AuthChallenge & { keyHash: string }
type AuthFile = { version: 1; sessions: Record<string, StoredSession>; challenges: Record<string, StoredChallenge> }

const accountPath = resolve(process.env.KUDIROLL_DATA_FILE || '.data/kudiroll.json')
const authPath = resolve(process.env.KUDIROLL_AUTH_FILE || join(dirname(accountPath), 'kudiroll-auth.json'))
let queue = Promise.resolve()

function emptyStore(): AuthFile {
  return { version: 1, sessions: {}, challenges: {} }
}

function hashSecret(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

function clean(store: AuthFile, now = Date.now()) {
  for (const [key, session] of Object.entries(store.sessions)) if (session.expiresAt <= now) delete store.sessions[key]
  for (const [key, challenge] of Object.entries(store.challenges)) if (challenge.expiresAt <= now) delete store.challenges[key]
}

async function readStore(): Promise<AuthFile> {
  try {
    const parsed = JSON.parse(await readFile(authPath, 'utf8'))
    if (parsed?.version !== 1 || !parsed?.sessions || !parsed?.challenges) return emptyStore()
    return parsed
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyStore()
    throw error
  }
}

async function writeStore(store: AuthFile) {
  await mkdir(dirname(authPath), { recursive: true })
  const temporary = `${authPath}.tmp`
  await writeFile(temporary, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, authPath)
}

async function mutate<T>(operation: (store: AuthFile) => T | Promise<T>) {
  let result!: T
  const next = queue.catch(() => undefined).then(async () => {
    const store = await readStore()
    clean(store)
    result = await operation(store)
    await writeStore(store)
  })
  queue = next
  await next
  return result
}

export async function createAuthSession(address: string, method: AuthMethod, credentialId = '') {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashSecret(token)
  const now = Date.now()
  if (persistenceConfig().authBackend === 'postgres') {
    await pgCreateAuthSession(tokenHash, address, method, credentialId, now)
    return token
  }
  await mutate(store => {
    store.sessions[tokenHash] = { tokenHash, address, method, credentialId, authenticatedAt: now, expiresAt: now + 12 * 60 * 60 * 1000 }
  })
  return token
}

export async function getAuthSession(token: string): Promise<AuthSession | null> {
  if (!token) return null
  if (persistenceConfig().authBackend === 'postgres') return pgGetAuthSession(hashSecret(token))
  const session = (await readStore()).sessions[hashSecret(token)]
  if (!session || session.expiresAt <= Date.now()) return null
  const { tokenHash: _tokenHash, ...view } = session
  return view
}

export async function deleteAuthSession(token: string) {
  if (!token) return
  if (persistenceConfig().authBackend === 'postgres') return pgDeleteAuthSession(hashSecret(token))
  await mutate(store => { delete store.sessions[hashSecret(token)] })
}

export async function deleteAuthSessionsForAddress(address: string) {
  if (persistenceConfig().authBackend === 'postgres') return pgDeleteAuthSessionsForAddress(address)
  await mutate(store => {
    for (const [key, session] of Object.entries(store.sessions)) if (session.address === address) delete store.sessions[key]
  })
}

export async function deleteAuthSessionsForCredential(address: string, credentialId: string, exceptToken = '') {
  const exceptHash = exceptToken ? hashSecret(exceptToken) : ''
  if (persistenceConfig().authBackend === 'postgres') return pgDeleteAuthSessionsForCredential(address, credentialId, exceptHash)
  await mutate(store => {
    for (const [key, session] of Object.entries(store.sessions)) {
      if (key !== exceptHash && session.address === address && session.credentialId === credentialId) delete store.sessions[key]
    }
  })
}

export async function saveAuthChallenge(key: string, challenge: AuthChallenge) {
  const keyHash = hashSecret(key)
  if (persistenceConfig().authBackend === 'postgres') return pgSaveAuthChallenge(`${challenge.purpose}:${keyHash}`, keyHash, challenge)
  await mutate(store => { store.challenges[`${challenge.purpose}:${keyHash}`] = { ...challenge, keyHash } })
}

export async function consumeAuthChallenge(key: string, purpose: AuthChallenge['purpose']) {
  const storageKey = `${purpose}:${hashSecret(key)}`
  if (persistenceConfig().authBackend === 'postgres') return pgConsumeAuthChallenge(storageKey)
  return mutate(store => {
    const challenge = store.challenges[storageKey]
    delete store.challenges[storageKey]
    if (!challenge || challenge.expiresAt <= Date.now()) throw Object.assign(new Error('This authentication request expired. Try again.'), { status: 401 })
    const { keyHash: _keyHash, ...view } = challenge
    return view
  })
}

export async function authStoreCounts() {
  if (persistenceConfig().authBackend === 'postgres') return pgAuthStoreCounts()
  const store = await readStore()
  clean(store)
  return { sessions: Object.keys(store.sessions).length, challenges: Object.keys(store.challenges).length }
}
