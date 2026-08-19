import { createHash } from 'node:crypto'
import type { SavedPayRun } from './account-store'
import type { PayRunExecutionManifest } from '../rail/contracts'

export function createPayRunExecutionManifest(payRun: SavedPayRun): PayRunExecutionManifest {
  const snapshot = {
    payRunId: payRun.id,
    teamId: payRun.teamId,
    asset: { symbol: 'USDC' as const, decimals: 6 as const },
    actions: payRun.items.map(item => ({ kind: 'private-transfer' as const, workerId: item.workerId, recipient: item.walletAddress, amountUsdc: item.amountUsdc })),
    totalUsdc: payRun.totalUsdc,
  }
  return {
    version: '1',
    kind: 'strk20.private-payroll-intent',
    network: 'starknet-mainnet',
    ...snapshot,
    snapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    signing: { authority: 'client', requiresUserApproval: true, serverCanSubmit: false },
  }
}
