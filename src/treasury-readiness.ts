export const SHIELD_MATURITY_BLOCKS = 10

export type TreasuryShieldRecord = {
  transactionHash: string
  amountUsdc: string
  submittedAt: string
}

export type TreasuryReadinessStatus = 'none' | 'submitted' | 'maturing' | 'ready' | 'reverted' | 'unknown'

export type TreasuryReadiness = {
  status: TreasuryReadinessStatus
  shield: TreasuryShieldRecord | null
  acceptedBlockNumber: number | null
  currentBlockNumber: number | null
  confirmations: number
  blocksRemaining: number
  checkedAt: string
  message: string
}

export function deriveTreasuryReadiness(
  shield: TreasuryShieldRecord | null,
  chain: { outcome: 'pending' | 'succeeded' | 'reverted' | 'unknown'; acceptedBlockNumber?: number; currentBlockNumber?: number },
  checkedAt = new Date().toISOString(),
): TreasuryReadiness {
  if (!shield) return { status: 'none', shield: null, acceptedBlockNumber: null, currentBlockNumber: null, confirmations: 0, blocksRemaining: 0, checkedAt, message: 'No shield transaction is tracked for this account.' }
  if (chain.outcome === 'reverted') return { status: 'reverted', shield, acceptedBlockNumber: chain.acceptedBlockNumber ?? null, currentBlockNumber: chain.currentBlockNumber ?? null, confirmations: 0, blocksRemaining: SHIELD_MATURITY_BLOCKS, checkedAt, message: 'The shield transaction reverted and cannot fund payroll.' }
  if (chain.outcome === 'unknown') return { status: 'unknown', shield, acceptedBlockNumber: chain.acceptedBlockNumber ?? null, currentBlockNumber: chain.currentBlockNumber ?? null, confirmations: 0, blocksRemaining: SHIELD_MATURITY_BLOCKS, checkedAt, message: 'KudiRoll could not verify this shield transaction from Starknet yet.' }
  if (chain.outcome === 'pending' || chain.acceptedBlockNumber === undefined || chain.currentBlockNumber === undefined) return { status: 'submitted', shield, acceptedBlockNumber: chain.acceptedBlockNumber ?? null, currentBlockNumber: chain.currentBlockNumber ?? null, confirmations: 0, blocksRemaining: SHIELD_MATURITY_BLOCKS, checkedAt, message: 'The shield transaction is submitted and waiting for Starknet acceptance.' }

  const confirmations = Math.max(0, chain.currentBlockNumber - chain.acceptedBlockNumber)
  const blocksRemaining = Math.max(0, SHIELD_MATURITY_BLOCKS - confirmations)
  if (blocksRemaining > 0) return { status: 'maturing', shield, acceptedBlockNumber: chain.acceptedBlockNumber, currentBlockNumber: chain.currentBlockNumber, confirmations, blocksRemaining, checkedAt, message: `Shield confirmed. Wait ${blocksRemaining} more block${blocksRemaining === 1 ? '' : 's'} before private payroll.` }
  return { status: 'ready', shield, acceptedBlockNumber: chain.acceptedBlockNumber, currentBlockNumber: chain.currentBlockNumber, confirmations, blocksRemaining: 0, checkedAt, message: 'Shield confirmed and mature. Its private note is ready for payroll.' }
}
