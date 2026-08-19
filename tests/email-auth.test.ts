import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataFile = join(tmpdir(), `kudiroll-email-http-${randomUUID()}.json`)
const authFile = join(tmpdir(), `kudiroll-email-http-auth-${randomUUID()}.json`)
process.env.KUDIROLL_DATA_FILE = dataFile
process.env.KUDIROLL_AUTH_FILE = authFile
process.env.NODE_ENV = 'test'
process.env.RESEND_API_KEY = 'resend_test_key'
process.env.KUDIROLL_EMAIL_FROM = 'KudiRoll <signin@example.com>'
process.env.KUDIROLL_EMAIL_CODE_SECRET = 'email-code-secret-with-at-least-32-characters'

const express = (await import('express')).default
const store = await import('../src/server/account-store')
const auth = await import('../src/server/auth-store')
const { createAccountRouter } = await import('../src/server/account-router')

function cookieValue(header: string, name: string) {
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`))
  assert.ok(match, `Missing ${name} cookie in ${header}`)
  return `${name}=${match[1]}`
}

test.after(async () => { await Promise.all([rm(dataFile, { force: true }), rm(authFile, { force: true })]) })

test('email OTP signs into a verified account and supports first-time wallet linking without signing authority', async () => {
  const delivered: { to: string; code: string }[] = []
  const emailFetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body || '{}'))
    const code = String(payload.text).match(/\b(\d{6})\b/)?.[1] || ''
    delivered.push({ to: payload.to[0], code })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  await store.linkVerifiedBusinessEmail('0xe100', 'owner@example.com')
  const app = express()
  app.use(express.json())
  app.use('/api/account', createAccountRouter({ emailFetcher: emailFetcher as typeof fetch }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const request = await fetch(`${origin}/api/account/email/authentication/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'OWNER@example.com' }),
    })
    assert.equal(request.status, 200)
    assert.equal(delivered[0].to, 'owner@example.com')
    const challengeCookie = cookieValue(String(request.headers.get('set-cookie')), 'kudiroll_webauthn')
    const verification = await fetch(`${origin}/api/account/email/authentication/verify`, {
      method: 'POST',
      headers: { Cookie: challengeCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: delivered[0].code }),
    })
    assert.equal(verification.status, 200)
    assert.equal((await verification.clone().json()).mode, 'signin')
    const sessionCookie = cookieValue(String(verification.headers.get('set-cookie')), 'kudiroll_session')
    const me = await fetch(`${origin}/api/account/me`, { headers: { Cookie: sessionCookie } })
    assert.equal((await me.json()).account.walletAddress, '0xe100')

    const onboardingRequest = await fetch(`${origin}/api/account/email/authentication/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    })
    const onboardingChallenge = cookieValue(String(onboardingRequest.headers.get('set-cookie')), 'kudiroll_webauthn')
    const onboardingVerify = await fetch(`${origin}/api/account/email/authentication/verify`, {
      method: 'POST',
      headers: { Cookie: onboardingChallenge, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: delivered[1].code }),
    })
    assert.equal((await onboardingVerify.clone().json()).mode, 'link')
    const linkCookie = cookieValue(String(onboardingVerify.headers.get('set-cookie')), 'kudiroll_email_link')
    const walletToken = await auth.createAuthSession('0xe200', 'wallet')
    const linked = await fetch(`${origin}/api/account/email/link`, {
      method: 'POST',
      headers: { Cookie: `kudiroll_session=${walletToken}; ${linkCookie}` },
    })
    assert.equal(linked.status, 200)
    assert.equal((await store.findVerifiedAccountByEmail('new@example.com'))?.walletAddress, '0xe200')
    assert.equal((await auth.getAuthSession(walletToken))?.method, 'wallet')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
