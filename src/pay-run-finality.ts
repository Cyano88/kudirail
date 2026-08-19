export type ReceiptEvent = { from_address?: string }

export function sameStarknetFelt(left: string, right: string) {
  try { return BigInt(left) === BigInt(right) } catch { return false }
}

export function receiptTouchesPool(events: readonly ReceiptEvent[], poolAddress: string) {
  return events.some(event => typeof event.from_address === 'string' && sameStarknetFelt(event.from_address, poolAddress))
}
