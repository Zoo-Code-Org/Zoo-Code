import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

// The production ChatRow dependency graph can take over 30s to compile on a cold gallery server.
test.setTimeout(120_000)

for (const theme of visualThemes.filter(({ name }) => name === "dark" || name === "light")) {
	test(`renders user, diff and assistant rows in the ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("chat-row-conversation"))
		await applyVisualTheme(page, theme)
		// DiffView reads the theme on initialization, so remount with the selected tokens.
		await page.evaluate(() => window.mount({ story: "chat-row-conversation" }))
		const conversation = component.getByTestId("chat-row-conversation")
		await expect(conversation.getByRole("heading", { name: "Verification" })).toBeVisible()
		await expect(component.getByTestId("chat-row-user_feedback_diff").getByText("Hello Zoo")).toBeVisible()

		// Capture both hover states so the action row and preview placement are visible.
		await component.getByTestId("chat-row-user_feedback").getByText(messagesUserText).hover()
		await expect(conversation).toHaveScreenshot(`chat-row-user-actions-${theme.name}.png`)
		await component
			.getByTestId("chat-row-text")
			.locator(".group")
			.hover({ position: { x: 2, y: 12 } })
		await expect(conversation.getByRole("button", { name: "Open markdown in preview" })).toHaveCSS("opacity", "1")
		await expect(conversation).toHaveScreenshot(`chat-row-assistant-preview-${theme.name}.png`)
	})
}

const messagesUserText = "Please update the greeting and explain the change."
