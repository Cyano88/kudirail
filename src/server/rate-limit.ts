const rateWindows = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(bucket: string, limit = 20, windowMs = 10 * 60 * 1000, message = 'Too many authentication attempts. Try again later.') {
  return (req: any, res: any, next: any) => {
    const now = Date.now()
    if (rateWindows.size >= 2000) {
      for (const [key, value] of rateWindows) if (value.resetAt <= now) rateWindows.delete(key)
      while (rateWindows.size >= 2000) {
        const oldestKey = rateWindows.keys().next().value
        if (!oldestKey) break
        rateWindows.delete(oldestKey)
      }
    }
    const key = `${bucket}:${req.ip || req.socket?.remoteAddress || 'unknown'}`
    const current = rateWindows.get(key)
    const state = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current
    state.count += 1
    rateWindows.set(key, state)
    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - state.count)))
    res.setHeader('RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)))
    if (state.count > limit) return res.status(429).json({ ok: false, error: message })
    next()
  }
}
