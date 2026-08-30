const menu = document.querySelector('[data-menu]')
const sidebar = document.querySelector('[data-sidebar]')
const links = [...document.querySelectorAll('[data-nav]')]

menu?.addEventListener('click', () => {
  const open = sidebar?.classList.toggle('open') ?? false
  menu.setAttribute('aria-expanded', String(open))
})

links.forEach((link) => link.addEventListener('click', () => {
  sidebar?.classList.remove('open')
  menu?.setAttribute('aria-expanded', 'false')
}))

const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).at(-1)
  if (!visible) return
  links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`))
}, { rootMargin: '-20% 0px -65%', threshold: 0 })

document.querySelectorAll('main section[id]').forEach((section) => observer.observe(section))

document.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget
  const value = document.querySelector('.code-block code')?.textContent?.trim()
  if (!value) return
  await navigator.clipboard.writeText(value)
  button.textContent = 'Copied'
  setTimeout(() => { button.textContent = 'Copy' }, 1400)
})

async function loadStatus() {
  const status = document.querySelector('[data-status]')
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } })
    const health = await response.json()
    status.classList.toggle('live', Boolean(response.ok && health.ok))
    status.querySelector('span').textContent = response.ok && health.ok ? 'Mainnet service live' : 'Service needs attention'
    document.querySelector('[data-release]').textContent = String(health.release || 'unknown').slice(0, 8)
  } catch {
    status.querySelector('span').textContent = 'Status unavailable'
  }
}

loadStatus()
