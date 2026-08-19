export const PAYCREST_DEFAULT_BASE = 'https://api.paycrest.io'
export const STARKNET_USDC = '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb'

type FetchLike = typeof fetch

export type PaycrestInstitution = {
  code: string
  name: string
  type?: string
}

export type PaycrestOrderSummary = {
  id: string
  status: string
  reference: string
  amountNgn: string
  amountUsdc: string
  network: string
  token: string
  accountName: string
  bankLast4: string
  createdAt: string
  updatedAt: string
  txHash: string
}

function baseUrl() {
  return (process.env.PAYCREST_API_BASE || PAYCREST_DEFAULT_BASE).replace(/\/+$/, '')
}

async function jsonFetch(fetcher: FetchLike, path: string, init?: RequestInit) {
  const response = await fetcher(`${baseUrl()}${path}`, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `Paycrest returned ${response.status}`)
    Object.assign(error, { status: response.status })
    throw error
  }
  return body?.data ?? body
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

function decimalText(value: unknown) {
  const text = String(value ?? '').trim()
  return /^\d+(?:\.\d+)?$/.test(text) ? text : ''
}

function addDecimalStrings(...values: unknown[]) {
  const parsed = values.map(decimalText).filter(Boolean)
  if (!parsed.length) return ''
  const scale = Math.max(...parsed.map(value => (value.split('.')[1] ?? '').length), 6)
  const total = parsed.reduce((sum, value) => {
    const [whole, fraction = ''] = value.split('.')
    return sum + BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0').slice(0, scale) || '0')
  }, 0n)
  const whole = total / 10n ** BigInt(scale)
  const fraction = (total % 10n ** BigInt(scale)).toString().padStart(scale, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function payableCryptoAmount(data: any) {
  const explicit = firstText(
    data?.amountToPay,
    data?.amount_to_pay,
    data?.totalAmount,
    data?.total_amount,
    data?.amountDue,
    data?.amount_due,
    data?.source?.amount,
    data?.sourceAmount,
    data?.source_amount,
  )
  if (decimalText(explicit)) return explicit
  const amount = decimalText(data?.amount)
  return amount ? addDecimalStrings(amount, data?.senderFee, data?.transactionFee) : ''
}

function authenticatedHeaders() {
  const apiKey = process.env.PAYCREST_API_KEY?.trim()
  if (!apiKey) throw Object.assign(new Error('PAYCREST_API_KEY is not configured.'), { status: 503 })
  return { 'API-Key': apiKey, 'Content-Type': 'application/json' }
}

function orderRows(data: any) {
  if (Array.isArray(data)) return data
  for (const candidate of [data?.orders, data?.items, data?.results, data?.data]) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function sanitizeOrder(row: any): PaycrestOrderSummary | null {
  const recipient = row?.destination?.recipient ?? row?.recipient ?? {}
  const accountIdentifier = firstText(recipient?.accountIdentifier, recipient?.account_identifier)
  const id = firstText(row?.id, row?.orderId, row?.order_id)
  if (!id) return null
  const explicitFiat = firstText(row?.destination?.amount, row?.fiatAmount, row?.fiat_amount, row?.amountInFiat, row?.amount_in_fiat)
  const derivedFiat = String(row?.destination?.currency || row?.currency).toUpperCase() === 'NGN' && Number(row?.amount) > 0 && Number(row?.rate) > 0
    ? String(Math.round(Number(row.amount) * Number(row.rate)))
    : ''
  return {
    id,
    status: firstText(row?.status) || 'unknown',
    reference: firstText(row?.reference),
    amountNgn: explicitFiat || derivedFiat,
    amountUsdc: payableCryptoAmount(row),
    network: firstText(row?.source?.network, row?.network),
    token: firstText(row?.source?.currency, row?.token),
    accountName: firstText(recipient?.accountName, recipient?.account_name),
    bankLast4: accountIdentifier.slice(-4),
    createdAt: firstText(row?.createdAt, row?.created_at),
    updatedAt: firstText(row?.updatedAt, row?.updated_at),
    txHash: firstText(row?.txHash, row?.tx_hash),
  }
}

function refundAddressOf(row: any) {
  return firstText(row?.source?.refundAddress, row?.source?.refund_address, row?.refundAddress, row?.refund_address).toLowerCase()
}

export async function listPaycrestOrders(refundAddress: string, fetcher: FetchLike = fetch): Promise<PaycrestOrderSummary[]> {
  const owner = refundAddress.trim().toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(owner)) throw Object.assign(new Error('A valid Starknet account is required.'), { status: 400 })
  const data = await jsonFetch(fetcher, '/v2/sender/orders?page=1&pageSize=20', {
    method: 'GET',
    headers: authenticatedHeaders(),
  })
  const prefix = process.env.PAYCREST_REFERENCE_PREFIX?.trim() || 'kudiroll-'
  return (orderRows(data).filter(row => refundAddressOf(row) === owner).map(sanitizeOrder).filter(Boolean) as PaycrestOrderSummary[])
    .filter(order => order.reference.startsWith(prefix))
}

export async function listPaycrestInstitutions(fetcher: FetchLike = fetch): Promise<PaycrestInstitution[]> {
  const data = await jsonFetch(fetcher, '/v2/institutions/NGN', {
    method: 'GET',
    headers: authenticatedHeaders(),
  })
  const rows = Array.isArray(data) ? data : Array.isArray(data?.institutions) ? data.institutions : Array.isArray(data?.items) ? data.items : []
  return rows
    .map((row: any) => {
      const code = firstText(row?.code, row?.institution, row?.id).toUpperCase()
      const name = firstText(row?.name, row?.displayName, row?.display_name, row?.label)
      const type = firstText(row?.type, row?.channel)
      return code && name ? { code, name, type: type || undefined } : null
    })
    .filter(Boolean) as PaycrestInstitution[]
}

export async function verifyPaycrestAccount(input: { institution: string; accountIdentifier: string }, fetcher: FetchLike = fetch) {
  if (!/^[A-Z0-9_-]{3,24}$/i.test(input.institution)) throw Object.assign(new Error('Select a valid Nigerian bank.'), { status: 400 })
  if (!/^\d{10}$/.test(input.accountIdentifier)) throw Object.assign(new Error('A 10-digit Nigerian account number is required.'), { status: 400 })
  const data = await jsonFetch(fetcher, '/v2/verify-account', {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify(input),
  })
  const accountName = firstText(data?.accountName, data?.account_name, data?.name, data)
  if (accountName.length < 3) throw Object.assign(new Error('Paycrest did not return a verified account name.'), { status: 502 })
  return { accountName }
}

export async function runPublicPaycrestProbe(fetcher: FetchLike = fetch) {
  const [tokens, quote] = await Promise.all([
    jsonFetch(fetcher, '/v2/tokens'),
    jsonFetch(fetcher, '/v2/rates/starknet/USDC/10/NGN?side=sell'),
  ])
  const token = Array.isArray(tokens)
    ? tokens.find(entry => String(entry?.network).toLowerCase() === 'starknet' && String(entry?.symbol).toUpperCase() === 'USDC')
    : null
  const sell = quote?.sell ?? quote
  const rate = String(sell?.rate || '')
  const tokenMatches = String(token?.contractAddress || '').toLowerCase() === STARKNET_USDC
  const quoteWorks = Number(rate) > 0
  return {
    ok: tokenMatches && quoteWorks,
    checkedAt: new Date().toISOString(),
    token: token ? {
      symbol: String(token.symbol),
      network: String(token.network),
      contractAddress: String(token.contractAddress),
      decimals: Number(token.decimals),
    } : null,
    quote: quoteWorks ? {
      rate,
      orderType: sell?.orderType ? String(sell.orderType) : undefined,
      refundTimeoutMinutes: Number(sell?.refundTimeoutMinutes || 0) || undefined,
    } : null,
    checks: {
      starknetUsdc: { ok: tokenMatches, detail: tokenMatches ? 'Live token registry matches expected Starknet USDC.' : 'Starknet USDC is missing or changed.' },
      ngnQuote: { ok: quoteWorks, detail: quoteWorks ? 'Live Starknet USDC sell quote returned.' : 'No usable NGN quote returned.' },
    },
  }
}

export type Phase0OrderInput = {
  amountNgn: string
  institution: string
  accountIdentifier: string
  refundAddress: string
  memo?: string
  confirmation: string
}

function assertPhase0Order(input: Phase0OrderInput) {
  if (process.env.PHASE0_LIVE_ORDER_ENABLED !== 'true') throw Object.assign(new Error('Live Phase 0 order creation is disabled.'), { status: 403 })
  if (input.confirmation !== 'CREATE TEST ORDER') throw Object.assign(new Error('Type CREATE TEST ORDER to continue.'), { status: 400 })
  const amount = Number(input.amountNgn)
  const maximum = Number(process.env.PHASE0_MAX_NGN || 5000)
  if (!Number.isFinite(amount) || amount <= 0 || amount > maximum) throw Object.assign(new Error(`Test amount must be between NGN 1 and NGN ${maximum}.`), { status: 400 })
  if (!/^[A-Z0-9_-]{3,24}$/i.test(input.institution)) throw Object.assign(new Error('Invalid institution code.'), { status: 400 })
  if (!/^\d{10}$/.test(input.accountIdentifier)) throw Object.assign(new Error('A 10-digit Nigerian account number is required.'), { status: 400 })
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(input.refundAddress)) throw Object.assign(new Error('A valid Starknet refund address is required.'), { status: 400 })
}

export async function createPhase0PaycrestOrder(input: Phase0OrderInput, fetcher: FetchLike = fetch) {
  assertPhase0Order(input)
  const { accountName } = await verifyPaycrestAccount({
    institution: input.institution,
    accountIdentifier: input.accountIdentifier,
  }, fetcher)
  const prefix = process.env.PAYCREST_REFERENCE_PREFIX?.trim() || 'kudiroll-'
  const reference = `${prefix}phase0-${Date.now()}`
  const data = await jsonFetch(fetcher, '/v2/sender/orders', {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: JSON.stringify({
      amount: input.amountNgn,
      amountIn: 'fiat',
      source: { type: 'crypto', currency: 'USDC', network: 'starknet', refundAddress: input.refundAddress },
      destination: {
        type: 'fiat',
        currency: 'NGN',
        recipient: {
          institution: input.institution,
          accountIdentifier: input.accountIdentifier,
          accountName,
          memo: input.memo?.trim() || 'KudiRoll Phase 0',
        },
      },
      reference,
    }),
  })
  const provider = data?.providerAccount ?? data?.provider_account ?? {}
  const id = firstText(data?.id, data?.orderId, data?.order_id)
  const amountUsdc = payableCryptoAmount(data)
  const receiveAddress = firstText(provider?.receiveAddress, provider?.receive_address)
  const validUntil = firstText(provider?.validUntil, provider?.valid_until)
  if (!id) throw Object.assign(new Error('Paycrest created no usable order id.'), { status: 502 })
  if (!decimalText(amountUsdc) || Number(amountUsdc) <= 0) throw Object.assign(new Error('Paycrest returned no exact USDC amount.'), { status: 502 })
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(receiveAddress)) throw Object.assign(new Error('Paycrest returned no valid Starknet receive address.'), { status: 502 })
  if (!validUntil || !Number.isFinite(Date.parse(validUntil))) throw Object.assign(new Error('Paycrest returned no valid order expiry.'), { status: 502 })
  return {
    id,
    status: String(data?.status || 'initiated'),
    reference,
    amountNgn: input.amountNgn,
    amountUsdc,
    receiveAddress,
    validUntil,
    accountName,
    bankLast4: input.accountIdentifier.slice(-4),
  }
}
