import { expect, test } from "../../../../playwright/coverage-fixture"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

// The dialog is rendered in a portal, so the dialog itself is what is shot, not the story it was mounted in.
for (const theme of visualThemes) {
	for (const saveOutcomeUnknown of [false, true]) {
		const state = saveOutcomeUnknown ? "save-may-complete" : "plain"
		test(`the unsaved-changes dialog ${saveOutcomeUnknown ? "with" : "without"} the note about an unanswered save (${theme.name})`, async ({
			page,
		}) => {
			await page.goto("/")
			await page.waitForFunction(() => typeof window.mount === "function")
			await page.evaluate((props) => window.mount({ story: "unsaved-changes-dialog", props }), {
				saveOutcomeUnknown,
			})
			await applyVisualTheme(page, theme)
			const dialog = page.getByRole("alertdialog")
			await expect(dialog).toBeVisible()
			await expect(dialog.getByText("Unsaved Changes")).toBeVisible()
			const note = dialog.getByTestId("save-outcome-unknown")
			if (saveOutcomeUnknown) {
				await expect(note).toHaveText(
					"A save that has not been answered yet may still complete after you leave.",
				)
			} else {
				await expect(note).toHaveCount(0)
			}

			await expect(dialog).toHaveScreenshot(`unsaved-changes-dialog-${state}-${theme.name}.png`)
		})
	}
}
