import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"
import { TaskOrganizationFixture } from "./TaskOrganization.visual.fixture"

test("renders task organization UI with folders and pins in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<TaskOrganizationFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("task-organization-default-dark.png")
})

test("renders expanded folder with member tasks in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<TaskOrganizationFixture expandFolder />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("task-organization-expanded-folder-dark.png")
})

test("renders pinned tasks section in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<TaskOrganizationFixture showPinned />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("task-organization-pinned-dark.png")
})
