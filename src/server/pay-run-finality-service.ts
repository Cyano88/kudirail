import { RpcProvider, constants } from 'starknet'
import { getAccount, publicPayRun, recordPayRunFinality } from './account-store'
import { receiptTouchesPool } from '../pay-run-finality'

type ReceiptProvider = { getTransactionReceipt(transactionHash: string): Promise<any> }

function defaultProvider(): ReceiptProvider {
  const nodeUrl = process.env.STARKNET_RPC_URL?.trim()
  return nodeUrl ? new RpcProvider({ nodeUrl }) : new RpcProvider({ nodeUrl: constants.NetworkName.SN_MAIN })
}

function defaultPoolAddress() {
  const value = process.env.STRK20_POOL_ADDRESS?.trim().toLowerCase() || ''
  return /^0x[0-9a-f]{1,64}$/.test(value) ? value : ''
}

export async function verifyPayRunFinality(address: string, payRunId: string, options: { provider?: ReceiptProvider; poolAddress?: string } = {}) {
  const account = await getAccount(address)
  const payRun = account.payRuns.find(item => item.id === payRunId)
  if (!payRun) throw Object.assign(new Error('Pay run not found.'), { status: 404 })
  if (!payRun.transactionHash) throw Object.assign(new Error('This pay run has no transaction hash to verify.'), { status: 409 })
  try {
    const receipt = await (options.provider || defaultProvider()).getTransactionReceipt(payRun.transactionHash)
    const value = receipt.value as { block_number?: number; events?: { from_address?: string }[] }
    if (receipt.isError()) return { payRun: publicPayRun(await recordPayRunFinality(address, payRun.id, { status: 'unknown', acceptedBlockNumber: value.block_number, message: 'Starknet returned an unreadable receipt. KudiRoll has not finalized this payroll.' })) }
    if (receipt.isReverted()) return { payRun: publicPayRun(await recordPayRunFinality(address, payRun.id, { status: 'reverted', acceptedBlockNumber: value.block_number, message: 'Starknet reports that this private payroll transaction reverted.' })) }
    const poolAddress = options.poolAddress === undefined ? defaultPoolAddress() : options.poolAddress.toLowerCase()
    if (!/^0x[0-9a-f]{1,64}$/.test(poolAddress)) return { payRun: publicPayRun(await recordPayRunFinality(address, payRun.id, { status: 'unknown', acceptedBlockNumber: value.block_number, message: 'The receipt succeeded, but STRK20_POOL_ADDRESS is not configured, so KudiRoll cannot verify that it touched the canonical pool.' })) }
    const touchedPool = receiptTouchesPool(value.events || [], poolAddress)
    return { payRun: publicPayRun(await recordPayRunFinality(address, payRun.id, touchedPool
      ? { status: 'finalized', acceptedBlockNumber: value.block_number, message: 'Starknet finalized this transaction and its receipt contains an event from the configured STRK20 pool.' }
      : { status: 'unknown', acceptedBlockNumber: value.block_number, message: 'The transaction succeeded, but its receipt does not prove interaction with the configured STRK20 pool.' })) }
  } catch (error: any) {
    const message = String(error?.message || error)
    if (/not found|transaction hash not found|code.?29/i.test(message)) return { pending: true, message: 'The transaction is not available from Starknet yet. Check again shortly.' }
    throw error
  }
}
