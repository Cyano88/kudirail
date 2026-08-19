import { databasePool } from './database'
import type { AuthChallenge, AuthMethod, AuthSession } from './auth-store'

export async function pgCreateAuthSession(tokenHash: string, address: string, method: AuthMethod, credentialId: string, now: number) {
  await databasePool().query(
    `insert into kudiroll_auth_sessions (token_hash, wallet_address, method, credential_id, authenticated_at, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [tokenHash, address, method, credentialId, now, now + 12 * 60 * 60 * 1000],
  )
}

export async function pgGetAuthSession(tokenHash: string): Promise<AuthSession | null> {
  const result = await databasePool().query(
    `select wallet_address, method, credential_id, authenticated_at, expires_at
       from kudiroll_auth_sessions where token_hash = $1 and expires_at > $2`,
    [tokenHash, Date.now()],
  )
  const row = result.rows[0]
  return row ? { address: row.wallet_address, method: row.method, credentialId: row.credential_id, authenticatedAt: Number(row.authenticated_at), expiresAt: Number(row.expires_at) } : null
}

export async function pgDeleteAuthSession(tokenHash: string) {
  await databasePool().query('delete from kudiroll_auth_sessions where token_hash = $1', [tokenHash])
}

export async function pgDeleteAuthSessionsForAddress(address: string) {
  await databasePool().query('delete from kudiroll_auth_sessions where wallet_address = $1', [address])
}

export async function pgDeleteAuthSessionsForCredential(address: string, credentialId: string, exceptHash: string) {
  await databasePool().query(
    `delete from kudiroll_auth_sessions where wallet_address = $1 and credential_id = $2 and ($3 = '' or token_hash <> $3)`,
    [address, credentialId, exceptHash],
  )
}

export async function pgSaveAuthChallenge(storageKey: string, keyHash: string, challenge: AuthChallenge) {
  await databasePool().query(
    `insert into kudiroll_auth_challenges (storage_key, purpose, key_hash, challenge, wallet_address, target_credential_id, prf_input, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (storage_key) do update set key_hash = excluded.key_hash, challenge = excluded.challenge, wallet_address = excluded.wallet_address,
       target_credential_id = excluded.target_credential_id, prf_input = excluded.prf_input, expires_at = excluded.expires_at`,
    [storageKey, challenge.purpose, keyHash, challenge.challenge, challenge.address, challenge.targetCredentialId, challenge.prfInput ?? null, challenge.expiresAt],
  )
}

export async function pgConsumeAuthChallenge(storageKey: string): Promise<AuthChallenge> {
  const result = await databasePool().query(
    `delete from kudiroll_auth_challenges where storage_key = $1
     returning purpose, challenge, wallet_address, target_credential_id, prf_input, expires_at`,
    [storageKey],
  )
  const row = result.rows[0]
  if (!row || Number(row.expires_at) <= Date.now()) throw Object.assign(new Error('This authentication request expired. Try again.'), { status: 401 })
  return { purpose: row.purpose, challenge: row.challenge, address: row.wallet_address, targetCredentialId: row.target_credential_id, ...(row.prf_input ? { prfInput: row.prf_input } : {}), expiresAt: Number(row.expires_at) }
}

export async function pgAuthStoreCounts() {
  const now = Date.now()
  await databasePool().query('delete from kudiroll_auth_sessions where expires_at <= $1', [now])
  await databasePool().query('delete from kudiroll_auth_challenges where expires_at <= $1', [now])
  const result = await databasePool().query(`select (select count(*) from kudiroll_auth_sessions) as sessions, (select count(*) from kudiroll_auth_challenges) as challenges`)
  return { sessions: Number(result.rows[0].sessions), challenges: Number(result.rows[0].challenges) }
}
