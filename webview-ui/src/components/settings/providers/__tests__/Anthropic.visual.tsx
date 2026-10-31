import { expect, test } from "../../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../../playwright/contrast"
import { collectBoundedLayoutFailures } from "../../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../../playwright/mounted-story"

// The prompt cache TTL control only renders for a model whose catalog entry
// advertises 1h, so this story pins the default Anthropic model
// (claude-sonnet-4-5, promptCacheTtlSupport: ["5m", "1h"]) to exercise it.
//
// Assertions are geometric and textual first, because those name what broke when
// they fail, and the pixel baseline is the last line of defense for the parts
// geometry cannot see (border, background, icon). The baseline is rendered in the
// CI Linux container, so a host-rendered PNG would not match there.
test("renders the prompt cache TTL control in the Anthropic settings form", async ({ mount, page }) => {
	await page.setViewportSize({ width: 480, height: 720 })

	const component = mountedStory(await mount("anthropic-settings"))
	const story = component.getByTestId("anthropic-settings-story")

	// The real toolkit text field draws its label above the input once upgraded.
	await page.evaluate(() => customElements.whenDefined("vscode-text-field"))

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	const control = story.getByTestId("prompt-cache-ttl")
	await expect(control).toBeVisible()

	// Copy must come from the en locale, not from raw i18n keys: a missing key
	// renders as the key string itself, which is what this asserts against.
	const label = control.getByText("Prompt cache lifetime")
	const description = control.getByText(/How long cached prompt prefixes stay valid/)
	await expect(label).toBeVisible()
	await expect(description).toBeVisible()
	await expect(control).not.toContainText("settings:providers.promptCacheTtl")

	// Unset must display as the vendor default rather than as a stored "5m",
	// which is what DEFAULT_PROMPT_CACHE_TTL (undefined) means for the request.
	await expect(control.getByRole("combobox")).toHaveText(/5 minutes \(default\)/)

	// Nothing may overflow or clip at the standard settings-form width.
	await expect.poll(() => story.evaluate(collectBoundedLayoutFailures)).toEqual([])

	// The control must line up with the sibling rows above it, not float on its
	// own gutter. Compare the label, trigger and description against the API key
	// field and the first checkbox row.
	const geometry = await story.evaluate((root) => {
		const box = (element: Element | null) => {
			if (!element) return null
			const rect = element.getBoundingClientRect()
			return { x: Math.round(rect.x), width: Math.round(rect.width) }
		}
		const ttl = root.querySelector('[data-testid="prompt-cache-ttl"]')
		const firstCheckbox = root.querySelector('input[type="checkbox"]')

		return {
			label: box(ttl?.querySelector("label") ?? null),
			trigger: box(ttl?.querySelector('[role="combobox"]') ?? null),
			description: box(ttl?.querySelector("div.text-sm") ?? null),
			apiKeyField: box(root.querySelector("vscode-text-field")),
			checkboxRow: box(firstCheckbox?.closest("label") ?? firstCheckbox?.parentElement ?? null),
		}
	})

	const siblings = [geometry.apiKeyField, geometry.checkboxRow]
	for (const sibling of siblings) {
		expect(geometry.trigger).toEqual(sibling)
		expect(geometry.label).toEqual(sibling)
		expect(geometry.description).toEqual(sibling)
	}

	// Typography must stay readable against the editor background.
	await expectContrast(label, { background: story, label: "prompt cache TTL label" })
	await expectContrast(description, { background: story, label: "prompt cache TTL description" })

	// Pixel receipt for the control's border, background, icon and spacing, which
	// the geometry and contrast checks above cannot see. Taken before the label
	// click below so the baseline captures the closed, unfocused state. The
	// baseline is rendered in the CI Linux container (pnpm test:visual:docker:update);
	// a host-rendered PNG would not match there.
	await expect(story).toHaveScreenshot("anthropic-prompt-cache-ttl-dark.png")

	// The visible label must activate the trigger for pointer users. A label with
	// no htmlFor leaves the click inert, so this opens the listbox from the label
	// rather than from the trigger.
	await label.click()
	const optionList = page.getByRole("listbox")
	await expect(optionList).toBeVisible()
	await expect(optionList.getByRole("option")).toHaveCount(2)
	await expect(optionList.getByRole("option", { name: /5 minutes \(default\)/ })).toBeVisible()
	await expect(optionList.getByRole("option", { name: /^1 hour$/ })).toBeVisible()
	await page.keyboard.press("Escape")
	await expect(optionList).toHaveCount(0)
})
