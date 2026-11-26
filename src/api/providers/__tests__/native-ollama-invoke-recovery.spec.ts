// pnpm exec vitest run api/providers/__tests__/native-ollama-invoke-recovery.spec.ts

import { NativeOllamaHandler } from "../native-ollama"
import { ApiHandlerOptions } from "../../../shared/api"

import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { clearAllMocks } from "../../../test-utils/reset"
import { collectStream } from "../../../test-utils/stream"

// Mock the ollama package (same harness as native-ollama.spec.ts)
const mockChat = vitest.fn()
const mockIsProxyEnabled = vi.hoisted(() => vitest.fn(() => false))
vitest.mock("../../../utils/networkProxy", () => ({ isProxyEnabled: mockIsProxyEnabled }))

const mockedOllama = vi.hoisted(() => ({
	OllamaMock: vitest.fn(),
}))

vitest.mock("ollama", () => {
	const { OllamaMock } = mockedOllama
	return {
		Ollama: OllamaMock.mockImplementation(function () {
			return {
				chat: mockChat,
				abort: vitest.fn(),
			}
		}),
		Message: vitest.fn(),
	}
})

vitest.mock("../fetchers/ollama", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import("../fetchers/ollama")
	return {
		...actual,
		getOllamaModels: vitest.fn(),
	}
})

import { getOllamaModels } from "../fetchers/ollama"
const mockGetOllamaModels = vitest.mocked(getOllamaModels)

const writeFileTool = {
	type: "function",
	function: {
		name: "write_to_file",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
} as const

const readFileTool = {
	type: "function",
	function: {
		name: "read_file",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
} as const

const weatherTool = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Get the weather",
		parameters: {
			type: "object",
			properties: { location: { type: "string" } },
			required: ["location"],
		},
	},
} as const

const makeHandler = (overrides: Partial<ApiHandlerOptions> = {}) =>
	new NativeOllamaHandler({
		apiModelId: "llama2",
		ollamaModelId: "llama2",
		ollamaBaseUrl: "http://localhost:11434",
		...overrides,
	})

const wrappedWeatherCall = (location: string) =>
	`<function_calls><invoke name="get_weather"><parameter name="location">${location}</parameter></invoke></function_calls>`

const run = async (...chunks: Array<Record<string, unknown>>) => {
	const handler = makeHandler()
	mockChat.mockImplementation(async function* () {
		for (const chunk of chunks) {
			yield chunk
		}
	})
	const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }], {
		...makeCreateMessageMetadata(),
		tools: [weatherTool, writeFileTool, readFileTool],
	})
	return collectStream(stream)
}

const callsOf = (parts: Array<{ type: string }>) =>
	parts.filter(
		(part): part is { type: "tool_call_partial"; index: number; id: string; name: string; arguments: string } =>
			part.type === "tool_call_partial",
	)

const textOf = (parts: Array<{ type: string }>) =>
	parts
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")

describe("NativeOllamaHandler pseudo tool-call recovery", () => {
	beforeEach(() => {
		clearAllMocks()
		mockGetOllamaModels.mockResolvedValue({
			llama2: {
				contextWindow: 4096,
				maxTokens: 4096,
				supportsImages: false,
				supportsPromptCache: false,
			},
		})
	})

	it("recovers a wrapped invoke block split across chunk boundaries", async () => {
		const parts = await run(
			{ message: { content: "Running now <function_calls><inv" } },
			{ message: { content: 'oke name="get_weather">' } },
			{
				message: {
					content: '<parameter name="location">Berlin</parameter></invoke></function_calls>\ndone',
				},
			},
		)

		expect(callsOf(parts)).toStrictEqual([
			{
				type: "tool_call_partial",
				index: 0,
				id: "ollama-tool-0",
				name: "get_weather",
				arguments: '{"location":"Berlin"}',
			},
		])
		expect(textOf(parts)).toBe("Running now \ndone")
		// The recovered call is a tracked call: it gets its end event.
		expect(parts.filter((part) => part.type === "tool_call_end")).toStrictEqual([
			{ type: "tool_call_end", id: "ollama-tool-0" },
		])
	})

	it("recovers a call written before a native call that arrives after it", async () => {
		// The finding's exact scenario: the model writes a pseudo
		// write_to_file first and a native read_file second. The recovered
		// call emits at its block close, before the later native arrival.
		const parts = await run(
			{
				message: {
					content:
						'<function_calls><invoke name="write_to_file"><parameter name="path">prova.txt</parameter><parameter name="content">test</parameter></invoke></function_calls>',
				},
			},
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "read_file", arguments: { path: "prova.txt" } } }],
				},
			},
		)

		const calls = callsOf(parts)
		expect(calls.map((call) => [call.index, call.name, call.arguments])).toStrictEqual([
			[0, "write_to_file", JSON.stringify({ path: "prova.txt", content: "test" })],
			[1, "read_file", JSON.stringify({ path: "prova.txt" })],
		])
	})

	it("keeps a native call first when its chunk arrives before the pseudo call", async () => {
		const parts = await run(
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Paris" } } }],
				},
			},
			{ message: { content: wrappedWeatherCall("Berlin") } },
		)

		const calls = callsOf(parts)
		expect(calls.map((call) => [call.index, call.arguments])).toStrictEqual([
			[0, JSON.stringify({ location: "Paris" })],
			[1, JSON.stringify({ location: "Berlin" })],
		])
	})

	it("runs a native call that arrives inside an open block before that block's call", async () => {
		// The block completes across the native arrival, so the native
		// resolves first: the sink order is resolution order.
		const parts = await run(
			{ message: { content: '<function_calls><invoke name="get_weather">' } },
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Paris" } } }],
				},
			},
			{
				message: { content: '<parameter name="location">Berlin</parameter></invoke></function_calls>' },
			},
		)

		const calls = callsOf(parts)
		expect(calls.map((call) => [call.index, call.arguments])).toStrictEqual([
			[0, JSON.stringify({ location: "Paris" })],
			[1, JSON.stringify({ location: "Berlin" })],
		])
	})

	it("keeps native order when a marker hold drains between two natives", async () => {
		// A partial marker fragment holds text, a native arrives, the
		// fragment resolves as prose, a second native arrives. Both
		// natives keep their arrival order and unique indices.
		const parts = await run(
			{ message: { content: "<in" } },
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Paris" } } }],
				},
			},
			{ message: { content: "valid prose" } },
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Berlin" } } }],
				},
			},
		)

		const calls = callsOf(parts)
		expect(calls.map((call) => [call.index, call.arguments])).toStrictEqual([
			[0, JSON.stringify({ location: "Paris" })],
			[1, JSON.stringify({ location: "Berlin" })],
		])
		expect(textOf(parts)).toBe("<invalid prose")
	})

	it("keeps written order across a drained hold, a recovered call, and a later native", async () => {
		const parts = await run(
			{ message: { content: "<in" } },
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Paris" } } }],
				},
			},
			{
				message: {
					content: `valid prose${wrappedWeatherCall("Berlin")}`,
				},
			},
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Rome" } } }],
				},
			},
		)

		const calls = callsOf(parts)
		expect(calls.map((call) => call.arguments)).toStrictEqual([
			JSON.stringify({ location: "Paris" }),
			JSON.stringify({ location: "Berlin" }),
			JSON.stringify({ location: "Rome" }),
		])
	})

	it("keeps a backtick-fence-quoted invoke block as text", async () => {
		const quoted = wrappedWeatherCall("Berlin")
		const parts = await run(
			{ message: { content: "Example:\n```text\n" } },
			{ message: { content: quoted } },
			{ message: { content: "\n```\nDone" } },
		)

		expect(callsOf(parts)).toStrictEqual([])
		expect(textOf(parts)).toBe(`Example:\n\`\`\`text\n${quoted}\n\`\`\`\nDone`)
	})

	it("keeps a tilde-fence-quoted invoke block as text", async () => {
		const quoted = '<invoke name="get_weather"><parameter name="location">Berlin</parameter></invoke>'
		const parts = await run(
			{ message: { content: "~~~\n" } },
			{ message: { content: quoted } },
			{ message: { content: "\n~~~" } },
		)

		expect(callsOf(parts)).toStrictEqual([])
		expect(textOf(parts)).toBe(`~~~\n${quoted}\n~~~`)
	})

	it("keeps streaming prose live while tools are offered", async () => {
		const handler = makeHandler()
		let releaseSecondChunk!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseSecondChunk = resolve
		})
		mockChat.mockImplementation(async function* () {
			yield { message: { content: "Hello " } }
			await gate
			yield { message: { content: "world" } }
		})

		const iterator = handler
			.createMessage("System", [{ role: "user" as const, content: "Hi" }], {
				...makeCreateMessageMetadata(),
				tools: [weatherTool],
			})
			[Symbol.asyncIterator]()

		try {
			const first = await iterator.next()
			expect(first.value).toEqual({ type: "text", text: "Hello " })
			releaseSecondChunk()
			const second = await iterator.next()
			expect(second.value).toEqual({ type: "text", text: "world" })
		} finally {
			releaseSecondChunk()
			await iterator.return?.(undefined)
		}
	})

	it("flushes an unterminated block as text while keeping its native call", async () => {
		const parts = await run(
			{ message: { content: '<function_calls><invoke name="get_weather">' } },
			{
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Paris" } } }],
				},
			},
			{ message: { content: '<parameter name="location">Berlin</parameter>' } },
		)

		const calls = callsOf(parts)
		expect(calls.map((call) => [call.index, call.name, call.arguments])).toStrictEqual([
			[0, "get_weather", JSON.stringify({ location: "Paris" })],
		])
		expect(textOf(parts)).toBe(
			'<function_calls><invoke name="get_weather"><parameter name="location">Berlin</parameter>',
		)
	})

	it("stays byte-identical when no tools are offered", async () => {
		const handler = makeHandler()
		mockChat.mockImplementation(async function* () {
			yield { message: { content: wrappedWeatherCall("Berlin") } }
			yield {
				message: {
					content: "",
					tool_calls: [{ function: { name: "get_weather", arguments: { location: "Paris" } } }],
				},
			}
		})
		const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }], {
			...makeCreateMessageMetadata(),
		})
		const parts = await collectStream(stream)

		// Without offered tools nothing recovers: the markup stays text and
		// the native call keeps the legacy id/index sequence.
		expect(textOf(parts)).toBe(wrappedWeatherCall("Berlin"))
		expect(callsOf(parts)).toStrictEqual([
			{
				type: "tool_call_partial",
				index: 0,
				id: "ollama-tool-0",
				name: "get_weather",
				arguments: JSON.stringify({ location: "Paris" }),
			},
		])
	})
})
