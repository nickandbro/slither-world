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
  await enterGame(page)

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

test('shows a realtime leaderboard while playing', async ({ page }) => {
  await page.addInitScript(({ keys, name }) => {
    localStorage.setItem(keys.name, name)
    localStorage.setItem(keys.best, '0')
    localStorage.setItem(keys.room, 'main')
  }, { keys: STORAGE_KEYS, name: 'Realtime Board' })

  await page.goto('/')
  await enterGame(page)

  const leaderboard = page.locator('.leaderboard')
  await expect(leaderboard).toBeVisible()
  await expect(leaderboard.getByRole('heading', { name: 'Leaderboard' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit best' })).toHaveCount(0)

  const rows = leaderboard.locator('.leaderboard-row')
  await expect.poll(async () => rows.count()).toBeGreaterThan(0)
  await expect(rows.first().locator('.leaderboard-rank')).toContainText('#1')
})

test('can join a custom room', async ({ page }) => {
  await page.addInitScript(({ keys }) => {
    localStorage.setItem(keys.name, 'Room Hopper')
    localStorage.setItem(keys.best, '0')
    localStorage.setItem(keys.room, 'main')
  }, { keys: STORAGE_KEYS })

  await page.goto('/')
  await enterGame(page)

  const roomInput = page.getByLabel('Room')
  await roomInput.fill('e2e-room')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.locator('.menu-overlay')).toBeVisible()
  await enterGame(page)

  const status = page.locator('.status')
  await expect(status).toContainText('Room e2e-room')
  await expect(status).toContainText('Connected')
})
