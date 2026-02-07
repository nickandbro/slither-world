import { expect, type Page } from '@playwright/test'

export async function enterGame(page: Page) {
  const playButton = page.getByRole('button', { name: 'Play' })
  await expect(playButton).toBeVisible()
  await expect(playButton).toBeEnabled()
  await playButton.click()
  await expect(page.locator('.scorebar')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.status')).toContainText('Connected')
}
