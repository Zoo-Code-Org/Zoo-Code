import React from "react"
import type { Locator } from "@playwright/test"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { AppProviders } from "../../../../playwright/AppProviders"
import { expectContrast } from "../../../../playwright/contrast"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"
import { WelcomeLanding } from "../WelcomeLanding"

const textSpacingStyles = `
	/* WCAG 1.4.12 text-spacing override values. */
	* {
		line-height: 1.5 !important;
		letter-spacing: 0.12em !important;
		word-spacing: 0.16em !important;
	}

	p {
		margin-bottom: 2em !important;
	}
`

async function expectScreenContentToFit(screen: Locator) {
	const layout = await screen.evaluate((element) => {
		const screenRect = element.getBoundingClientRect()
		const content = Array.from(element.querySelectorAll("h2, p, button")).map((item) => {
			const rect = item.getBoundingClientRect()
			return {
				left: rect.left,
				right: rect.right,
				clientWidth: item.clientWidth,
				scrollWidth: item.scrollWidth,
				clientHeight: item.clientHeight,
				scrollHeight: item.scrollHeight,
			}
		})

		return {
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
			left: screenRect.left,
			right: screenRect.right,
			content,
		}
	})

	expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
	for (const item of layout.content) {
		expect(item.left).toBeGreaterThanOrEqual(layout.left)
		expect(item.right).toBeLessThanOrEqual(layout.right)
		expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth)
		expect(item.scrollHeight).toBeLessThanOrEqual(item.clientHeight)
	}
}

async function mountWelcomeScreen(mount: (component: React.ReactElement) => Promise<Locator>) {
	const component = await mount(
		<AppProviders initialState={{ apiConfiguration: {} }}>
			<WelcomeLanding onGetStarted={() => undefined} onImportSettings={() => undefined} />
		</AppProviders>,
	)
	return { component, screen: component.locator(".fixed.inset-0") }
}

for (const theme of visualThemes) {
	test(`renders the full welcome screen in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 480, height: 640 })
		await applyVisualTheme(page, theme)
		const { component, screen } = await mountWelcomeScreen(mount)

		const heading = component.getByRole("heading", { level: 2 })
		const action = component.getByRole("button", { name: /provider/i }).first()
		await expect(heading).toBeVisible()
		await expectContrast(heading, { background: screen, label: `${theme.name} welcome heading` })
		await expectContrast(action, {
			background: action,
			label: `${theme.name} welcome action`,
		})
		if (theme.name.startsWith("high-contrast")) {
			await expect(action).toHaveCSS("border-top-width", "1px")
			await expect(action).toHaveCSS("border-top-style", "solid")
			await expectContrast(action, {
				background: screen,
				foregroundProperty: "border-color",
				minimum: 3,
				label: `${theme.name} welcome action boundary`,
			})
		}

		await expect(screen).toHaveScreenshot(`welcome-screen-${theme.name}.png`)
	})

	test(`reflows the welcome screen at 320px in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 320, height: 640 })
		await applyVisualTheme(page, theme)
		const { component, screen } = await mountWelcomeScreen(mount)

		await expect(component.getByRole("heading", { level: 2 })).toBeVisible()
		await expect(component.getByRole("button", { name: /provider/i }).first()).toBeVisible()
		await expect(component.getByRole("button", { name: /import/i })).toBeVisible()
		await expectScreenContentToFit(screen)
		await expect(screen).toHaveScreenshot(`welcome-screen-reflow-${theme.name}.png`)
	})

	test(`supports WCAG text spacing in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		await page.setViewportSize({ width: 480, height: 640 })
		await applyVisualTheme(page, theme)
		const { component, screen } = await mountWelcomeScreen(mount)
		await page.addStyleTag({ content: textSpacingStyles })

		await expect(component.getByRole("heading", { level: 2 })).toBeVisible()
		await expect(component.getByRole("button", { name: /provider/i }).first()).toBeVisible()
		await expect(component.getByRole("button", { name: /import/i })).toBeVisible()
		await expectScreenContentToFit(screen)
		await expect(screen).toHaveScreenshot(`welcome-screen-text-spacing-${theme.name}.png`)
	})
}
