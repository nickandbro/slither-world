import { test, expect } from '@playwright/test'
import { enterGame } from './helpers'

const STORAGE_KEYS = {
  name: 'spherical_snake_player_name',
  best: 'spherical_snake_best_score',
  room: 'spherical_snake_room',
}

test('connects to the multiplayer server', async ({ page }) => {
  await page.addInitScript(({ keys }) => {
    localStorage.setItem(keys.name, 'E2E Pilot')
    localStorage.setItem(keys.best, '0')
    localStorage.setItem(keys.room, 'main')
  }, { keys: STORAGE_KEYS })

  await page.goto('/')

  const status = page.locator('.status')
  await expect(status).toContainText('Connected')
  await expect(status).toContainText('online')
  await expect
    .poll(async () => {
      const text = await status.innerText()
      const match = text.match(/(\d+)\s+online/)
      return match ? Number(match[1]) : 0
    })
    .toBeGreaterThanOrEqual(3)
})

test('submits a leaderboard entry', async ({ page }) => {
  const rawName = `E2E Tester ${Date.now()}`
  const sanitizedName = rawName.trim().replace(/\s+/g, ' ').slice(0, 20)

  await page.addInitScript(({ keys, name }) => {
    localStorage.setItem(keys.name, name)
    localStorage.setItem(keys.best, '999999')
    localStorage.setItem(keys.room, 'main')
  }, { keys: STORAGE_KEYS, name: rawName })

  await page.goto('/')
  await enterGame(page)

  await page.getByRole('button', { name: 'Submit best' }).click()
  await expect(page.locator('.leaderboard-status')).toContainText('Saved to leaderboard')

  const entry = page.locator('.leaderboard li', { hasText: sanitizedName })
  await expect(entry).toHaveCount(1)
})

test('can join a custom room', async ({ page }) => {
  await page.addInitScript(({ keys }) => {
    localStorage.setItem(keys.name, 'Room Hopper')
    localStorage.setItem(keys.best, '0')
    localStorage.setItem(keys.room, 'main')
  }, { keys: STORAGE_KEYS })

  await page.goto('/')

  const roomInput = page.getByLabel('Room')
  await roomInput.fill('e2e-room')
  await page.getByRole('button', { name: 'Join' }).click()

  const status = page.locator('.status')
  await expect(status).toContainText('Room e2e-room')
  await expect(status).toContainText('Connected')
})
