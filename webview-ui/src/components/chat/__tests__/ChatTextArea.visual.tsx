import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { ChatToolbarFixture } from "./ChatTextArea.visual.fixture"

// Visual baseline for the compact chat-input toolbar row the PR changes by
// adding the reasoning-effort selector. webview-ui/AGENTS.md requires a
// *.visual.tsx snapshot for at-a-glance layout changes; this covers the full
// toolbar — the left cluster [Select mode] [Select API configuration]
// [Model reasoning effort] [Auto-approval] and the right cluster [Codebase
// indexing] [Sign in to Zoo Code] — so the snapshot captures how the new
// control sits alongside every existing one, in both the default and
// narrow-width states (the narrow state exercises the row's min-w-0 /
// text-ellipsis / flex-shrink overflow behavior, the compact toolbar's
// primary concern) and in both VS Code dark and light themes.
//
// Baselines were generated with `pnpm test:visual:docker:update` from webview-ui/
// (host-rendered screenshots are not the source of truth). To update, re-run
// that command and commit the resulting __screenshots__ PNGs.

const themes = [
	{
		name: "dark",
		bodyClass: "vscode-dark",
		themeId: "Default Dark Modern",
		editorBackground: "#1e1e1e",
	},
	{
		name: "light",
		bodyClass: "vscode-light",
		themeId: "Default Light Modern",
		editorBackground: "#ffffff",
	},
] as const

// Default chat-input toolbar width and a narrow width that forces the row into
// its overflow/flex-shrink layout: wide enough that mode truncates but leaves
// room for bits of api-config and reasoning to peek through (the behavior the
// compact toolbar's min-w-0 / text-ellipsis / flex-shrink classes exist for).
const WIDTHS = [
	{ name: "default", width: 520 },
	{ name: "narrow", width: 380 },
] as const

for (const theme of themes) {
	for (const { name: widthName, width } of WIDTHS) {
		test(`renders the compact chat-input toolbar at ${widthName} width in the VS Code ${theme.name} theme`, async ({
			mount,
		}) => {
			const component = await mount(<ChatToolbarFixture width={width} />)

			const trigger = component.getByTestId("reasoning-effort-trigger")
			await trigger.evaluate((element, { bodyClass, themeId }) => {
				const { document } = element.ownerDocument.defaultView!
				document.documentElement.className = bodyClass
				document.body.className = bodyClass
				document.body.dataset.vscodeThemeId = themeId
			}, theme)

			await expect
				.poll(() =>
					trigger.evaluate((element) => {
						const body = element.ownerDocument.body
						const styles = getComputedStyle(body)
						return {
							documentClass: element.ownerDocument.documentElement.className,
							editorBackground: styles.getPropertyValue("--vscode-editor-background").trim(),
						}
					}),
				)
				.toEqual({
					documentClass: theme.bodyClass,
					editorBackground: theme.editorBackground,
				})

			await component.evaluate(async () => {
				await document.fonts.ready
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
			})

			await expect(component).toHaveScreenshot(`chat-toolbar-${widthName}-${theme.name}.png`)
		})
	}
}
