export type WorkerInput = { name: string; walletAddress: string; defaultAmountUsdc: string }
export const MAX_IMPORT_WORKERS = 100

export function canonicalWorkerAddress(value: string) {
  const address = value.trim().toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(address)) throw new Error('Enter a valid Starknet wallet address.')
  const numeric = BigInt(address)
  if (numeric <= 0n || numeric >= (1n << 251n) - 256n) throw new Error('Enter a valid Starknet wallet address.')
  return '0x' + numeric.toString(16)
}

export function validateWorkerRows(rows: WorkerInput[], existing: { walletAddress: string }[] = []) {
  const seen = new Set(existing.map(worker => {
    try { return canonicalWorkerAddress(worker.walletAddress) } catch { return worker.walletAddress.trim().toLowerCase() }
  }))
  return rows.map(row => {
    const errors: string[] = []
    if (typeof row.name !== 'string' || row.name.trim().length < 2 || row.name.trim().length > 80 || /[\r\n\x00-\x1f]/.test(row.name)) errors.push('Name must contain 2 to 80 characters on one line.')
    try {
      const address = canonicalWorkerAddress(row.walletAddress)
      if (seen.has(address)) errors.push('This wallet is already in the team or import.')
      seen.add(address)
    } catch { errors.push('Enter a valid Starknet wallet address.') }
    const amount = typeof row.defaultAmountUsdc === 'string' ? row.defaultAmountUsdc.trim() : ''
    if (amount.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) errors.push('Enter a positive USDC amount with at most 6 decimals.')
    return errors
  })
}
