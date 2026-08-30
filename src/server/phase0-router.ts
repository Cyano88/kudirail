import { Router } from 'express'
import { requireSessionAddress } from './account-router'
import { createPhase0PaycrestOrder, getPaycrestOrder, listPaycrestInstitutions, paycrestConfiguration, runPublicPaycrestProbe, verifyPaycrestAccount } from './paycrest'
import { assertCanCreateBankPayout, beginBankPayoutSubmission, cancelBankPayoutSubmission, getAccount, markBankPayoutUnknown, recordBankPayoutOrder, recordBankPayoutTransaction } from './account-store'
import { reconcileBankPayout } from './bank-payout-reconciliation'

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
  router.get('/health', (_req, res) => res.json({ ok: true, phase: 0, paycrest: paycrestConfiguration(), liveOrdersEnabled: paycrestConfiguration().liveOrdersEnabled }))
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
      const account = await getAccount(address)
      if (paycrestConfiguration().apiConfigured) await Promise.allSettled(account.bankPayouts.map(payout => reconcileBankPayout(address, payout.id)))
      const refreshed = await getAccount(address)
      res.json({ ok: true, configured: paycrestConfiguration().apiConfigured, orders: refreshed.bankPayouts })
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
      await assertCanCreateBankPayout(refundAddress)
      const created = await createPhase0PaycrestOrder({ ...req.body, refundAddress })
      const order = await recordBankPayoutOrder(refundAddress, { ...created, institution: req.body?.institution })
      res.status(201).json({ ok: true, order })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.post('/paycrest/orders/recover', async (req, res) => {
    try {
      const address = await requireSessionAddress(req)
      const providerOrder = await getPaycrestOrder(String(req.body?.orderId || ''))
      let ownsOrder = false
      try { ownsOrder = BigInt(providerOrder.refundAddress) === BigInt(address) } catch {}
      if (!ownsOrder) throw Object.assign(new Error('This Paycrest order does not belong to the signed-in Starknet account.'), { status: 403 })
      const payout = await recordBankPayoutOrder(address, { ...providerOrder, status: providerOrder.status })
      await recordBankPayoutTransaction(address, payout.id, { transactionHash: req.body?.transactionHash })
      res.json({ ok: true, ...(await reconcileBankPayout(address, payout.id)) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.post('/paycrest/orders/:orderId/submission', async (req, res) => {
    try {
      const address = await requireSessionAddress(req)
      const transactionHash = String(req.body?.transactionHash || '').trim()
      let payout
      if (transactionHash) payout = await recordBankPayoutTransaction(address, req.params.orderId, { transactionHash })
      else if (req.body?.state === 'submitting') payout = await beginBankPayoutSubmission(address, req.params.orderId)
      else if (req.body?.state === 'cancelled') payout = await cancelBankPayoutSubmission(address, req.params.orderId)
      else if (req.body?.state === 'unknown') payout = await markBankPayoutUnknown(address, req.params.orderId)
      else throw Object.assign(new Error('A submission state or transaction hash is required.'), { status: 400 })
      if (transactionHash) payout = (await reconcileBankPayout(address, req.params.orderId).catch(() => null))?.payout || payout
      res.json({ ok: true, payout })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.post('/paycrest/orders/:orderId/reconcile', async (req, res) => {
    try {
      const address = await requireSessionAddress(req)
      res.json({ ok: true, ...await reconcileBankPayout(address, req.params.orderId) })
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  router.get('/paycrest/orders/:orderId/evidence', async (req, res) => {
    try {
      const address = await requireSessionAddress(req)
      const result = await reconcileBankPayout(address, req.params.orderId).catch(() => null)
      const payout = result?.payout || (await getAccount(address)).bankPayouts.find(item => item.id === req.params.orderId)
      if (!payout) throw Object.assign(new Error('Bank payout not found.'), { status: 404 })
      const evidence = {
        schema: 'kudirail.bank-payout-incident.v1', exportedAt: new Date().toISOString(), orderId: payout.id, reference: payout.reference,
        status: { product: payout.displayStatus, paycrest: payout.providerStatus, chain: payout.chainStatus, submission: payout.submissionState },
        payment: { amountUsdc: payout.amountUsdc, amountNgn: payout.amountNgn, network: payout.network, token: payout.token, receiveAddress: payout.receiveAddress, refundAddress: payout.refundAddress },
        recipient: { accountName: payout.accountName, bankLast4: payout.bankLast4, institution: payout.institution },
        transaction: { hash: payout.transactionHash, submittedAt: payout.submittedAt, acceptedBlockNumber: payout.acceptedBlockNumber, chainCheckedAt: payout.chainCheckedAt, evidence: payout.chainMessage },
        provider: { amountPaid: payout.providerAmountPaid, amountReturned: payout.providerAmountReturned, transactionHash: payout.providerTransactionHash, updatedAt: payout.providerUpdatedAt, lastSyncAt: payout.lastProviderSyncAt },
        timing: { orderCreatedAt: payout.createdAt, validUntil: payout.validUntil, lastUpdatedAt: payout.updatedAt }, reconciliationReason: payout.reconciliationReason,
      }
      res.setHeader('Content-Disposition', `attachment; filename=kudirail-paycrest-${payout.id}.json`)
      res.type('application/json').send(JSON.stringify(evidence, null, 2))
    } catch (error) {
      res.status(statusOf(error)).json({ ok: false, error: messageOf(error) })
    }
  })
  return router
}
