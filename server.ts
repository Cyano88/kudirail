import { config } from 'dotenv'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPhase0Router } from './src/server/phase0-router'
import { createAccountRouter } from './src/server/account-router'
import { createRailRouter } from './src/server/rail-router'
import { databaseReadiness, persistenceConfig } from './src/server/database'
import { bootstrapAccountStore } from './src/server/account-bootstrap'
import { createApiOriginPolicy } from './src/server/origin-policy'
import { paycrestWebhookHandler } from './src/server/paycrest-webhook'

config({ path: '.env.local', quiet: true })
config({ path: '.env', quiet: true })

await bootstrapAccountStore()

const app = express()
const port = Number(process.env.PORT || 4174)
const host = process.env.HOST?.trim() || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const siteDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site')

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'")
  if (req.path.startsWith('/api')) res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})
app.use(express.static(siteDirectory, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }))
app.use('/api', createApiOriginPolicy())
app.post('/api/phase0/paycrest/webhook', express.raw({ type: 'application/json', limit: '128kb' }), paycrestWebhookHandler)
app.use(express.json({ limit: '32kb' }))
app.get(['/', '/docs'], (_req, res) => res.sendFile(path.join(siteDirectory, 'index.html')))
app.get('/api/health', async (_req, res) => {
  const persistence = persistenceConfig()
  const database = await databaseReadiness()
  const databaseRequired = persistence.accountBackend === 'postgres' || persistence.authBackend === 'postgres'
  const ready = !databaseRequired || (database.reachable && (database.schemaVersion ?? 0) >= 2)
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'kudirail',
    apiVersion: '1',
    network: 'starknet-mainnet',
    custody: 'client',
    persistence: { accounts: persistence.accountBackend, authentication: persistence.authBackend, database },
    release: process.env.KUDIRAIL_RELEASE_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || 'development',
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development',
  })
})
app.use('/api/phase0', createPhase0Router())
app.use('/api/v1', createRailRouter())
app.use('/api/account', createAccountRouter())
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'KudiRail endpoint not found.' }))

app.listen(port, host, () => console.log(`KudiRail listening on http://${host}:${port}`))
