import fs from "fs"
import { fileURLToPath } from "url"

import { describe, expect, it } from "vitest"

// This suite reads the contributes manifest itself rather than a constant copied from it: the
// command ids, the menu rows and the `when` clauses below are what decide whether a title-bar
// button reaches the handler that owns it, and nothing else in the repo checks them. Renaming an
// id, flipping a clause or dropping a row is invisible to every other test in the suite.
const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"))
const commands: { command: string; title: string }[] = manifest.contributes.commands
const menus = manifest.contributes.menus as Record<string, { command: string; when?: string }[]>

// `find` answers `T | undefined`, and TS does not narrow a row back through a `toBeDefined` assertion,
// so the `row.when` read that follows such an assertion stays a type error. Resolving every lookup
// through this helper keeps each row's own failure message and makes the dropped row the thing that
// fails, rather than the property read after it.
function resolved<T>(rows: T[], matches: (row: T) => boolean, message: string): T {
	const row = rows.find(matches)
	if (!row) {
		throw new Error(message)
	}
	return row
}

const TAB_PANEL_ID = "zoo-code.TabPanelProvider"
const SIDEBAR_VIEW_CLAUSE = `view == zoo-code.SidebarProvider`
const TAB_ACTIVE_CLAUSE = `activeWebviewPanelId == ${TAB_PANEL_ID}`
const TAB_INACTIVE_CLAUSE = `activeWebviewPanelId != ${TAB_PANEL_ID}`

const declared = new Set(commands.map((c) => c.command))
const titleBarCommands = [...new Set([...menus["editor/title"], ...menus["view/title"]].map((r) => r.command))]
const tabTitleCommands = titleBarCommands.filter((id) => id.endsWith("InTab"))
const sidebarTitleCommands = titleBarCommands.filter((id) => !id.endsWith("InTab"))

// popoutButtonClicked is a view/title-only affordance: it has no commandPalette row.
const sidebarTaskCommands = sidebarTitleCommands.filter((id) => !id.endsWith("popoutButtonClicked"))
describe("contributes manifest for the title-bar commands", () => {
	it("declares every command the menus reference", () => {
		for (const id of titleBarCommands) {
			expect(declared, `${id} is used in a menu but not declared in contributes.commands`).toContain(id)
		}
	})

	it.each(tabTitleCommands)("%s has an editor/title row gated on the tab panel", (id) => {
		const row = resolved(menus["editor/title"], (r) => r.command === id, `${id} must appear in editor/title`)
		expect(row.when, `${id} must be gated on the active tab panel`).toBe(TAB_ACTIVE_CLAUSE)
	})

	it.each(tabTitleCommands)("%s has a commandPalette row gated on the tab panel", (id) => {
		const row = resolved(menus.commandPalette, (r) => r.command === id, `${id} must appear in commandPalette`)
		expect(row.when, `${id} must be gated on the active tab panel`).toBe(TAB_ACTIVE_CLAUSE)
	})

	it.each(sidebarTitleCommands)("%s has a view/title row gated on the sidebar view", (id) => {
		const row = resolved(menus["view/title"], (r) => r.command === id, `${id} must appear in view/title`)
		expect(row.when, `${id} must be gated on the sidebar view`).toBe(SIDEBAR_VIEW_CLAUSE)
	})

	// popoutButtonClicked is a view/title-only row: it has no commandPalette entry, and the four
	// sidebar task commands each have one hidden while the tab panel is the active webview.
	it.each(sidebarTaskCommands)("%s has a commandPalette row hidden while the tab panel is active", (id) => {
		const row = resolved(menus.commandPalette, (r) => r.command === id, `${id} must appear in commandPalette`)
		expect(row.when, `${id} must be hidden while the tab panel is the active webview`).toBe(TAB_INACTIVE_CLAUSE)
	})
	it("keeps popoutButtonClicked out of the command palette", () => {
		// It is a title-bar affordance only: giving it a palette row would expose a command that
		// needs an active webview to mean anything.
		expect(
			menus.commandPalette.map((r) => r.command),
			"popout belongs in view/title only",
		).not.toContain("zoo-code.popoutButtonClicked")
	})

	it("surfaces the failure message when a menu references an undeclared id", () => {
		// The per-id rows above carry a failure message built from the id. This row proves the message
		// reaches the reporter: without it a renamed command id would fail with an empty diff.
		const id = "zoo-code.notDeclaredInCommands"
		const message = id + " is used in a menu but not declared in contributes.commands"
		expect(() => {
			expect(id, message).toBe("zoo-code.declaredElsewhere")
		}, message).toThrowError(message)
	})
	it("names the title-bar commands with i18n placeholders, not literals", () => {
		for (const id of titleBarCommands) {
			const entry = resolved(commands, (c) => c.command === id, `${id} must be declared`)
			expect(entry.title, `${id} must carry a %placeholder title`).toMatch(/^%/)
		}
	})
})
