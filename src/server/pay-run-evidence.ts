import { createHash } from 'node:crypto'
import type { AccountRecord, SavedPayRun } from './account-store'
import { verifyTreasuryAuditChain } from './account-store'
import { createPayRunExecutionManifest } from './pay-run-manifest'

function configuredPoolAddress(value = process.env.STRK20_POOL_ADDRESS) {
  const address = String(value || '').trim().toLowerCase()
  return /^0x[0-9a-f]{1,64}$/.test(address) ? address : null
}

export function createPayRunEvidenceBundle(account: AccountRecord, payRun: SavedPayRun, generatedAt = new Date().toISOString(), poolAddress = configuredPoolAddress()) {
  const manifest = createPayRunExecutionManifest(payRun)
  const privateRoute = manifest.settlementMode === 'private'
  const verifiedPoolAddress = configuredPoolAddress(payRun.verifiedPoolAddress || '')
  const poolInteractionVerified = payRun.status === 'finalized' && Boolean(payRun.transactionHash) && Number.isSafeInteger(payRun.acceptedBlockNumber) && payRun.acceptedBlockNumber! >= 0 && Boolean(verifiedPoolAddress)
  const relevantAuditEvents = account.treasuryAudit
    .filter(event => event.subjectId === payRun.id)
    .map(event => ({ type: event.type, createdAt: event.createdAt, previousHash: event.previousHash, eventHash: event.eventHash }))

  const payload = {
    schema: 'kudiroll.payroll-evidence.v1' as const,
    generatedAt,
    evidenceScope: 'sanitized-shareable' as const,
    payroll: {
      ...(payRun.workspace === 'enterprise' ? { workspace: 'enterprise' as const } : {}),
      payRunId: payRun.id,
      network: manifest.network,
      settlementMode: manifest.settlementMode,
      route: privateRoute ? 'strk20-private-transfer' : 'strk20-public-withdrawal',
      recipientCount: payRun.items.length,
      status: payRun.status,
      createdAt: payRun.createdAt,
      submissionAttemptedAt: payRun.submissionAttemptedAt || null,
    },
    intentCommitment: {
      manifestVersion: manifest.version,
      snapshotHash: manifest.snapshotHash,
      authorizationHash: manifest.authorizationHash,
      policyVersion: manifest.policy.version,
      signingAuthority: manifest.signing.authority,
      requiresUserApproval: manifest.signing.requiresUserApproval,
      serverCanSubmit: false,
    },
    transaction: {
      hash: payRun.transactionHash || null,
      explorerUrl: payRun.transactionHash ? `https://starkscan.co/tx/${payRun.transactionHash}` : null,
      acceptedBlockNumber: payRun.acceptedBlockNumber,
      finalityCheckedAt: payRun.finalityCheckedAt || null,
      configuredPoolAddress: poolAddress,
      verifiedPoolAddress,
      poolInteractionVerified,
      finalityMessage: payRun.finalityMessage || null,
    },
    verification: {
      applicationRecord: privateRoute
        ? 'The durable KudiRoll intent committed to STRK20 private-transfer actions and client-side wallet approval.'
        : 'The durable KudiRoll intent committed to STRK20 public-withdrawal actions and client-side wallet approval.',
      publicChainEvidence: poolInteractionVerified
        ? 'Starknet finalized the recorded transaction and its receipt contains an event from the STRK20 pool recorded at verification time.'
        : payRun.transactionHash
          ? 'A wallet-returned transaction hash is recorded, but configured-pool finality has not been verified.'
          : 'No transaction hash is recorded; this is intent evidence only.',
      limitation: privateRoute
        ? 'Public receipt evidence does not reveal or independently prove private recipient addresses, individual amounts, or recipient note delivery. Recipient-wallet confirmation is required for end-to-end delivery evidence.'
        : 'This compatibility route is public. Recipient addresses and amounts may be visible onchain and must not be presented as private payroll.',
    },
    privacy: {
      privateRoute,
      deliberatelyDisclosed: ['pay-run identifier', 'settlement mode', 'recipient count', 'status', 'intent hashes', 'transaction and finality evidence'],
      omitted: ['team name', 'worker names', 'recipient addresses', 'individual amounts', 'pay-run total'],
    },
    audit: {
      completeChainIntegrityVerified: verifyTreasuryAuditChain(account.treasuryAudit),
      accountChainHead: account.treasuryAudit.at(-1)?.eventHash || null,
      payRunEvents: relevantAuditEvents,
    },
  }

  return {
    ...payload,
    integrity: {
      algorithm: 'sha256' as const,
      payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      signed: false,
      note: 'This checksum detects file changes; it is not an organization signature or an onchain attestation.',
    },
  }
}
