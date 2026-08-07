import type { AutocompleteServiceLike } from "../types"
import { AUTOCOMPLETE_OPEN_SETTINGS_COMMAND, AutocompleteStatusBar } from "../ui/AutocompleteStatusBar"

const item = {
	command: undefined as string | undefined,
	tooltip: undefined as string | undefined,
	text: "",
	backgroundColor: undefined as unknown,
	show: vi.fn(),
	dispose: vi.fn(),
}

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		StatusBarAlignment: { Left: 1, Right: 2 },
		ThemeColor: class {
			constructor(readonly id: string) {}
		},
		window: { createStatusBarItem: () => item },
	}
})

const serviceWith = (enabled: boolean) => ({ getState: () => ({ enabled }) }) as unknown as AutocompleteServiceLike

beforeEach(() => {
	item.command = undefined
	item.tooltip = undefined
	item.text = ""
	item.backgroundColor = undefined
	vi.clearAllMocks()
})

describe("AutocompleteStatusBar", () => {
	it("stays hidden until show() is called", () => {
		new AutocompleteStatusBar(serviceWith(true))

		expect(item.show).not.toHaveBeenCalled()
	})

	it("wires the click through to the settings command", () => {
		// The status bar never mutates persisted state itself; clicking opens settings.
		new AutocompleteStatusBar(serviceWith(true)).show()

		expect(item.command).toBe(AUTOCOMPLETE_OPEN_SETTINGS_COMMAND)
		expect(item.tooltip).toContain("configure")
		expect(item.show).toHaveBeenCalledTimes(1)
	})

	it("renders the enabled state on show", () => {
		new AutocompleteStatusBar(serviceWith(true)).show()

		expect(item.text).toBe("$(sparkles) Autocomplete")
		expect(item.backgroundColor).toBeUndefined()
	})

	it("renders the disabled state on show", () => {
		new AutocompleteStatusBar(serviceWith(false)).show()

		expect(item.text).toBe("$(sparkles) Autocomplete: Off")
	})

	it("re-reads live service state on refresh", () => {
		let enabled = false
		const bar = new AutocompleteStatusBar({ getState: () => ({ enabled }) } as unknown as AutocompleteServiceLike)

		bar.show()
		expect(item.text).toBe("$(sparkles) Autocomplete: Off")

		enabled = true
		bar.refresh()
		expect(item.text).toBe("$(sparkles) Autocomplete")
	})

	it("shows an error background and icon", () => {
		const bar = new AutocompleteStatusBar(serviceWith(true))

		bar.update("error")

		expect(item.text).toBe("$(error) Autocomplete")
		expect(item.backgroundColor).toBeDefined()
	})

	it("clears the error background when returning to ready", () => {
		const bar = new AutocompleteStatusBar(serviceWith(true))

		bar.update("error")
		bar.update("ready")

		expect(item.backgroundColor).toBeUndefined()
		expect(item.text).toBe("$(sparkles) Autocomplete")
	})

	it("treats an unknown status as off", () => {
		const bar = new AutocompleteStatusBar(serviceWith(true))

		bar.update("error")
		bar.update("nonsense" as never)

		expect(item.text).toBe("$(sparkles) Autocomplete: Off")
		expect(item.backgroundColor).toBeUndefined()
	})

	it("disposes the underlying item", () => {
		new AutocompleteStatusBar(serviceWith(true)).dispose()

		expect(item.dispose).toHaveBeenCalledTimes(1)
	})
})
