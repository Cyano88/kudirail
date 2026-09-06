export type PaymentWorkspace = 'standard' | 'enterprise'

// Missing scope is a legacy standard record, never an Enterprise record.
export function paymentWorkspace(value: unknown): PaymentWorkspace {
  if (value === undefined || value === null || value === 'standard') return 'standard'
  if (value === 'enterprise') return 'enterprise'
  throw Object.assign(new Error('Unknown payment workspace.'), { status: 400 })
}

export function inPaymentWorkspace(record: { workspace?: PaymentWorkspace }, workspace: PaymentWorkspace) {
  return (record.workspace ?? 'standard') === workspace
}
