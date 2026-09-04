import { expect, test } from "../../../../../playwright/coverage-fixture"
import { mountedStory } from "../../../../../playwright/mounted-story"

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		editorBackground: "#1f1f1f",
		dropdownBackground: "#313131",
		triggerBackground: "rgb(49, 49, 49)",
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		editorBackground: "#ffffff",
		dropdownBackground: "#ffffff",
		triggerBackground: "rgb(255, 255, 255)",
	},
] as const

for (const theme of themes) {
	test(`renders both OpenAI Codex speeds in the VS Code ${theme.name} theme`, async ({ mount }) => {
		const component = mountedStory(await mount("openai-codex"))
		const selectors = component.getByTestId("openai-codex-service-tier")
		const comboboxes = component.getByRole("combobox", { name: "Speed" })
		const selector = selectors.first()

		await expect(selectors).toHaveCount(2)
		await expect(comboboxes).toHaveCount(2)
		await selector.evaluate((element, { bodyClass, themeId }) => {
			const { document } = element.ownerDocument.defaultView!

			document.documentElement.className = bodyClass
			document.body.className = bodyClass
			document.body.dataset.vscodeThemeId = themeId
		}, theme)
		await expect
			.poll(() =>
				selector.evaluate((element) => {
					const body = element.ownerDocument.body
					const styles = getComputedStyle(body)
					const trigger = element.querySelector("button")!

					return {
						documentClass: element.ownerDocument.documentElement.className,
						bodyClass: body.className,
						editorBackground: styles.getPropertyValue("--vscode-editor-background").trim(),
						dropdownBackground: styles.getPropertyValue("--vscode-dropdown-background").trim(),
						triggerBackground: getComputedStyle(trigger).backgroundColor,
					}
				}),
			)
			.toEqual({
				documentClass: theme.bodyClass,
				bodyClass: theme.bodyClass,
				editorBackground: theme.editorBackground,
				dropdownBackground: theme.dropdownBackground,
				triggerBackground: theme.triggerBackground,
			})

		await component.evaluate(async () => {
			await document.fonts.ready
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		})

		await expect(component).toHaveScreenshot(`openai-codex-speed-selector-states-${theme.name}.png`)
	})
}
