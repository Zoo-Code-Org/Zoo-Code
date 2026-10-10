import { expect, test } from "../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

// Declared in webview-ui/src/i18n/locales/en/settings.json under
// settings:autoApprove.execute.autoDeny.label; the checkbox takes its accessible
// name from that label text, so the two must stay in sync.
const autoDenyLabel = "Auto-deny unapproved commands (never ask)"

for (const theme of visualThemes) {
	test(`renders the blanket auto-deny checkbox in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("auto-approve-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("auto-approve-settings-story")
		const checkbox = story.getByRole("checkbox", { name: autoDenyLabel })
		await expect(checkbox).toBeVisible()
		await expect(checkbox).toBeChecked()
		await expect(story).toHaveScreenshot(`auto-approve-settings-${theme.name}.png`)
	})

	// Behavioral assertions for the slider (minimum, current value, and the zero-timeout
	// description) live in AutoApproveSettings.spec.tsx. This visual test establishes a
	// deterministic zero-timeout state and makes the focused screenshot assertion.
	test(`renders the zero follow-up timeout in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("auto-approve-settings", { followupAutoApproveTimeoutMs: 0 }))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("auto-approve-settings-story")
		await expect(story).toHaveScreenshot(`auto-approve-settings-followup-zero-${theme.name}.png`)
	})
}
