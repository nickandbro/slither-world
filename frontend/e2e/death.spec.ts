import { test, expect } from '@playwright/test'

const getBackendUrl = () => process.env.E2E_BACKEND_URL || 'http://localhost:8790'

const distance = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

test('bot death fades and stays in place while dead', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.status')).toContainText('Connected')

  await page.waitForFunction(() => (window as any).__SNAKE_DEBUG__?.getSnakeOpacity)
  await page.waitForFunction(() => {
    const text = document.querySelector('.status')?.textContent ?? ''
    const match = text.match(/(\d+)\s+online/)
    return match ? Number(match[1]) >= 2 : false
  })

  const backendUrl = getBackendUrl()
  const response = await request.post(
    `${backendUrl}/api/debug/kill?room=main&target=bot`,
  )
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  const playerId = payload.playerId as string | undefined
  expect(playerId).toBeTruthy()

  await page.waitForFunction(
    (id: string) => {
      const api = (window as any).__SNAKE_DEBUG__
      const opacity = api?.getSnakeOpacity(id)
      return typeof opacity === 'number' && opacity < 0.8
    },
    playerId,
  )

  const posA = await page.evaluate((id: string) => {
    const api = (window as any).__SNAKE_DEBUG__
    return api?.getSnakeHeadPosition(id) ?? null
  }, playerId)
  expect(posA).not.toBeNull()

  await page.waitForTimeout(800)

  const posB = await page.evaluate((id: string) => {
    const api = (window as any).__SNAKE_DEBUG__
    return api?.getSnakeHeadPosition(id) ?? null
  }, playerId)
  expect(posB).not.toBeNull()

  const drift = distance(posA, posB)
  expect(drift).toBeLessThan(0.01)

  await page.waitForFunction(
    (id: string) => {
      const api = (window as any).__SNAKE_DEBUG__
      const opacity = api?.getSnakeOpacity(id)
      return typeof opacity === 'number' && opacity < 0.2
    },
    playerId,
    { timeout: 5000 },
  )
})
