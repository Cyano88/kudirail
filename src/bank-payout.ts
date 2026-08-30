export type BankPayoutDisplayStatus =
  | 'ready-to-pay'
  | 'payment-submitted'
  | 'awaiting-paycrest-detection'
  | 'reconciliation-required'
  | 'refunding'
  | 'refunded'
  | 'completed'
  | 'payment-window-closed'
  | 'payment-failed'

export type BankPayoutChainStatus = 'not-checked' | 'pending' | 'succeeded' | 'reverted' | 'unknown'
export type BankPayoutSubmissionState = 'not-started' | 'submitting' | 'submitted' | 'cancelled' | 'unknown'

export type SavedBankPayout = {
  id: string
  reference: string
  providerStatus: string
  displayStatus: BankPayoutDisplayStatus
  amountNgn: string
  amountUsdc: string
  network: 'starknet'
  token: 'USDC'
  receiveAddress: string
  refundAddress: string
  accountName: string
  bankLast4: string
  institution: string
  validUntil: string
  transactionHash: string
  submissionState: BankPayoutSubmissionState
  submissionAttemptedAt: string
  submittedAt: string
  chainStatus: BankPayoutChainStatus
  chainCheckedAt: string
  acceptedBlockNumber: number | null
  chainMessage: string
  providerAmountPaid: string
  providerAmountReturned: string
  providerTransactionHash: string
  providerUpdatedAt: string
  lastProviderSyncAt: string
  reconciliationReason: string
  createdAt: string
  updatedAt: string
}

const COMPLETE = new Set(['settled'])
const PROVIDER_PROCESSING = new Set(['deposited', 'pending', 'fulfilling', 'validated', 'settling'])

export function deriveBankPayoutDisplayStatus(payout: Pick<SavedBankPayout,
  'providerStatus' | 'transactionHash' | 'submissionState' | 'chainStatus' | 'validUntil'>, now = Date.now()): BankPayoutDisplayStatus {
  const provider = payout.providerStatus.trim().toLowerCase()
  if (COMPLETE.has(provider)) return 'completed'
  if (provider === 'refunded') return 'refunded'
  if (provider === 'refunding') return 'refunding'
  if (payout.chainStatus === 'reverted' || payout.submissionState === 'cancelled') return 'payment-failed'
  if (payout.transactionHash) {
    if (payout.chainStatus === 'succeeded') {
      if (provider === 'expired' || (Date.parse(payout.validUntil) <= now && ['initiated', 'unknown'].includes(provider))) return 'reconciliation-required'
      if (['initiated', 'unknown', ''].includes(provider)) return 'awaiting-paycrest-detection'
    }
    return 'payment-submitted'
  }
  if (payout.submissionState === 'submitting' || payout.submissionState === 'unknown') return 'payment-submitted'
  if (PROVIDER_PROCESSING.has(provider)) return 'payment-submitted'
  if (Date.parse(payout.validUntil) <= now || provider === 'expired') return 'payment-window-closed'
  return 'ready-to-pay'
}

export function blocksAnotherBankPayout(payout: SavedBankPayout, now = Date.now()) {
  const display = deriveBankPayoutDisplayStatus(payout, now)
  if (['completed', 'refunded', 'payment-failed', 'payment-window-closed'].includes(display)) return false
  return true
}

export const bankPayoutStatusLabel: Record<BankPayoutDisplayStatus, string> = {
  'ready-to-pay': 'Ready to pay',
  'payment-submitted': 'Payment submitted',
  'awaiting-paycrest-detection': 'Awaiting Paycrest detection',
  'reconciliation-required': 'Reconciliation required',
  refunding: 'Refunding',
  refunded: 'Refunded',
  completed: 'Completed',
  'payment-window-closed': 'Payment window closed',
  'payment-failed': 'Payment failed',
}
