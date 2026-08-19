import type { RequestHandler } from 'express'

function allowedOrigins(env: NodeJS.ProcessEnv) {
  const configured = [env.KUDIRAIL_ALLOWED_ORIGINS, env.KUDIROLL_WEBAUTHN_ORIGIN]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean)
  if (env.NODE_ENV !== 'production') configured.push('http://localhost:4173', 'http://127.0.0.1:4173')
  return new Set(configured.map(value => new URL(value).origin))
}

export function createApiOriginPolicy(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const allowed = allowedOrigins(env)
  return (req, res, next) => {
    const origin = String(req.headers.origin || '').trim()
    if (!origin) return next()
    let normalized = ''
    try { normalized = new URL(origin).origin } catch { /* rejected below */ }
    const requestOrigin = `${req.protocol}://${req.get('host')}`
    if (!normalized || (normalized !== requestOrigin && !allowed.has(normalized))) return res.status(403).json({ ok: false, error: 'This origin is not allowed to call KudiRail.' })
    res.setHeader('Access-Control-Allow-Origin', normalized)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Idempotency-Key')
    res.setHeader('Access-Control-Expose-Headers', 'KudiRoll-API-Version')
    res.setHeader('Vary', 'Origin')
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  }
}
