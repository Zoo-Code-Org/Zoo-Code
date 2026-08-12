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
