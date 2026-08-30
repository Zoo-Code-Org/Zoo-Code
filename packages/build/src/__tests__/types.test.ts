// npx vitest run src/__tests__/types.test.ts

import { contributesSchema } from "../types.js"

describe("contributes commands schema", () => {
	// Reached through `.shape` so this stays focused on the icon field, without needing a whole
	// valid `contributes` object around it.
	const commandsSchema = contributesSchema.shape.commands

	const command = (icon: unknown) => [
		{ command: "zoo-code.generateCommitMessage", title: "%command.generateCommitMessage.title%", icon },
	]

	it("accepts a codicon reference", () => {
		expect(commandsSchema.safeParse(command("$(edit)")).success).toBe(true)
	})

	// The Source Control button ships a PNG per theme rather than a codicon. This field used to
	// allow only a string, which rejected the manifest outright when generating the nightly build.
	it("accepts a pair of theme-specific icon paths", () => {
		const icon = { light: "assets/icons/panel_light.png", dark: "assets/icons/panel_dark.png" }

		expect(commandsSchema.safeParse(command(icon)).success).toBe(true)
	})

	it("rejects an icon pair that is missing a theme", () => {
		expect(commandsSchema.safeParse(command({ light: "assets/icons/panel_light.png" })).success).toBe(false)
	})
})

describe("contributes menus schema", () => {
	const menusSchema = contributesSchema.shape.menus

	it("accepts a grouped menu item", () => {
		const menus = {
			"scm/title": [
				{
					command: "zoo-code.generateCommitMessage",
					group: "navigation",
					when: "scmProvider == git && !zoo-code.generatingCommitMessage",
				},
			],
		}

		expect(menusSchema.safeParse(menus).success).toBe(true)
	})

	// `commandPalette` items have no group. This field used to be required, which rejected the
	// manifest outright when generating the nightly build.
	it("accepts a menu item with no group", () => {
		const menus = {
			commandPalette: [
				{ command: "zoo-code.stopGeneratingCommitMessage", when: "zoo-code.generatingCommitMessage" },
			],
		}

		expect(menusSchema.safeParse(menus).success).toBe(true)
	})
})
