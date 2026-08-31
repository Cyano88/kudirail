import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { RpcProvider, constants } from 'starknet'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server'
import { addWorker, createPayRun, createTeam, deleteAccount, deleteTeam, findPasskey, findVerifiedAccountByEmail, getAccount, getEncryptedWalletBackup, linkVerifiedBusinessEmail, markBusinessEmailVerified, publicAccount, publicPayRun, recordTreasuryShield, removePasskey, removeWorker, resolveUnknownPayRun, saveEncryptedWalletBackup, savePasskey, updateBusinessProfile, updatePasskeyCounter, updatePasskeyPrf, updatePayRun, updatePayrollPolicy, updateTeam } from './account-store'
import { consumeAuthChallenge, createAuthSession, deleteAuthSession, deleteAuthSessionsForAddress, deleteAuthSessionsForCredential, getAuthSession, saveAuthChallenge } from './auth-store'
import { deriveTreasuryReadiness } from '../treasury-readiness'
import { rateLimit } from './rate-limit'
import { verifyPayRunFinality } from './pay-run-finality-service'

function statusOf(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) return Number(error.status) || 500
  return 500
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected account failure.'
}

function addressOf(value: unknown) {
  const address = String(value ?? '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(address)) throw Object.assign(new Error('A valid Starknet wallet address is required.'), { status: 400 })
  return address
}

function cookies(value = '') {
  return Object.fromEntries(value.split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2))
}

function sessionCookieName() {
  return process.env.NODE_ENV === 'production' ? '__Host-kudiroll_session' : 'kudiroll_session'
}

function challengeCookieName() {
  return process.env.NODE_ENV === 'production' ? '__Secure-kudiroll_webauthn' : 'kudiroll_webauthn'
}

function emailLinkCookieName() {
  return process.env.NODE_ENV === 'production' ? '__Secure-kudiroll_email_link' : 'kudiroll_email_link'
}

function sessionToken(req: any) {
  const parsed = cookies(req.headers.cookie)
  return parsed[sessionCookieName()] || parsed.kudiroll_session || ''
}

function challengeToken(req: any) {
  const parsed = cookies(req.headers.cookie)
  return parsed[challengeCookieName()] || parsed.kudiroll_webauthn || ''
}

function emailLinkToken(req: any) {
  const parsed = cookies(req.headers.cookie)
  return parsed[emailLinkCookieName()] || parsed.kudiroll_email_link || ''
}

function sessionCookie(token: string, maxAge = 43200) {
  return `${sessionCookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

function challengeCookie(token: string, maxAge = 300) {
  return `${challengeCookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/api/account; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

function emailLinkCookie(token: string, maxAge = 600) {
  return `${emailLinkCookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/api/account/email/link; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

function webauthnSettings(req: any) {
  if (process.env.NODE_ENV === 'production') {
    const origin = process.env.KUDIROLL_WEBAUTHN_ORIGIN?.trim() || 'https://kudiroll-production.up.railway.app'
    return { origin, rpID: process.env.KUDIROLL_WEBAUTHN_RP_ID?.trim() || new URL(origin).hostname }
  }
  const candidate = String(req.headers.origin || '')
  const origin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(candidate) ? candidate : 'http://localhost:4173'
  return { origin, rpID: new URL(origin).hostname }
}

function emailDeliverySettings() {
  const apiKey = process.env.RESEND_API_KEY?.trim() || ''
  const from = process.env.KUDIROLL_EMAIL_FROM?.trim() || ''
  const codeSecret = process.env.KUDIROLL_EMAIL_CODE_SECRET?.trim() || ''
  return { apiKey, from, codeSecret, configured: Boolean(apiKey && from && codeSecret.length >= 32) }
}

function emailCodeHash(code: string, secret: string) {
  return createHmac('sha256', secret).update(code).digest('base64url')
}

function normalizedEmail(value: unknown) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 })
  return email
}

async function deliverEmailCode(email: string, code: string, settings: ReturnType<typeof emailDeliverySettings>, fetcher: typeof fetch) {
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomBytes(16).toString('hex') },
    body: JSON.stringify({ from: settings.from, to: [email], subject: 'Your KudiRoll sign-in code', text: `Your KudiRoll code is ${code}. It expires in 10 minutes. This code signs you in but cannot sign transactions, decrypt your embedded wallet, or recover funds.` }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw Object.assign(new Error('The sign-in email could not be delivered.'), { status: 502 })
}

async function requireSession(req: any) {
  const token = sessionToken(req)
  const session = await getAuthSession(token)
  if (!session) throw Object.assign(new Error('Your KudiRoll session has expired. Sign in again.'), { status: 401 })
  return { token, session }
}

export async function requireRecentSession(req: any, method?: 'wallet' | 'passkey') {
  const current = await requireSession(req)
  if (Date.now() - current.session.authenticatedAt > 5 * 60 * 1000) throw Object.assign(new Error('Fresh authentication is required. Sign out and sign in again.'), { status: 401 })
  if (method && current.session.method !== method) throw Object.assign(new Error(`Fresh ${method} authentication is required.`), { status: 401 })
  return current
}

export async function requireSessionAddress(req: any) {
  return (await requireSession(req)).session.address
}

function typedChallenge(address: string, nonce: string, issuedAt: number, expiresAt: number) {
  return {
    types: {
      StarkNetDomain: [
        { name: 'name', type: 'felt' },
        { name: 'version', type: 'felt' },
        { name: 'chainId', type: 'felt' },
      ],
      KudiRollSession: [
        { name: 'wallet', type: 'felt' },
        { name: 'nonce', type: 'felt' },
        { name: 'issued_at', type: 'felt' },
        { name: 'expires_at', type: 'felt' },
      ],
    },
    primaryType: 'KudiRollSession',
    domain: { name: 'KudiRoll', version: '1', chainId: constants.StarknetChainId.SN_MAIN },
    message: { wallet: address, nonce, issued_at: String(issuedAt), expires_at: String(expiresAt) },
  }
}

function provider() {
  const nodeUrl = process.env.STARKNET_RPC_URL?.trim()
  return nodeUrl
    ? new RpcProvider({ nodeUrl })
    : new RpcProvider({ nodeUrl: constants.NetworkName.SN_MAIN })
}

async function treasuryReadiness(address: string) {
  const account = await getAccount(address)
  const shield = account.treasuryShields[0] ?? null
  if (!shield) return deriveTreasuryReadiness(null, { outcome: 'pending' })
  try {
    const rpc = provider()
    const receipt = await rpc.getTransactionReceipt(shield.transactionHash)
    if (receipt.isError()) return deriveTreasuryReadiness(shield, { outcome: 'unknown' })
    const value = receipt.value as { block_number?: number }
    if (receipt.isReverted()) return deriveTreasuryReadiness(shield, { outcome: 'reverted', acceptedBlockNumber: value.block_number })
    const acceptedBlockNumber = value.block_number
    if (acceptedBlockNumber === undefined) return deriveTreasuryReadiness(shield, { outcome: 'pending' })
    return deriveTreasuryReadiness(shield, { outcome: 'succeeded', acceptedBlockNumber, currentBlockNumber: await rpc.getBlockNumber() })
  } catch (error: any) {
    const message = String(error?.message || error)
    return deriveTreasuryReadiness(shield, { outcome: /not found|transaction hash not found|code.?29/i.test(message) ? 'pending' : 'unknown' })
  }
}

export function createAccountRouter(options: { emailFetcher?: typeof fetch } = {}) {
  const router = Router()
  const emailFetcher = options.emailFetcher || fetch
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  router.post('/challenge', rateLimit('wallet-challenge'), async (req, res) => {
    try {
      const address = addressOf(req.body?.address)
      const nonce = `0x${randomBytes(24).toString('hex')}`
      const issuedAt = Math.floor(Date.now() / 1000)
      const expiresAt = issuedAt + 5 * 60
      const typedData = typedChallenge(address, nonce, issuedAt, expiresAt)
      await saveAuthChallenge(nonce, { purpose: 'wallet-signin', challenge: JSON.stringify(typedData), address, targetCredentialId: '', expiresAt: expiresAt * 1000 })
      res.json({ ok: true, challenge: { nonce, typedData } })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/session', rateLimit('wallet-session'), async (req, res) => {
    try {
      const address = addressOf(req.body?.address)
      const nonce = String(req.body?.nonce || '')
      const signature = Array.isArray(req.body?.signature) ? req.body.signature.map(String) : []
      const challenge = await consumeAuthChallenge(nonce, 'wallet-signin')
      if (challenge.address !== address) throw Object.assign(new Error('This sign-in request does not match the wallet.'), { status: 401 })
      if (!signature.length) throw Object.assign(new Error('Wallet signature is required.'), { status: 400 })
      const valid = await provider().verifyMessageInStarknet(JSON.parse(challenge.challenge), signature, address)
      if (!valid) throw Object.assign(new Error('The wallet signature could not be verified.'), { status: 401 })
      const token = await createAuthSession(address, 'wallet')
      res.setHeader('Set-Cookie', sessionCookie(token))
      res.json({ ok: true, account: publicAccount(await getAccount(address)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.delete('/session', async (req, res) => {
    try {
      await deleteAuthSession(sessionToken(req))
      res.setHeader('Set-Cookie', sessionCookie('', 0))
      res.json({ ok: true })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.get('/me', async (req, res) => {
    try {
      res.json({ ok: true, account: publicAccount(await getAccount(await requireSessionAddress(req))) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/registration/options', rateLimit('passkey-register-options', 10), async (req, res) => {
    try {
      const { token, session } = await requireRecentSession(req)
      const address = session.address
      const account = await getAccount(address)
      const { rpID } = webauthnSettings(req)
      const options = await generateRegistrationOptions({
        rpName: 'KudiRoll',
        rpID,
        userID: createHash('sha256').update(address).digest(),
        userName: `KudiRoll ${address.slice(0, 8)}`,
        attestationType: 'none',
        excludeCredentials: account.passkeys.map(passkey => ({ id: passkey.credentialId, transports: passkey.transports as any })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      })
      const prfInput = randomBytes(32).toString('base64url')
      await saveAuthChallenge(token, { purpose: 'passkey-register', challenge: options.challenge, address, targetCredentialId: '', prfInput, expiresAt: Date.now() + 5 * 60 * 1000 })
      res.json({ ok: true, options, prfInput })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/registration/verify', rateLimit('passkey-register-verify', 10), async (req, res) => {
    try {
      const { token, session } = await requireSession(req)
      const address = session.address
      const stored = await consumeAuthChallenge(token, 'passkey-register')
      if (stored.address !== address) throw Object.assign(new Error('This passkey request does not match the account.'), { status: 401 })
      const expectedChallenge = stored.challenge
      const { origin, rpID } = webauthnSettings(req)
      const response = req.body?.response as RegistrationResponseJSON
      const verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true })
      if (!verification.verified || !verification.registrationInfo) throw Object.assign(new Error('The passkey could not be verified.'), { status: 401 })
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
      await savePasskey(address, {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: response?.response?.transports || [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        prfInput: stored.prfInput,
        prfCapable: req.body?.prfCapable === true,
      })
      await deleteAuthSession(token)
      const replacement = await createAuthSession(address, 'passkey', credential.id)
      res.append('Set-Cookie', sessionCookie(replacement))
      res.status(201).json({ ok: true, account: publicAccount(await getAccount(address)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/prf/options', rateLimit('passkey-prf-options', 10), async (req, res) => {
    try {
      const { session } = await requireRecentSession(req)
      const account = await getAccount(session.address)
      const targetCredentialId = String(req.body?.credentialId || '')
      const passkey = account.passkeys.find(candidate => candidate.credentialId === targetCredentialId)
      if (!passkey) throw Object.assign(new Error('Passkey not found.'), { status: 404 })
      const { rpID } = webauthnSettings(req)
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: [{ id: passkey.credentialId, transports: passkey.transports as any }],
      })
      const requestId = randomBytes(32).toString('base64url')
      const prfInput = passkey.prfInput || randomBytes(32).toString('base64url')
      await saveAuthChallenge(requestId, { purpose: 'passkey-prf', challenge: options.challenge, address: session.address, targetCredentialId, prfInput, expiresAt: Date.now() + 5 * 60 * 1000 })
      res.setHeader('Set-Cookie', challengeCookie(requestId))
      res.json({ ok: true, options, prfInput })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/prf/verify', rateLimit('passkey-prf-verify', 10), async (req, res) => {
    try {
      const current = await requireSession(req)
      const stored = await consumeAuthChallenge(challengeToken(req), 'passkey-prf')
      res.setHeader('Set-Cookie', challengeCookie('', 0))
      if (stored.address !== current.session.address) throw Object.assign(new Error('This private-wallet recovery request does not match the account.'), { status: 401 })
      const response = req.body?.response as AuthenticationResponseJSON
      if (response?.id !== stored.targetCredentialId) throw Object.assign(new Error('Use the selected passkey for this recovery check.'), { status: 401 })
      const match = await findPasskey(response.id)
      if (!match || match.walletAddress !== stored.address) throw Object.assign(new Error('This passkey is not linked to the account.'), { status: 401 })
      const { origin, rpID } = webauthnSettings(req)
      const credential: WebAuthnCredential = {
        id: match.passkey.credentialId,
        publicKey: Uint8Array.from(Buffer.from(match.passkey.publicKey, 'base64url')),
        counter: match.passkey.counter,
        transports: match.passkey.transports as any,
      }
      const verification = await verifyAuthenticationResponse({ response, expectedChallenge: stored.challenge, expectedOrigin: origin, expectedRPID: rpID, credential, requireUserVerification: true })
      if (!verification.verified) throw Object.assign(new Error('The passkey could not be verified.'), { status: 401 })
      await updatePasskeyCounter(match.walletAddress, match.passkey.credentialId, verification.authenticationInfo.newCounter)
      if (req.body?.prfCapable !== true || !stored.prfInput) throw Object.assign(new Error('This passkey does not provide the WebAuthn PRF required for private-wallet recovery.'), { status: 409 })
      await updatePasskeyPrf(match.walletAddress, match.passkey.credentialId, stored.prfInput)
      res.json({ ok: true, account: publicAccount(await getAccount(match.walletAddress)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/authentication/options', rateLimit('passkey-auth-options'), async (req, res) => {
    try {
      const { rpID } = webauthnSettings(req)
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] })
      const requestId = randomBytes(32).toString('base64url')
      await saveAuthChallenge(requestId, { purpose: 'passkey-signin', challenge: options.challenge, address: '', targetCredentialId: '', expiresAt: Date.now() + 5 * 60 * 1000 })
      res.setHeader('Set-Cookie', challengeCookie(requestId))
      res.json({ ok: true, options })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/authentication/verify', rateLimit('passkey-auth-verify'), async (req, res) => {
    try {
      const requestId = challengeToken(req)
      const expectedChallenge = (await consumeAuthChallenge(requestId, 'passkey-signin')).challenge
      res.setHeader('Set-Cookie', challengeCookie('', 0))
      const response = req.body?.response as AuthenticationResponseJSON
      const match = await findPasskey(response?.id)
      if (!match) throw Object.assign(new Error('This passkey is not linked to a KudiRoll account.'), { status: 401 })
      const { origin, rpID } = webauthnSettings(req)
      const credential: WebAuthnCredential = {
        id: match.passkey.credentialId,
        publicKey: Uint8Array.from(Buffer.from(match.passkey.publicKey, 'base64url')),
        counter: match.passkey.counter,
        transports: match.passkey.transports as any,
      }
      const verification = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential, requireUserVerification: true })
      if (!verification.verified) throw Object.assign(new Error('The passkey could not be verified.'), { status: 401 })
      await updatePasskeyCounter(match.walletAddress, match.passkey.credentialId, verification.authenticationInfo.newCounter)
      const token = await createAuthSession(match.walletAddress, 'passkey', match.passkey.credentialId)
      res.append('Set-Cookie', sessionCookie(token))
      res.json({ ok: true, account: publicAccount(await getAccount(match.walletAddress)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/revocation/options', rateLimit('passkey-revoke-options', 10), async (req, res) => {
    try {
      const { session } = await requireSession(req)
      const account = await getAccount(session.address)
      const targetCredentialId = String(req.body?.credentialId || '')
      const targetPasskey = account.passkeys.find(passkey => passkey.credentialId === targetCredentialId)
      if (!targetPasskey) throw Object.assign(new Error('Passkey not found.'), { status: 404 })
      if (account.passkeys.length <= 2) throw Object.assign(new Error('Add a third passkey before revoking one; KudiRoll keeps two recovery credentials available.'), { status: 409 })
      if (targetPasskey.prfCapable && account.passkeys.filter(passkey => passkey.prfCapable).length <= 2) throw Object.assign(new Error('Verify another PRF-capable recovery passkey before revoking this one.'), { status: 409 })
      const { rpID } = webauthnSettings(req)
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: account.passkeys.filter(passkey => passkey.credentialId !== targetCredentialId).map(passkey => ({ id: passkey.credentialId, transports: passkey.transports as any })),
      })
      const requestId = randomBytes(32).toString('base64url')
      await saveAuthChallenge(requestId, { purpose: 'passkey-revoke', challenge: options.challenge, address: session.address, targetCredentialId, expiresAt: Date.now() + 5 * 60 * 1000 })
      res.setHeader('Set-Cookie', challengeCookie(requestId))
      res.json({ ok: true, options })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/passkeys/revocation/verify', rateLimit('passkey-revoke-verify', 10), async (req, res) => {
    try {
      const current = await requireSession(req)
      const stored = await consumeAuthChallenge(challengeToken(req), 'passkey-revoke')
      res.setHeader('Set-Cookie', challengeCookie('', 0))
      if (stored.address !== current.session.address) throw Object.assign(new Error('This revocation request does not match the account.'), { status: 401 })
      const response = req.body?.response as AuthenticationResponseJSON
      if (response?.id === stored.targetCredentialId) throw Object.assign(new Error('Use a different recovery passkey to approve revocation.'), { status: 401 })
      const match = await findPasskey(response?.id)
      if (!match || match.walletAddress !== stored.address) throw Object.assign(new Error('This recovery passkey is not linked to the account.'), { status: 401 })
      const { origin, rpID } = webauthnSettings(req)
      const credential: WebAuthnCredential = {
        id: match.passkey.credentialId,
        publicKey: Uint8Array.from(Buffer.from(match.passkey.publicKey, 'base64url')),
        counter: match.passkey.counter,
        transports: match.passkey.transports as any,
      }
      const verification = await verifyAuthenticationResponse({ response, expectedChallenge: stored.challenge, expectedOrigin: origin, expectedRPID: rpID, credential, requireUserVerification: true })
      if (!verification.verified) throw Object.assign(new Error('The recovery passkey could not be verified.'), { status: 401 })
      await updatePasskeyCounter(match.walletAddress, match.passkey.credentialId, verification.authenticationInfo.newCounter)
      await removePasskey(stored.address, stored.targetCredentialId)
      await deleteAuthSession(current.token)
      await deleteAuthSessionsForCredential(stored.address, stored.targetCredentialId)
      const replacement = await createAuthSession(stored.address, 'passkey', match.passkey.credentialId)
      res.append('Set-Cookie', sessionCookie(replacement))
      res.json({ ok: true, account: publicAccount(await getAccount(stored.address)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.get('/email/status', (_req, res) => {
    res.json({ ok: true, configured: emailDeliverySettings().configured })
  })

  router.post('/email/authentication/request', rateLimit('email-authentication-request', 5, 15 * 60 * 1000), async (req, res) => {
    try {
      const email = normalizedEmail(req.body?.email)
      const settings = emailDeliverySettings()
      if (!settings.configured) throw Object.assign(new Error('Email sign-in is not configured yet.'), { status: 503 })
      const account = await findVerifiedAccountByEmail(email)
      const code = String(randomInt(100000, 1_000_000))
      await deliverEmailCode(email, code, settings, emailFetcher)
      const requestId = randomBytes(32).toString('base64url')
      await saveAuthChallenge(requestId, {
        purpose: 'email-signin',
        challenge: emailCodeHash(code, settings.codeSecret),
        address: account?.walletAddress || '',
        targetCredentialId: email,
        expiresAt: Date.now() + 10 * 60 * 1000,
      })
      res.setHeader('Set-Cookie', challengeCookie(requestId, 600))
      res.json({ ok: true, sent: true })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/email/authentication/verify', rateLimit('email-authentication-verify', 8, 15 * 60 * 1000), async (req, res) => {
    try {
      const settings = emailDeliverySettings()
      if (!settings.configured) throw Object.assign(new Error('Email sign-in is not configured yet.'), { status: 503 })
      const code = String(req.body?.code || '').trim()
      if (!/^\d{6}$/.test(code)) throw Object.assign(new Error('Enter the six-digit sign-in code.'), { status: 400 })
      const stored = await consumeAuthChallenge(challengeToken(req), 'email-signin')
      res.setHeader('Set-Cookie', challengeCookie('', 0))
      const expected = Buffer.from(stored.challenge)
      const received = Buffer.from(emailCodeHash(code, settings.codeSecret))
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw Object.assign(new Error('The sign-in code is incorrect or expired. Request a new code.'), { status: 401 })
      if (stored.address) {
        const token = await createAuthSession(stored.address, 'email')
        res.append('Set-Cookie', sessionCookie(token))
        return res.json({ ok: true, mode: 'signin', account: publicAccount(await getAccount(stored.address)) })
      }
      const linkToken = randomBytes(32).toString('base64url')
      await saveAuthChallenge(linkToken, { purpose: 'email-link', challenge: randomBytes(32).toString('base64url'), address: '', targetCredentialId: stored.targetCredentialId, expiresAt: Date.now() + 10 * 60 * 1000 })
      res.append('Set-Cookie', emailLinkCookie(linkToken))
      res.json({ ok: true, mode: 'link' })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/email/link', rateLimit('email-link', 5, 15 * 60 * 1000), async (req, res) => {
    try {
      const current = await requireRecentSession(req, 'wallet')
      const stored = await consumeAuthChallenge(emailLinkToken(req), 'email-link')
      await linkVerifiedBusinessEmail(current.session.address, stored.targetCredentialId)
      res.setHeader('Set-Cookie', emailLinkCookie('', 0))
      res.json({ ok: true, account: publicAccount(await getAccount(current.session.address)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/email/verification/request', rateLimit('email-verification-request', 3, 15 * 60 * 1000), async (req, res) => {
    try {
      const current = await requireRecentSession(req)
      const account = await getAccount(current.session.address)
      const email = account.profile.email
      if (!email) throw Object.assign(new Error('Save a business email before requesting verification.'), { status: 400 })
      if (account.profile.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true })
      const settings = emailDeliverySettings()
      if (!settings.configured) throw Object.assign(new Error('Email verification delivery is not configured yet.'), { status: 503 })
      const code = String(randomInt(100000, 1_000_000))
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomBytes(16).toString('hex') },
        body: JSON.stringify({ from: settings.from, to: [email], subject: 'Verify your KudiRoll business email', text: `Your KudiRoll verification code is ${code}. It expires in 10 minutes. This code cannot unlock or recover wallet funds.` }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw Object.assign(new Error('The verification email could not be delivered.'), { status: 502 })
      await saveAuthChallenge(current.token, { purpose: 'email-verify', challenge: emailCodeHash(code, settings.codeSecret), address: current.session.address, targetCredentialId: email, expiresAt: Date.now() + 10 * 60 * 1000 })
      res.json({ ok: true, sent: true })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/email/verification/verify', rateLimit('email-verification-verify', 8), async (req, res) => {
    try {
      const current = await requireSession(req)
      const settings = emailDeliverySettings()
      if (!settings.configured) throw Object.assign(new Error('Email verification delivery is not configured yet.'), { status: 503 })
      const code = String(req.body?.code || '').trim()
      if (!/^\d{6}$/.test(code)) throw Object.assign(new Error('Enter the six-digit verification code.'), { status: 400 })
      const stored = await consumeAuthChallenge(current.token, 'email-verify')
      if (stored.address !== current.session.address) throw Object.assign(new Error('This verification request does not match the account.'), { status: 401 })
      const expected = Buffer.from(stored.challenge)
      const received = Buffer.from(emailCodeHash(code, settings.codeSecret))
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw Object.assign(new Error('The verification code is incorrect or expired. Request a new code.'), { status: 401 })
      await markBusinessEmailVerified(stored.address, stored.targetCredentialId)
      res.json({ ok: true, account: publicAccount(await getAccount(stored.address)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.put('/embedded-wallet/backup', async (req, res) => {
    try {
      const { session } = await requireRecentSession(req, 'passkey')
      const account = await getAccount(session.address)
      if (account.passkeys.length < 2) throw Object.assign(new Error('Add two recovery passkeys before creating an embedded wallet backup.'), { status: 409 })
      res.json({ ok: true, backup: await saveEncryptedWalletBackup(session.address, req.body) })
    }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  router.get('/embedded-wallet/backup', async (req, res) => {
    try {
      const backup = await getEncryptedWalletBackup(await requireSessionAddress(req))
      if (!backup) return res.status(404).json({ ok: false, error: 'No encrypted wallet backup exists for this account.' })
      res.json({ ok: true, backup })
    } catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  router.post('/treasury/shields', async (req, res) => {
    try { res.status(201).json({ ok: true, shield: await recordTreasuryShield(await requireSessionAddress(req), req.body) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  router.get('/treasury/readiness', async (req, res) => {
    try { res.json({ ok: true, readiness: await treasuryReadiness(await requireSessionAddress(req)) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  router.patch('/profile', async (req, res) => {
    try { res.json({ ok: true, profile: await updateBusinessProfile(await requireSessionAddress(req), req.body) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  router.put('/payroll-policy', async (req, res) => {
    try { res.json({ ok: true, payrollPolicy: await updatePayrollPolicy(await requireSessionAddress(req), req.body) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  router.delete('/', async (req, res) => {
    try {
      const address = (await requireRecentSession(req, 'passkey')).session.address
      if (req.body?.confirmation !== 'DELETE KUDIROLL ACCOUNT') throw Object.assign(new Error('Type DELETE KUDIROLL ACCOUNT to confirm.'), { status: 400 })
      const deleted = await deleteAccount(address)
      await deleteAuthSessionsForAddress(address)
      res.setHeader('Set-Cookie', sessionCookie('', 0))
      res.json({ ok: true, deleted })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/teams', async (req, res) => {
    try { res.status(201).json({ ok: true, team: await createTeam(await requireSessionAddress(req), req.body) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })
  router.patch('/teams/:teamId', async (req, res) => {
    try { res.json({ ok: true, team: await updateTeam(await requireSessionAddress(req), req.params.teamId, req.body) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })
  router.delete('/teams/:teamId', async (req, res) => {
    try { res.json({ ok: true, deleted: await deleteTeam(await requireSessionAddress(req), req.params.teamId) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })
  router.post('/teams/:teamId/workers', async (req, res) => {
    try { res.status(201).json({ ok: true, worker: await addWorker(await requireSessionAddress(req), req.params.teamId, req.body) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })
  router.delete('/teams/:teamId/workers/:workerId', async (req, res) => {
    try { res.json({ ok: true, deleted: await removeWorker(await requireSessionAddress(req), req.params.teamId, req.params.workerId) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })
  router.post('/pay-runs', async (req, res) => {
    try { res.status(201).json({ ok: true, payRun: publicPayRun(await createPayRun(await requireSessionAddress(req), req.body)) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })
  router.post('/pay-runs/:payRunId/verify', rateLimit('pay-run-finality', 30, 5 * 60 * 1000), async (req, res) => {
    try {
      res.json({ ok: true, ...await verifyPayRunFinality(await requireSessionAddress(req), req.params.payRunId) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.post('/pay-runs/:payRunId/resolve-unknown', rateLimit('pay-run-resolve-unknown', 5, 15 * 60 * 1000), async (req, res) => {
    try {
      const { session } = await requireRecentSession(req, 'passkey')
      const payRun = await resolveUnknownPayRun(session.address, req.params.payRunId, req.body?.confirmation)
      res.json({ ok: true, payRun: publicPayRun(payRun) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.patch('/pay-runs/:payRunId', async (req, res) => {
    try { res.json({ ok: true, payRun: publicPayRun(await updatePayRun(await requireSessionAddress(req), req.params.payRunId, req.body)) }) }
    catch (error) { res.status(statusOf(error)).json({ ok: false, error: messageOf(error) }) }
  })

  return router
}
