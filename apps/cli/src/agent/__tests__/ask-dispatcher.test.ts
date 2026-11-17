import type { ClineAsk } from "@roo-code/types"
import { AskDispatcher } from "../ask-dispatcher.js"
import { OutputManager } from "../output-manager.js"
import { PromptManager } from "../prompt-manager.js"

describe("command approval display", () => {
	afterEach(() => vi.restoreAllMocks())

	it.each([
		["echo \u{e0001}", '"echo \\udb40\\udc01"'],
		["./safe\u034f", '"./safe\\u034f"'],
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

	it.each([
		["denied", (m: PromptManager) => vi.spyOn(m, "promptForYesNo").mockResolvedValue(false), []],
		[
			"rejected",
			(m: PromptManager) => vi.spyOn(m, "promptForYesNo").mockRejectedValue(new Error("closed")),
			["[Defaulting to: no]\n"],
		],
	])("sends no when the prompt is %s", async (_name, arrange, extra) => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
		const promptManager = new PromptManager()
		arrange(promptManager)
		const sendMessage = vi.fn()
		const dispatcher = new AskDispatcher({ outputManager: new OutputManager(), promptManager, sendMessage })

		const result = await dispatcher.handleAsk({ ts: 1, type: "ask", ask: "command", text: "echo \x1b[2K" })

		expect(stdout.mock.calls.map(([text]) => text).join("")).toBe(
			`\n[command request]\n  Command: "echo \\u001b[2K"\n${extra.join("")}`,
		)
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "askResponse", askResponse: "noButtonClicked" })
		expect(result).toEqual({ handled: true, response: "noButtonClicked" })
	})

	// Invariant of docs/architecture/tla/CommandApprovalDisplay.tla: NoRawUnsafeChar.
	it("never prints a raw control, format or line-break character", async () => {
		const pool = [
			"a",
			" ",
			"\\",
			'"',
			"\n",
			"\r",
			"\x1b",
			"\x7f",
			"\x9b",
			"\u200b",
			"\u202e",
			"\u2028",
			"\u{e0001}",
			"危",
		]
		let seed = 1
		const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
		for (let run = 0; run < 200; run++) {
			const command = Array.from({ length: next() % 8 }, () => pool[next() % pool.length]).join("")
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
			const promptManager = new PromptManager()
			vi.spyOn(promptManager, "promptForYesNo").mockResolvedValue(true)
			const dispatcher = new AskDispatcher({
				outputManager: new OutputManager(),
				promptManager,
				sendMessage: vi.fn(),
			})

			await dispatcher.handleAsk({ ts: 1, type: "ask", ask: "command", text: command })

			const line = stdout.mock.calls
				.map(([text]) => text)
				.join("")
				.split("\n[command request]\n")[1]
			expect(line?.slice(0, -1)).not.toMatch(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u)
			stdout.mockRestore()
		}
	})

	const evil = "x\x1b[2K\r\x9b\u202e\u2028\u034f"
	const shown = String.raw`"x\u001b[2K\r\u009b\u202e\u2028\u034f"`
	const yes = { type: "askResponse", askResponse: "yesButtonClicked" }
	const answered = { handled: true, response: "messageResponse" }
	const approved = { handled: true, response: "yesButtonClicked" }

	async function run(
		ask: string,
		text: string,
		arrange: (promptManager: PromptManager) => void = () => {},
		nonInteractive = false,
	) {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
		const promptManager = new PromptManager()
		vi.spyOn(promptManager, "promptForYesNo").mockResolvedValue(true)
		arrange(promptManager)
		const sendMessage = vi.fn()
		const dispatcher = new AskDispatcher({
			outputManager: new OutputManager(),
			promptManager,
			sendMessage,
			nonInteractive,
		})
		const result = await dispatcher.handleAsk({ ts: 1, type: "ask", ask: ask as ClineAsk, text })
		return { printed: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""), sendMessage, result }
	}

	it.each([
		["tool", JSON.stringify({ tool: evil, [evil]: evil }), `\n[Tool Request] ${shown}\n  ${shown}: ${shown}\n`],
		[
			"use_mcp_server",
			JSON.stringify({ type: "use_mcp_tool", server_name: evil, tool_name: evil }),
			`\n[mcp request]\n  Server: ${shown}\n  Tool: ${shown}\n`,
		],
		[
			"use_mcp_server",
			JSON.stringify({ type: "access_mcp_resource", server_name: evil, uri: evil }),
			`\n[mcp request]\n  Server: ${shown}\n  Resource: ${shown}\n`,
		],
		["api_req_failed", evil, `\n[api request failed]\n  Error: ${shown}\n`],
		["mistake_limit_reached", evil, `\n[mistake limit reached]\n  Details: ${shown}\n`],
		["auto_approval_max_req_reached", evil, `\n[auto-approval limit reached]\n  Details: ${shown}\n`],
		["resume_task", evil, `\n[Resume Task]\n  ${shown}\n`],
		["unknown_ask", evil, `\n[unknown_ask]\n  ${shown}\n`],
	])("escapes untrusted text of ask %s", async (ask, text, expected) => {
		const { printed, sendMessage, result } = await run(ask, text)

		expect(printed).toBe(expected)
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(yes)
		expect(result).toEqual(approved)
	})

	const suggestions = JSON.stringify({ question: evil, suggest: [{ answer: evil, mode: evil }] })
	const listing = `\n[question] ${shown}\n\nSuggested answers:\n  1. ${shown} (mode: ${shown})\n\n`
	it.each([
		[
			"typed answer",
			evil,
			(m: PromptManager) => vi.spyOn(m, "promptForInput").mockResolvedValue(evil),
			false,
			"",
			evil,
		],
		[
			"selected number",
			suggestions,
			(m: PromptManager) => vi.spyOn(m, "promptForInput").mockResolvedValue("1"),
			false,
			`Selected: ${shown}\n`,
			evil,
		],
		[
			"rejected input",
			suggestions,
			(m: PromptManager) => vi.spyOn(m, "promptForInput").mockRejectedValue(new Error("closed")),
			false,
			`[Using default: ${shown}]\n`,
			evil,
		],
		[
			"timeout",
			suggestions,
			(m: PromptManager) =>
				vi.spyOn(m, "promptWithTimeout").mockResolvedValue({ value: evil, timedOut: true, cancelled: false }),
			true,
			`[Using default: ${shown}]\n`,
			evil,
		],
		[
			"cancellation",
			suggestions,
			(m: PromptManager) =>
				vi.spyOn(m, "promptWithTimeout").mockResolvedValue({ value: evil, timedOut: false, cancelled: true }),
			true,
			`[Using default: ${shown}]\n`,
			evil,
		],
	])("escapes followup text on %s", async (name, text, arrange, nonInteractive, tail, answer) => {
		const { printed, sendMessage, result } = await run("followup", text, arrange, nonInteractive)

		const head = name === "typed answer" ? `\n[question] ${shown}\n` : listing
		expect(printed).toBe(head + tail)
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
			type: "askResponse",
			askResponse: "messageResponse",
			text: answer,
		})
		expect(result).toEqual(answered)
	})
})
