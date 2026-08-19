import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createApiOriginPolicy } from '../src/server/origin-policy'

test('KudiRail permits its own origin and an exact configured application origin', async () => {
  const app = express()
  app.use('/api', createApiOriginPolicy({ NODE_ENV: 'production', KUDIRAIL_ALLOWED_ORIGINS: 'https://app.kudiroll.example' }))
  app.post('/api/check', (_req, res) => res.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  try {
    const port = (server.address() as { port: number }).port
    const allowed = await fetch(`http://127.0.0.1:${port}/api/check`, { method: 'POST', headers: { Origin: 'https://app.kudiroll.example' } })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true')
    const own = await fetch(`http://127.0.0.1:${port}/api/check`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}` } })
    assert.equal(own.status, 200)
    const denied = await fetch(`http://127.0.0.1:${port}/api/check`, { method: 'POST', headers: { Origin: 'https://attacker.example' } })
    assert.equal(denied.status, 403)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
