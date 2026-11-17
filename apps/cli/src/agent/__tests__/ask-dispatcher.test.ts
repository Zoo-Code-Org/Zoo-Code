import { PassThrough } from "stream"
import type { ClineAsk } from "@roo-code/types"
import { AskDispatcher } from "../ask-dispatcher.js"
import { toDisplayText } from "@/lib/utils/display-text.js"
import { OutputManager } from "../output-manager.js"
import { PromptManager } from "../prompt-manager.js"

describe("command approval display", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it.each([
		["echo \u{e0001}", '"echo \\udb40\\udc01"'],
		["./safe\u034f", '"./safe\\u034f"'],
		["echo a\u00a0b\u3000c", '"echo a\\u00a0b\\u3000c"'],
		["./safe\u2800--dry-run", '"./safe\\u2800--dry-run"'],
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
	// Allowlist: letters, marks, numbers, punctuation, symbols and U+0020. Unassigned and private-use
	// chars draw as one glyph. Default-ignorable chars and space lookalikes such as U+00A0 and U+2800 are not allowed.
	it("leaves only visible characters raw for every code point", () => {
		const visible = /^(?!\p{Default_Ignorable_Code_Point}|\u2800)[\p{L}\p{M}\p{N}\p{P}\p{S} \p{Cn}\p{Co}]$/u
		const leaks: string[] = []
		for (let cp = 0; cp <= 0x10ffff; cp++) {
			if (cp >= 0xd800 && cp <= 0xdfff) continue // JSON.stringify escapes lone surrogates
			const shown = toDisplayText(String.fromCodePoint(cp)).slice(1, -1)
			if (!shown.startsWith("\\") && !visible.test(shown)) leaks.push(cp.toString(16))
		}
		expect(leaks).toEqual([])
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

	const protectedHead = `\n[Tool Request] ${shown} [PROTECTED CONFIGURATION FILE]\n⚠️  WARNING: This tool wants to modify a protected configuration file.\n    Protected files include .rooignore, .roo/*, and other sensitive config files.\n`
	const longText = "x".repeat(201)
	const longJson = { v: "y".repeat(200) }
	it.each([
		["protected tool", { tool: evil, isProtected: true, path: "p" }, `${protectedHead}  "path": "p"\n`],
		["missing tool name", { path: "p" }, `\n[Tool Request] "unknown"\n  "path": "p"\n`],
		[
			"non-string values",
			{ tool: "t", n: 5, o: { a: 1 } },
			String.raw`${"\n"}[Tool Request] "t"${"\n"}  "n": "5"${"\n"}  "o": "{\"a\":1}"${"\n"}`,
		],
		[
			"long values",
			{ tool: "t", s: longText, j: longJson },
			`\n[Tool Request] "t"\n  "s": "${"x".repeat(200)}..."\n  "j": "${JSON.stringify(longJson).slice(0, 200).replaceAll('"', '\\"')}..."\n`,
		],
		["exact 200 chars", { tool: "t", s: "x".repeat(200) }, `\n[Tool Request] "t"\n  "s": "${"x".repeat(200)}"\n`],
	])("renders tool request: %s", async (_name, tool, expected) => {
		const { printed } = await run("tool", JSON.stringify(tool))

		expect(printed).toBe(expected)
	})

	it("prints Unknown error for an empty api error", async () => {
		const { printed } = await run("api_req_failed", "")

		expect(printed).toBe(`\n[api request failed]\n  Error: Unknown error\n`)
	})

	it.each([
		[
			"timeout",
			(m: PromptManager) =>
				vi.spyOn(m, "promptWithTimeout").mockResolvedValue({ value: "", timedOut: true, cancelled: false }),
			true,
		],
		[
			"rejected input",
			(m: PromptManager) => vi.spyOn(m, "promptForInput").mockRejectedValue(new Error("closed")),
			false,
		],
	])("prints (empty) for a followup default on %s", async (_name, arrange, nonInteractive) => {
		const { printed } = await run("followup", JSON.stringify({ question: "q" }), arrange, nonInteractive)

		expect(printed).toBe(`\n[question] "q"\n[Using default: (empty)]\n`)
	})

	// Review 2 finding 1 (PR 2473). Sinks of CommandApprovalDisplay.tla: unknownNonInteractive, promptTimeout, apiErrorStderr.
	it("escapes text of an unknown ask in non-interactive mode", async () => {
		const { printed } = await run("unknown_ask", evil, () => {}, true)

		expect(printed).toBe(`\n[unknown_ask] ${shown}\n`)
	})

	it.each([
		["model text", evil, shown],
		["empty default", "", "(empty)"],
	])("shows the %s when a prompt times out", async (_name, defaultValue, expected) => {
		vi.useFakeTimers()
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true)
		const prompt = new PromptManager({
			// The prompt uses only on/off/resume/pause/isRaw, which PassThrough provides.
			stdin: new PassThrough() as unknown as NodeJS.ReadStream,
			stdout: process.stdout,
		})
		const pending = prompt.promptWithTimeout("? ", 10, defaultValue)
		await vi.advanceTimersByTimeAsync(10)
		await pending

		expect(stdout.mock.calls.map(([c]) => String(c)).join("")).toContain(`[Timeout - using default: ${expected}]\n`)
	})

	it.each([
		["model text", evil, shown],
		["empty text", "", "Unknown error"],
	])("writes the api error to stderr when exitOnError is set: %s", async (_name, text, expected) => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true)
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit")
		}) as () => never)
		const dispatcher = new AskDispatcher({
			outputManager: new OutputManager(),
			promptManager: new PromptManager(),
			sendMessage: vi.fn(),
			exitOnError: true,
		})

		const result = await dispatcher.handleAsk({ ts: 1, type: "ask", ask: "api_req_failed", text })

		expect(result.error?.message).toBe("exit")
		expect(error).toHaveBeenCalledExactlyOnceWith(`[CLI] API request failed: ${expected}`)
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
