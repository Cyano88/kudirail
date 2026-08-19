export type PayRunExecutionManifest = {
  version: '1'
  kind: 'strk20.private-payroll-intent'
  network: 'starknet-mainnet'
  payRunId: string
  teamId: string
  asset: { symbol: 'USDC'; decimals: 6 }
  actions: { kind: 'private-transfer'; workerId: string; recipient: string; amountUsdc: string }[]
  totalUsdc: string
  snapshotHash: string
  signing: { authority: 'client'; requiresUserApproval: true; serverCanSubmit: false }
}

export type RailTransport = (path: string, init: RequestInit) => Promise<any>
