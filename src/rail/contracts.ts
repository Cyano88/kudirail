export type PayRunExecutionManifest = {
  version: '2'
  kind: 'strk20.payroll-intent'
  network: 'starknet-mainnet'
  payRunId: string
  teamId: string
  settlementMode: 'public-wallet' | 'private'
  asset: { symbol: 'USDC'; decimals: 6 }
  actions: { kind: 'public-withdrawal' | 'private-transfer'; workerId: string; recipient: string; amountUsdc: string }[]
  totalUsdc: string
  snapshotHash: string
  policy: { version: number; reserveUsdc: string; maxPayRunUsdc: string; payoutsPaused: boolean; authorizedAt: string }
  authorizationHash: string
  signing: { authority: 'client'; requiresUserApproval: true; serverCanSubmit: false }
}

export type RailTransport = (path: string, init: RequestInit) => Promise<any>
