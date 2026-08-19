import { Router } from 'express'
import { createPayRun, getAccount, publicPayRun, resolveUnknownPayRun, updatePayRun } from './account-store'
import { requireRecentSession, requireSessionAddress } from './account-router'
import { createPayRunExecutionManifest } from './pay-run-manifest'
import { verifyPayRunFinality } from './pay-run-finality-service'
import { rateLimit } from './rate-limit'

function statusOf(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) return Number(error.status) || 500
  return 500
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected KudiRoll Rail failure.'
}

function idempotencyKey(value: unknown) {
  const key = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw Object.assign(new Error('Idempotency-Key must contain 16 to 128 safe characters.'), { status: 400 })
  return key
}

export function createRailRouter() {
  const router = Router()
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('KudiRoll-API-Version', '1')
    next()
  })

  router.get('/', (_req, res) => res.json({
    ok: true,
    service: 'KudiRoll Rail',
    apiVersion: '1',
    network: 'starknet-mainnet',
    custody: 'client',
    authModes: ['first-party-session'],
    externalDeveloperAccess: 'planned',
    localSettlement: { NGN: 'guided-test', otherAfricanCorridors: 'not-enabled' },
  }))

  router.post('/pay-runs', async (req, res) => {
    try {
      const address = await requireSessionAddress(req)
      const payRun = await createPayRun(address, req.body, idempotencyKey(req.header('Idempotency-Key')))
      res.status(201).json({ ok: true, payRun: publicPayRun(payRun), executionManifest: createPayRunExecutionManifest(payRun) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.get('/pay-runs/:payRunId/execution-manifest', async (req, res) => {
    try {
      const account = await getAccount(await requireSessionAddress(req))
      const payRun = account.payRuns.find(item => item.id === req.params.payRunId)
      if (!payRun) throw Object.assign(new Error('Pay run not found.'), { status: 404 })
      res.json({ ok: true, executionManifest: createPayRunExecutionManifest(payRun) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.patch('/pay-runs/:payRunId', async (req, res) => {
    try {
      const payRun = await updatePayRun(await requireSessionAddress(req), req.params.payRunId, req.body)
      res.json({ ok: true, payRun: publicPayRun(payRun) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/pay-runs/:payRunId/verify', rateLimit('rail-pay-run-finality', 30, 5 * 60 * 1000, 'Too many payroll verification requests. Try again later.'), async (req, res) => {
    try {
      res.json({ ok: true, ...await verifyPayRunFinality(await requireSessionAddress(req), req.params.payRunId) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  router.post('/pay-runs/:payRunId/resolve-unknown', rateLimit('rail-pay-run-resolve-unknown', 5, 15 * 60 * 1000, 'Too many payroll recovery requests. Try again later.'), async (req, res) => {
    try {
      const { session } = await requireRecentSession(req, 'passkey')
      const payRun = await resolveUnknownPayRun(session.address, req.params.payRunId, req.body?.confirmation)
      res.json({ ok: true, payRun: publicPayRun(payRun) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })

  return router
}
