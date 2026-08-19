import { Router } from 'express'
import { requireSessionAddress } from './account-router'
import { createPhase0PaycrestOrder, listPaycrestInstitutions, listPaycrestOrders, runPublicPaycrestProbe, verifyPaycrestAccount } from './paycrest'

function statusOf(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) return Number(error.status) || 500
  return 500
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected Phase 0 failure.'
}

export function createPhase0Router() {
  const router = Router()
  let lastPublicProbe: Awaited<ReturnType<typeof runPublicPaycrestProbe>> | null = null
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  router.get('/health', (_req, res) => res.json({ ok: true, phase: 0, liveOrdersEnabled: process.env.PHASE0_LIVE_ORDER_ENABLED === 'true' }))
  router.get('/paycrest/public', async (_req, res) => {
    try {
      lastPublicProbe = await runPublicPaycrestProbe()
      res.json(lastPublicProbe)
    } catch (error) {
      if (lastPublicProbe) {
        return res.json({
          ...lastPublicProbe,
          stale: true,
          warning: `Live refresh failed; showing the last successful result. ${messageOf(error)}`,
        })
      }
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.get('/paycrest/institutions', async (_req, res) => {
    try {
      await requireSessionAddress(_req)
      res.json({ ok: true, institutions: await listPaycrestInstitutions() })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.get('/paycrest/orders', async (req, res) => {
    try {
      const address = await requireSessionAddress(req)
      if (!process.env.PAYCREST_API_KEY?.trim()) return res.json({ ok: true, configured: false, orders: [] })
      res.json({ ok: true, configured: true, orders: await listPaycrestOrders(address) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.post('/paycrest/verify-account', async (req, res) => {
    try {
      await requireSessionAddress(req)
      const account = await verifyPaycrestAccount({
        institution: String(req.body?.institution || ''),
        accountIdentifier: String(req.body?.accountIdentifier || ''),
      })
      res.json({ ok: true, account })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.post('/paycrest/order', async (req, res) => {
    try {
      const refundAddress = await requireSessionAddress(req)
      res.json({ ok: true, order: await createPhase0PaycrestOrder({ ...req.body, refundAddress }) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  return router
}
