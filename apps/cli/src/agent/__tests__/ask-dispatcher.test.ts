import { AskDispatcher } from "../ask-dispatcher.js"
import { OutputManager } from "../output-manager.js"
import { PromptManager } from "../prompt-manager.js"

describe("command approval display", () => {
	afterEach(() => vi.restoreAllMocks())

	it.each([
		["echo \u{e0001}", '"echo \\udb40\\udc01"'],
		["echo hello", '"echo hello"'],
		["echo 危険", '"echo 危険"'],
		["echo dangerous\r\x1b[2Kecho safe", '"echo dangerous\\r\\u001b[2Kecho safe"'],
		["echo a\n\t\b\x00\x07", '"echo a\\n\\t\\b\\u0000\\u0007"'],
		["echo a\x7f\x9b2K\x9dtitle\x9c", '"echo a\\u007f\\u009b2K\\u009dtitle\\u009c"'],
		["echo \u202eevil\u2066\u200b\u2028\u2029", '"echo \\u202eevil\\u2066\\u200b\\u2028\\u2029"'],
		[String.raw`echo "\n"`, String.raw`"echo \"\\n\""`],
		["", "(no command specified)"],
	])("renders command %j visibly without changing its stored text", async (command, expected) => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
		const outputManager = new OutputManager()
		const markDisplayed = vi.spyOn(outputManager, "markDisplayed")
		const promptManager = new PromptManager()
		const prompt = vi.spyOn(promptManager, "promptForYesNo").mockResolvedValue(true)
		const sendMessage = vi.fn()
		const dispatcher = new AskDispatcher({ outputManager, promptManager, sendMessage })

		const result = await dispatcher.handleAsk({ ts: 1, type: "ask", ask: "command", text: command })

		expect(stdout.mock.calls.map(([text]) => text).join("")).toBe(`\n[command request]\n  Command: ${expected}\n`)
		expect(markDisplayed).toHaveBeenCalledWith(1, command, false)
		expect(prompt).toHaveBeenCalledWith("Execute this command? (y/n): ")
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "askResponse", askResponse: "yesButtonClicked" })
		expect(result).toEqual({ handled: true, response: "yesButtonClicked" })
	})
})
