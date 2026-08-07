import * as vscode from "vscode"

import { AutocompleteLogger } from "../AutocompleteLogger"

const appendLine = vi.fn()
const dispose = vi.fn()
const createOutputChannel = vi.fn(() => ({ appendLine, dispose }))

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		window: { createOutputChannel: (...args: unknown[]) => createOutputChannel(...(args as [])) },
	}
})

beforeEach(() => {
	vi.clearAllMocks()
})

describe("AutocompleteLogger", () => {
	it("writes nothing at all while debug logging is off", () => {
		const logger = new AutocompleteLogger(() => false)

		logger.log("triggered", { reason: "typing" })
		logger.logPrompt("prompt", "some text")

		// Not merely "no lines written" — the channel itself must never be created,
		// or every user gets a stray output panel they never asked for.
		expect(createOutputChannel).not.toHaveBeenCalled()
		expect(appendLine).not.toHaveBeenCalled()
	})

	it("creates the output channel lazily, and only once", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("first")
		logger.log("second")

		expect(createOutputChannel).toHaveBeenCalledTimes(1)
		expect(appendLine).toHaveBeenCalledTimes(2)
	})

	it("renders an event with no detail", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("cancelled")

		expect(appendLine).toHaveBeenCalledWith("[autocomplete] cancelled")
	})

	it("renders detail as key=value pairs", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("context", { snippets: 3, sources: "open-tabs" })

		expect(appendLine).toHaveBeenCalledWith('[autocomplete] context snippets=3 sources="open-tabs"')
	})

	it("quotes strings so an empty value stays visible", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("done", { text: "" })

		expect(appendLine).toHaveBeenCalledWith('[autocomplete] done text=""')
	})

	it("truncates a long string value", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("prompt", { body: "x".repeat(200) })

		const line = appendLine.mock.calls[0][0] as string

		expect(line).toContain("…")
		expect(line.length).toBeLessThan(200)
	})

	it("renders non-string values without quoting", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("state", { enabled: true, count: 0, missing: undefined })

		expect(appendLine).toHaveBeenCalledWith("[autocomplete] state enabled=true count=0 missing=undefined")
	})

	it("writes a prompt across delimited lines", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.logPrompt("rendered", "line one\nline two")

		expect(appendLine).toHaveBeenCalledTimes(3)
		expect(appendLine).toHaveBeenNthCalledWith(2, "line one\nline two")
	})

	it("disposes the channel and can be disposed again safely", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("open")
		logger.dispose()
		logger.dispose()

		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it("recreates the channel after disposal", () => {
		const logger = new AutocompleteLogger(() => true)

		logger.log("before")
		logger.dispose()
		logger.log("after")

		expect(createOutputChannel).toHaveBeenCalledTimes(2)
	})
})
