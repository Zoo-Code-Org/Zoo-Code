import * as fs from "fs"
import * as path from "path"

import packageJson from "../../../package.json"

/**
 * The two commands share one slot in the Source Control title bar, swapped by a context key. That
 * only looks like one button if it does not move when it swaps.
 */
describe("Source Control title bar contributions", () => {
	const items = packageJson.contributes.menus["scm/title"]

	const generate = items.find(({ command }) => command === "zoo-code.generateCommitMessage")
	const stop = items.find(({ command }) => command === "zoo-code.stopGeneratingCommitMessage")

	it("contributes both commands", () => {
		expect(generate).toBeDefined()
		expect(stop).toBeDefined()
	})

	// Items sort by `order` first and by *localized* title only as a tiebreak. Left unordered, the
	// built-in "Refresh" sorts between "Generate Commit Message" and "Stop Generating Commit
	// Message", so the button jumped a slot as it swapped - and in a different direction per
	// language. An explicit, shared order is what pins the two to one place.
	it("puts both commands in the same slot, explicitly ordered", () => {
		expect(generate!.group).toBe(stop!.group)
		expect(generate!.group).toMatch(/@\d+$/)
	})

	it("shows exactly one of them at a time", () => {
		expect(generate!.when).toBe("scmProvider == git && !zoo-code.generatingCommitMessage")
		expect(stop!.when).toBe("scmProvider == git && zoo-code.generatingCommitMessage")
	})

	// A codicon inherits `icon.foreground`, so it stays legible in light, dark and high-contrast
	// themes. An image icon renders identically in all three, and command icons cannot carry a
	// `ThemeColor`, so this deliberately is not a coloured asset.
	it("draws the stop button with a codicon so it follows the theme", () => {
		const command = packageJson.contributes.commands.find(
			({ command }) => command === "zoo-code.stopGeneratingCommitMessage",
		)

		expect(command!.icon).toBe("$(debug-stop)")
	})

	it("titles the stop button so hovering it says what it does", () => {
		const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.nls.json"), "utf8"))

		expect(nls["command.stopGeneratingCommitMessage.title"]).toBe("Stop Generating Commit Message")
	})
})
