import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { TreasuryShieldRecord } from '../treasury-readiness'
import { persistenceConfig } from './database'
import { pgMutateAccountStore, pgReadAccountStore } from './account-postgres-store'

export type SavedWorker = {
  id: string
  name: string
  walletAddress: string
  defaultAmountUsdc: string
  createdAt: string
  updatedAt: string
}

export type SavedTeam = {
  id: string
  name: string
  description: string
  workers: SavedWorker[]
  createdAt: string
  updatedAt: string
}

export type SavedPayRunItem = {
  id: string
  workerId: string
  workerName: string
  walletAddress: string
  amountUsdc: string
  status: PayRunStatus
}

export type PayRunStatus = 'draft' | 'prepared' | 'submitting' | 'submitted' | 'finalized' | 'reverted' | 'unknown' | 'failed'

export type SavedPayRun = {
  id: string
  teamId: string
  teamName: string
  status: PayRunStatus
  totalUsdc: string
  items: SavedPayRunItem[]
  transactionHash: string
  submissionAttemptedAt: string
  finalityCheckedAt: string
  acceptedBlockNumber: number | null
  finalityMessage: string
  clientReference: string
  idempotencyKeyHash: string
  requestHash: string
  createdAt: string
  updatedAt: string
}

export type BusinessProfile = {
  ownerName: string
  businessName: string
  jobTitle: string
  email: string
  phone: string
  emailVerifiedAt: string
  updatedAt: string
}

export type SavedPasskey = {
  credentialId: string
  publicKey: string
  counter: number
  transports: string[]
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
  prfInput: string
  prfCapable: boolean
  createdAt: string
  lastUsedAt: string
}

export type EncryptedWalletBackup = {
  version: 2
  kdf: 'HKDF-SHA-256'
  cipher: 'AES-256-GCM'
  accountAddress: string
  signerProvider: 'argent-web-wallet'
  payloadIv: string
  ciphertext: string
  keySlots: { credentialId: string; prfInput: string; salt: string; iv: string; wrappedKey: string }[]
  updatedAt: string
}

export type AccountRecord = { walletAddress: string; profile: BusinessProfile; teams: SavedTeam[]; payRuns: SavedPayRun[]; treasuryShields: TreasuryShieldRecord[]; passkeys: SavedPasskey[]; encryptedWalletBackup: EncryptedWalletBackup | null; createdAt: string; updatedAt: string }
export type StoreFile = { version: 1; accounts: Record<string, AccountRecord> }

const storePath = resolve(process.env.KUDIROLL_DATA_FILE || '.data/kudiroll.json')
let queue = Promise.resolve()

function cleanText(value: unknown, maximum: number) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maximum)
}

function walletAddress(value: unknown) {
  const address = cleanText(value, 66).toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(address)) throw Object.assign(new Error('Enter a valid Starknet wallet address.'), { status: 400 })
  return address
}

function amount(value: unknown) {
  const text = cleanText(value, 32)
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || Number(text) <= 0) throw Object.assign(new Error('Enter a positive USDC amount with at most 6 decimals.'), { status: 400 })
  return text
}

function amountUnits(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

function emptyProfile(): BusinessProfile {
  return { ownerName: '', businessName: '', jobTitle: '', email: '', phone: '', emailVerifiedAt: '', updatedAt: '' }
}

async function readStore(): Promise<StoreFile> {
  if (persistenceConfig().accountBackend === 'postgres') return pgReadAccountStore()
  try {
    const parsed = JSON.parse(await readFile(storePath, 'utf8'))
    return parsed?.version === 1 && parsed?.accounts ? parsed : { version: 1, accounts: {} }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { version: 1, accounts: {} }
    throw error
  }
}

async function writeStore(store: StoreFile) {
  await mkdir(dirname(storePath), { recursive: true })
  const temporary = `${storePath}.tmp`
  await writeFile(temporary, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, storePath)
}

async function mutate<T>(operation: (store: StoreFile) => T | Promise<T>) {
  if (persistenceConfig().accountBackend === 'postgres') return pgMutateAccountStore(operation)
  let result!: T
  const next = queue.catch(() => undefined).then(async () => {
    const store = await readStore()
    result = await operation(store)
    await writeStore(store)
  })
  queue = next
  await next
  return result
}

function accountIn(store: StoreFile, address: string) {
  const key = walletAddress(address)
  const now = new Date().toISOString()
  const account = store.accounts[key] ?? (store.accounts[key] = { walletAddress: key, profile: emptyProfile(), teams: [], payRuns: [], treasuryShields: [], passkeys: [], encryptedWalletBackup: null, createdAt: now, updatedAt: now })
  account.profile ??= emptyProfile()
  account.profile.emailVerifiedAt ??= ''
  account.treasuryShields ??= []
  account.passkeys ??= []
  for (const passkey of account.passkeys) {
    passkey.prfInput ??= ''
    passkey.prfCapable = passkey.prfCapable === true && Boolean(passkey.prfInput)
  }
  account.encryptedWalletBackup ??= null
  for (const payRun of account.payRuns) {
    payRun.submissionAttemptedAt ??= ''
    payRun.finalityCheckedAt ??= ''
    payRun.acceptedBlockNumber ??= null
    payRun.finalityMessage ??= ''
    payRun.clientReference ??= ''
    payRun.idempotencyKeyHash ??= ''
    payRun.requestHash ??= ''
  }
  return account
}

function base64Url(value: unknown, label: string, maximum = 4096) {
  const text = cleanText(value, maximum)
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) throw Object.assign(new Error(`${label} is malformed.`), { status: 400 })
  return text
}

function validatedPrfInput(value: unknown) {
  const text = base64Url(value, 'Passkey PRF input', 128)
  const bytes = Buffer.from(text, 'base64url')
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== text) throw Object.assign(new Error('Passkey PRF input is malformed.'), { status: 400 })
  return text
}

export function publicAccount(account: AccountRecord) {
  return {
    walletAddress: account.walletAddress,
    profile: account.profile,
    teams: account.teams,
    payRuns: account.payRuns.map(publicPayRun),
    treasuryShields: account.treasuryShields,
    passkeys: account.passkeys.map(({ credentialId, deviceType, backedUp, prfCapable, createdAt, lastUsedAt }) => ({ credentialId, deviceType, backedUp, prfCapable, createdAt, lastUsedAt })),
    recoveryReady: account.passkeys.filter(passkey => passkey.prfCapable).length >= 2,
    encryptedWalletBackup: account.encryptedWalletBackup ? { available: true, updatedAt: account.encryptedWalletBackup.updatedAt } : null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }
}

export function publicPayRun(payRun: SavedPayRun) {
  const { idempotencyKeyHash: _idempotencyKeyHash, requestHash: _requestHash, ...view } = payRun
  return view
}

export async function savePasskey(address: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const credentialId = base64Url(input?.credentialId, 'Passkey credential ID', 1024)
    if (Object.values(store.accounts).some(candidate => candidate.walletAddress !== account.walletAddress && candidate.passkeys?.some(passkey => passkey.credentialId === credentialId))) {
      throw Object.assign(new Error('This passkey is already linked to another KudiRoll account.'), { status: 409 })
    }
    if (account.passkeys.some(passkey => passkey.credentialId === credentialId)) throw Object.assign(new Error('This passkey is already linked to this account.'), { status: 409 })
    const deviceType = input?.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice'
    const now = new Date().toISOString()
    const passkey: SavedPasskey = {
      credentialId,
      publicKey: base64Url(input?.publicKey, 'Passkey public key'),
      counter: Number.isSafeInteger(input?.counter) && input.counter >= 0 ? input.counter : 0,
      transports: Array.isArray(input?.transports) ? input.transports.map((value: unknown) => cleanText(value, 32)).filter(Boolean).slice(0, 8) : [],
      deviceType,
      backedUp: input?.backedUp === true,
      prfInput: input?.prfCapable === true ? validatedPrfInput(input?.prfInput) : '',
      prfCapable: input?.prfCapable === true,
      createdAt: now,
      lastUsedAt: '',
    }
    account.passkeys.push(passkey)
    account.updatedAt = now
    return passkey
  })
}

export async function updatePasskeyPrf(address: string, credentialId: string, prfInput: string) {
  return mutate(store => {
    const account = accountIn(store, address)
    const passkey = account.passkeys.find(candidate => candidate.credentialId === base64Url(credentialId, 'Passkey credential ID', 1024))
    if (!passkey) throw Object.assign(new Error('Passkey not found.'), { status: 404 })
    const nextPrfInput = validatedPrfInput(prfInput)
    const vaultSlot = account.encryptedWalletBackup?.keySlots.find(slot => slot.credentialId === passkey.credentialId)
    if (vaultSlot && vaultSlot.prfInput !== nextPrfInput) throw Object.assign(new Error('The passkey PRF input cannot change while an encrypted wallet backup uses it.'), { status: 409 })
    passkey.prfInput = nextPrfInput
    passkey.prfCapable = true
    account.updatedAt = new Date().toISOString()
    return passkey
  })
}

export async function findPasskey(credentialId: string) {
  const id = base64Url(credentialId, 'Passkey credential ID', 1024)
  const store = await readStore()
  for (const account of Object.values(store.accounts)) {
    const passkey = account.passkeys?.find(candidate => candidate.credentialId === id)
    if (passkey) return { walletAddress: account.walletAddress, passkey }
  }
  return null
}

export async function updatePasskeyCounter(address: string, credentialId: string, counter: number) {
  return mutate(store => {
    const account = accountIn(store, address)
    const passkey = account.passkeys.find(candidate => candidate.credentialId === credentialId)
    if (!passkey) throw Object.assign(new Error('Passkey not found.'), { status: 404 })
    if (!Number.isSafeInteger(counter) || counter < passkey.counter) throw Object.assign(new Error('Passkey counter rollback rejected.'), { status: 409 })
    passkey.counter = counter
    passkey.lastUsedAt = new Date().toISOString()
    account.updatedAt = passkey.lastUsedAt
    return passkey
  })
}

export async function removePasskey(address: string, credentialId: string) {
  return mutate(store => {
    const account = accountIn(store, address)
    const normalizedCredentialId = base64Url(credentialId, 'Passkey credential ID', 1024)
    const index = account.passkeys.findIndex(candidate => candidate.credentialId === normalizedCredentialId)
    if (index < 0) throw Object.assign(new Error('Passkey not found.'), { status: 404 })
    if (account.passkeys.length <= 2) throw Object.assign(new Error('Add a third passkey before revoking one; KudiRoll keeps two recovery credentials available.'), { status: 409 })
    if (account.passkeys[index].prfCapable && account.passkeys.filter(passkey => passkey.prfCapable).length <= 2) throw Object.assign(new Error('Verify another PRF-capable recovery passkey before revoking this one.'), { status: 409 })
    if (account.encryptedWalletBackup?.keySlots.some(slot => slot.credentialId === normalizedCredentialId)) {
      if (account.encryptedWalletBackup.keySlots.length <= 2) throw Object.assign(new Error('Add this recovery passkey to the encrypted wallet vault before revoking another wallet passkey.'), { status: 409 })
      account.encryptedWalletBackup.keySlots = account.encryptedWalletBackup.keySlots.filter(slot => slot.credentialId !== normalizedCredentialId)
      account.encryptedWalletBackup.updatedAt = new Date().toISOString()
    }
    const [removed] = account.passkeys.splice(index, 1)
    account.updatedAt = new Date().toISOString()
    return { credentialId: removed.credentialId }
  })
}

export async function saveEncryptedWalletBackup(address: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    if (input?.version !== 2 || input?.kdf !== 'HKDF-SHA-256' || input?.cipher !== 'AES-256-GCM' || input?.signerProvider !== 'argent-web-wallet') throw Object.assign(new Error('This encrypted wallet vault version is unsupported.'), { status: 400 })
    const vaultAddress = walletAddress(input?.accountAddress)
    if (vaultAddress !== account.walletAddress) throw Object.assign(new Error('The encrypted wallet vault belongs to a different Starknet account.'), { status: 409 })
    if (!Array.isArray(input?.keySlots) || input.keySlots.length < 2 || input.keySlots.length > 12) throw Object.assign(new Error('The encrypted wallet vault must contain two to twelve recovery passkey slots.'), { status: 400 })
    const slotIds = new Set<string>()
    const keySlots = input.keySlots.map((slot: any) => {
      const credentialId = base64Url(slot?.credentialId, 'Vault passkey credential ID', 1024)
      if (slotIds.has(credentialId)) throw Object.assign(new Error('The encrypted wallet vault contains duplicate passkey slots.'), { status: 400 })
      const passkey = account.passkeys.find(candidate => candidate.credentialId === credentialId)
      if (!passkey?.prfCapable) throw Object.assign(new Error('Every wallet vault slot must belong to a PRF-verified account passkey.'), { status: 409 })
      const slotPrfInput = validatedPrfInput(slot?.prfInput)
      if (slotPrfInput !== passkey.prfInput) throw Object.assign(new Error('The wallet vault PRF input does not match its active passkey.'), { status: 409 })
      slotIds.add(credentialId)
      return { credentialId, prfInput: slotPrfInput, salt: base64Url(slot?.salt, 'Vault slot salt', 128), iv: base64Url(slot?.iv, 'Vault slot IV', 128), wrappedKey: base64Url(slot?.wrappedKey, 'Vault wrapped key', 256) }
    })
    const now = new Date().toISOString()
    account.encryptedWalletBackup = {
      version: 2,
      kdf: 'HKDF-SHA-256',
      cipher: 'AES-256-GCM',
      accountAddress: vaultAddress,
      signerProvider: 'argent-web-wallet',
      payloadIv: base64Url(input?.payloadIv, 'Vault payload IV', 128),
      ciphertext: base64Url(input?.ciphertext, 'Vault ciphertext', 16384),
      keySlots,
      updatedAt: now,
    }
    account.updatedAt = now
    return { available: true, updatedAt: now }
  })
}

export async function getEncryptedWalletBackup(address: string) {
  return (await getAccount(address)).encryptedWalletBackup
}

export async function recordTreasuryShield(address: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const transactionHash = cleanText(input?.transactionHash, 80).toLowerCase()
    if (!/^0x[0-9a-f]{1,64}$/.test(transactionHash)) throw Object.assign(new Error('A valid Starknet transaction hash is required.'), { status: 400 })
    const existing = account.treasuryShields.find(item => item.transactionHash === transactionHash)
    if (existing) return existing
    const shield: TreasuryShieldRecord = { transactionHash, amountUsdc: amount(input?.amountUsdc), submittedAt: new Date().toISOString() }
    account.treasuryShields.unshift(shield)
    account.treasuryShields = account.treasuryShields.slice(0, 20)
    account.updatedAt = shield.submittedAt
    return shield
  })
}

export async function getAccount(address: string) {
  const store = await readStore()
  return accountIn(store, address)
}

export async function updateBusinessProfile(address: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const ownerName = cleanText(input?.ownerName, 80)
    const businessName = cleanText(input?.businessName, 100)
    const jobTitle = cleanText(input?.jobTitle, 80)
    const email = cleanText(input?.email, 160).toLowerCase()
    const phone = cleanText(input?.phone, 24)
    if (ownerName.length < 2) throw Object.assign(new Error('Enter the account owner’s full name.'), { status: 400 })
    if (businessName.length < 2) throw Object.assign(new Error('Enter the business name.'), { status: 400 })
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid business email address.'), { status: 400 })
    if (phone && !/^\+?[0-9 ()-]{7,24}$/.test(phone)) throw Object.assign(new Error('Enter a valid phone number.'), { status: 400 })
    const now = new Date().toISOString()
    const emailVerifiedAt = email === account.profile.email ? account.profile.emailVerifiedAt : ''
    account.profile = { ownerName, businessName, jobTitle, email, phone, emailVerifiedAt, updatedAt: now }
    account.updatedAt = now
    return account.profile
  })
}

export async function markBusinessEmailVerified(address: string, email: string) {
  return mutate(store => {
    const account = accountIn(store, address)
    const candidate = cleanText(email, 160).toLowerCase()
    if (!candidate || candidate !== account.profile.email) throw Object.assign(new Error('The verification email no longer matches this business profile.'), { status: 409 })
    account.profile.emailVerifiedAt = new Date().toISOString()
    account.profile.updatedAt = account.profile.emailVerifiedAt
    account.updatedAt = account.profile.emailVerifiedAt
    return account.profile
  })
}

export async function deleteAccount(address: string) {
  return mutate(store => {
    const key = walletAddress(address)
    const account = store.accounts[key]
    const deleted = { teams: account?.teams.length ?? 0, payRuns: account?.payRuns.length ?? 0 }
    delete store.accounts[key]
    return deleted
  })
}

export async function createTeam(address: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const name = cleanText(input?.name, 60)
    if (name.length < 2) throw Object.assign(new Error('Team name must contain at least 2 characters.'), { status: 400 })
    if (account.teams.some(team => team.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('A team with this name already exists.'), { status: 409 })
    const now = new Date().toISOString()
    const team: SavedTeam = { id: randomUUID(), name, description: cleanText(input?.description, 160), workers: [], createdAt: now, updatedAt: now }
    account.teams.unshift(team)
    account.updatedAt = now
    return team
  })
}

export async function updateTeam(address: string, teamId: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const team = account.teams.find(item => item.id === teamId)
    if (!team) throw Object.assign(new Error('Team not found.'), { status: 404 })
    const name = cleanText(input?.name, 60)
    if (name.length < 2) throw Object.assign(new Error('Team name must contain at least 2 characters.'), { status: 400 })
    if (account.teams.some(item => item.id !== team.id && item.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('A team with this name already exists.'), { status: 409 })
    team.name = name
    team.description = cleanText(input?.description, 160)
    team.updatedAt = new Date().toISOString()
    account.updatedAt = team.updatedAt
    return team
  })
}

export async function deleteTeam(address: string, teamId: string) {
  return mutate(store => {
    const account = accountIn(store, address)
    const before = account.teams.length
    account.teams = account.teams.filter(team => team.id !== teamId)
    if (account.teams.length === before) throw Object.assign(new Error('Team not found.'), { status: 404 })
    account.updatedAt = new Date().toISOString()
    return { id: teamId }
  })
}

export async function addWorker(address: string, teamId: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const team = account.teams.find(item => item.id === teamId)
    if (!team) throw Object.assign(new Error('Team not found.'), { status: 404 })
    const name = cleanText(input?.name, 80)
    const workerWallet = walletAddress(input?.walletAddress)
    if (name.length < 2) throw Object.assign(new Error('Worker name must contain at least 2 characters.'), { status: 400 })
    if (team.workers.some(worker => worker.walletAddress === workerWallet)) throw Object.assign(new Error('This wallet is already in the team.'), { status: 409 })
    const now = new Date().toISOString()
    const worker: SavedWorker = { id: randomUUID(), name, walletAddress: workerWallet, defaultAmountUsdc: amount(input?.defaultAmountUsdc), createdAt: now, updatedAt: now }
    team.workers.push(worker)
    team.updatedAt = now
    account.updatedAt = now
    return worker
  })
}

export async function removeWorker(address: string, teamId: string, workerId: string) {
  return mutate(store => {
    const account = accountIn(store, address)
    const team = account.teams.find(item => item.id === teamId)
    if (!team) throw Object.assign(new Error('Team not found.'), { status: 404 })
    const before = team.workers.length
    team.workers = team.workers.filter(worker => worker.id !== workerId)
    if (team.workers.length === before) throw Object.assign(new Error('Worker not found.'), { status: 404 })
    team.updatedAt = new Date().toISOString()
    account.updatedAt = team.updatedAt
    return { id: workerId }
  })
}

export async function createPayRun(address: string, input: any, idempotencyKey = '') {
  return mutate(store => {
    const account = accountIn(store, address)
    const teamId = cleanText(input?.teamId, 64)
    const clientReference = cleanText(input?.clientReference, 100)
    const requested = Array.isArray(input?.items) ? input.items : []
    const normalizedRequest = { teamId, clientReference, items: requested.map((item: any) => ({ workerId: cleanText(item?.workerId, 64), amountUsdc: cleanText(item?.amountUsdc, 32) })) }
    const requestHash = createHash('sha256').update(JSON.stringify(normalizedRequest)).digest('hex')
    const normalizedIdempotencyKey = cleanText(idempotencyKey, 128)
    const idempotencyKeyHash = normalizedIdempotencyKey ? createHash('sha256').update(normalizedIdempotencyKey).digest('hex') : ''
    if (idempotencyKeyHash) {
      const existing = account.payRuns.find(item => item.idempotencyKeyHash === idempotencyKeyHash)
      if (existing) {
        if (existing.requestHash !== requestHash) throw Object.assign(new Error('This idempotency key was already used for a different pay run.'), { status: 409 })
        return existing
      }
    }
    if (account.payRuns.some(item => item.status === 'submitting' || item.status === 'unknown')) throw Object.assign(new Error('Resolve the existing unknown payroll submission before creating another pay run.'), { status: 409 })
    const team = account.teams.find(item => item.id === teamId)
    if (!team) throw Object.assign(new Error('Select a saved team.'), { status: 404 })
    if (!requested.length) throw Object.assign(new Error('Select at least one worker.'), { status: 400 })
    const workerIds = requested.map((item: any) => cleanText(item?.workerId, 64))
    if (new Set(workerIds).size !== workerIds.length) throw Object.assign(new Error('Each worker can appear only once in a pay run.'), { status: 400 })
    const items: SavedPayRunItem[] = requested.map((item: any): SavedPayRunItem => {
      const worker = team.workers.find(candidate => candidate.id === cleanText(item?.workerId, 64))
      if (!worker) throw Object.assign(new Error('A selected worker is no longer in this team.'), { status: 400 })
      return { id: randomUUID(), workerId: worker.id, workerName: worker.name, walletAddress: worker.walletAddress, amountUsdc: amount(item?.amountUsdc), status: 'draft' }
    })
    const total = items.reduce((sum: bigint, item: SavedPayRunItem) => sum + amountUnits(item.amountUsdc), 0n)
    const now = new Date().toISOString()
    const payRun: SavedPayRun = { id: randomUUID(), teamId: team.id, teamName: team.name, status: 'draft', totalUsdc: `${total / 1_000_000n}.${(total % 1_000_000n).toString().padStart(6, '0')}`.replace(/\.?0+$/, ''), items, transactionHash: '', submissionAttemptedAt: '', finalityCheckedAt: '', acceptedBlockNumber: null, finalityMessage: '', clientReference, idempotencyKeyHash, requestHash, createdAt: now, updatedAt: now }
    account.payRuns.unshift(payRun)
    account.updatedAt = now
    return payRun
  })
}

export async function updatePayRun(address: string, payRunId: string, input: any) {
  return mutate(store => {
    const account = accountIn(store, address)
    const payRun = account.payRuns.find(item => item.id === payRunId)
    if (!payRun) throw Object.assign(new Error('Pay run not found.'), { status: 404 })
    const status = cleanText(input?.status, 24)
    if (!['prepared', 'submitting', 'submitted', 'unknown', 'failed'].includes(status)) throw Object.assign(new Error('Invalid pay-run status.'), { status: 400 })
    const transitions: Record<SavedPayRun['status'], SavedPayRun['status'][]> = {
      draft: ['prepared', 'failed'],
      prepared: ['prepared', 'submitting', 'failed'],
      submitting: ['submitted', 'unknown', 'failed'],
      unknown: ['submitted', 'unknown'],
      failed: ['prepared', 'failed'],
      submitted: ['submitted'],
      finalized: [],
      reverted: [],
    }
    if (!transitions[payRun.status].includes(status as SavedPayRun['status'])) {
      throw Object.assign(new Error(`A ${payRun.status} pay run cannot move directly to ${status}.`), { status: 409 })
    }
    const transactionHash = cleanText(input?.transactionHash, 80).toLowerCase()
    if (status === 'submitted' && !/^0x[0-9a-fA-F]{1,64}$/.test(transactionHash)) throw Object.assign(new Error('A transaction hash is required for a submitted pay run.'), { status: 400 })
    if (transactionHash && !/^0x[0-9a-fA-F]{1,64}$/.test(transactionHash)) throw Object.assign(new Error('Invalid transaction hash.'), { status: 400 })
    if (transactionHash && account.payRuns.some(item => item.id !== payRun.id && item.transactionHash.toLowerCase() === transactionHash)) throw Object.assign(new Error('This transaction hash is already attached to another pay run.'), { status: 409 })
    if (payRun.transactionHash && transactionHash && payRun.transactionHash !== transactionHash) throw Object.assign(new Error('A pay run cannot change its recovered transaction hash.'), { status: 409 })
    payRun.status = status as SavedPayRun['status']
    if ((status === 'submitted' || status === 'unknown') && transactionHash) payRun.transactionHash = transactionHash
    if (status === 'submitting') payRun.submissionAttemptedAt = new Date().toISOString()
    if (status === 'unknown') payRun.finalityMessage = 'Wallet submission outcome is unknown. Do not retry this payroll until its transaction is recovered or ruled out.'
    payRun.items = payRun.items.map(item => ({ ...item, status: status as SavedPayRunItem['status'] }))
    payRun.updatedAt = new Date().toISOString()
    account.updatedAt = payRun.updatedAt
    return payRun
  })
}

export async function recordPayRunFinality(address: string, payRunId: string, input: { status: 'finalized' | 'reverted' | 'unknown'; acceptedBlockNumber?: number; message: string }) {
  return mutate(store => {
    const account = accountIn(store, address)
    const payRun = account.payRuns.find(item => item.id === payRunId)
    if (!payRun) throw Object.assign(new Error('Pay run not found.'), { status: 404 })
    if (!payRun.transactionHash) throw Object.assign(new Error('This pay run has no transaction hash to verify.'), { status: 409 })
    const transitions: Record<PayRunStatus, Array<'finalized' | 'reverted' | 'unknown'>> = {
      draft: [],
      prepared: [],
      submitting: [],
      failed: [],
      submitted: ['finalized', 'reverted', 'unknown'],
      unknown: ['finalized', 'reverted', 'unknown'],
      finalized: ['finalized'],
      reverted: ['reverted'],
    }
    if (!transitions[payRun.status].includes(input.status)) throw Object.assign(new Error(`A ${payRun.status} pay run cannot be recorded as ${input.status}.`), { status: 409 })
    const acceptedBlockNumber = input.acceptedBlockNumber
    if (acceptedBlockNumber !== undefined && (!Number.isSafeInteger(acceptedBlockNumber) || acceptedBlockNumber < 0)) throw Object.assign(new Error('Invalid accepted block number.'), { status: 400 })
    payRun.status = input.status
    payRun.items = payRun.items.map(item => ({ ...item, status: input.status }))
    payRun.acceptedBlockNumber = acceptedBlockNumber ?? payRun.acceptedBlockNumber
    payRun.finalityCheckedAt = new Date().toISOString()
    payRun.finalityMessage = cleanText(input.message, 240)
    payRun.updatedAt = payRun.finalityCheckedAt
    account.updatedAt = payRun.updatedAt
    return payRun
  })
}

export async function resolveUnknownPayRun(address: string, payRunId: string, confirmation: unknown) {
  return mutate(store => {
    const account = accountIn(store, address)
    const payRun = account.payRuns.find(item => item.id === payRunId)
    if (!payRun) throw Object.assign(new Error('Pay run not found.'), { status: 404 })
    if (payRun.status !== 'unknown' || payRun.transactionHash) throw Object.assign(new Error('Only an unknown submission without a recovered transaction hash can be released.'), { status: 409 })
    if (cleanText(confirmation, 64) !== 'NO TRANSACTION IN READY') throw Object.assign(new Error('Type NO TRANSACTION IN READY after checking Ready activity.'), { status: 400 })
    payRun.status = 'failed'
    payRun.items = payRun.items.map(item => ({ ...item, status: 'failed' }))
    payRun.finalityCheckedAt = new Date().toISOString()
    payRun.finalityMessage = 'The account owner confirmed after fresh authentication that Ready showed no submitted transaction. A new payroll may now be prepared.'
    payRun.updatedAt = payRun.finalityCheckedAt
    account.updatedAt = payRun.updatedAt
    return payRun
  })
}
