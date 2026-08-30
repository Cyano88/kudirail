import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('documentation site exposes the complete public product surface', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8')
  const css = await readFile(new URL('../site/styles.css', import.meta.url), 'utf8')
  for (const section of ['overview', 'trust', 'architecture', 'api', 'operations', 'paycrest']) {
    assert.match(html, new RegExp(`id="${section}"`))
  }
  assert.match(html, /Client-controlled execution/)
  assert.match(html, /Never resend to an expired address/)
  assert.match(css, /@media\(max-width:620px\)/)
  assert.match(css, /prefers-reduced-motion/)
})
