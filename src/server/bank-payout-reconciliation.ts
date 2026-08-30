import { RpcProvider, constants, hash } from 'starknet'
import { STARKNET_USDC, getPaycrestOrder } from './paycrest'
import { getAccount, recordBankPayoutChainEvidence, updateBankPayoutProvider } from './account-store'

type ReceiptProvider = { getTransactionReceipt(transactionHash: string): Promise<any> }
type ReceiptEvent = { from_address?: string; keys?: string[]; data?: string[] }

function provider(): ReceiptProvider {
  const nodeUrl = process.env.STARKNET_RPC_URL?.trim()
  return nodeUrl ? new RpcProvider({ nodeUrl }) : new RpcProvider({ nodeUrl: constants.NetworkName.SN_MAIN })
}

function poolAddress() {
  const value = process.env.STRK20_POOL_ADDRESS?.trim().toLowerCase() || ''
  return /^0x[0-9a-f]{1,64}$/.test(value) ? value : ''
}

function sameFelt(left: unknown, right: unknown) {
  try { return BigInt(String(left)) === BigInt(String(right)) } catch { return false }
}

function amountUnits(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

export function receiptProvesPaycrestPayment(events: readonly ReceiptEvent[], input: { poolAddress: string; receiveAddress: string; amountUsdc: string }) {
  const transferSelector = hash.getSelectorFromName('Transfer')
  const expectedAmount = amountUnits(input.amountUsdc)
  return events.some(event => {
    if (!sameFelt(event.from_address, STARKNET_USDC) || !sameFelt(event.keys?.[0], transferSelector)) return false
    if (!sameFelt(event.keys?.[1], input.poolAddress) || !sameFelt(event.keys?.[2], input.receiveAddress)) return false
    const low = BigInt(event.data?.[0] || '0')
    const high = BigInt(event.data?.[1] || '0')
    return low + (high << 128n) === expectedAmount
  })
}

export async function reconcileBankPayout(address: string, payoutId: string, options: { receiptProvider?: ReceiptProvider; canonicalPoolAddress?: string; paycrestFetcher?: typeof fetch } = {}) {
  const account = await getAccount(address)
  let payout = account.bankPayouts.find(item => item.id === payoutId)
  if (!payout) throw Object.assign(new Error('Bank payout not found.'), { status: 404 })

  try {
    const providerOrder = await getPaycrestOrder(payout.id, options.paycrestFetcher)
    payout = await updateBankPayoutProvider(payout.id, providerOrder) || payout
  } catch {
    // Keep the durable local evidence usable during a provider outage.
  }

  if (!payout.transactionHash) return { payout, chainPending: false }
  try {
    const receipt = await (options.receiptProvider || provider()).getTransactionReceipt(payout.transactionHash)
    const value = receipt.value as { block_number?: number; events?: ReceiptEvent[] }
    if (receipt.isError()) return { payout: await recordBankPayoutChainEvidence(address, payout.id, { status: 'unknown', acceptedBlockNumber: value.block_number, message: 'Starknet returned an unreadable transaction receipt.' }), chainPending: false }
    if (receipt.isReverted()) return { payout: await recordBankPayoutChainEvidence(address, payout.id, { status: 'reverted', acceptedBlockNumber: value.block_number, message: 'Starknet reports that this payment transaction reverted.' }), chainPending: false }
    const canonicalPoolAddress = options.canonicalPoolAddress === undefined ? poolAddress() : options.canonicalPoolAddress
    if (!canonicalPoolAddress) return { payout: await recordBankPayoutChainEvidence(address, payout.id, { status: 'unknown', acceptedBlockNumber: value.block_number, message: 'The transaction succeeded, but the canonical STRK20 pool is not configured.' }), chainPending: false }
    const proved = receiptProvesPaycrestPayment(value.events || [], { poolAddress: canonicalPoolAddress, receiveAddress: payout.receiveAddress, amountUsdc: payout.amountUsdc })
    return { payout: await recordBankPayoutChainEvidence(address, payout.id, proved
      ? { status: 'succeeded', acceptedBlockNumber: value.block_number, message: 'Starknet finalized the exact USDC transfer from the STRK20 pool to this Paycrest order address.' }
      : { status: 'unknown', acceptedBlockNumber: value.block_number, message: 'The transaction succeeded, but its receipt does not prove the exact payment for this order.' }), chainPending: false }
  } catch (error: any) {
    const message = String(error?.message || error)
    if (/not found|transaction hash not found|code.?29/i.test(message)) {
      return { payout: await recordBankPayoutChainEvidence(address, payout.id, { status: 'pending', message: 'The submitted transaction is not available from Starknet yet.' }), chainPending: true }
    }
    throw error
  }
}
